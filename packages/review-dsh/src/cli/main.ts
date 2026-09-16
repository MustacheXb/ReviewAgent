/**
 * #26/#46 CLI wrapper 主缝：子命令分发 + 参数透传 + 结果呈现 only（票面 AC4）。
 *
 * 本文件是胶水：解析（args.ts，已测——含 caseId 派生与旗标硬化）→ .env.local
 * 装载（#46，与实验 CLI 同语义）→ 命令执行 → stdout/stderr 呈现 → 退出码。
 * 检视行为本体全部留在进程内主缝上。
 *
 * 命令面（#46 起双子命令）：
 * - review：环境凭据适配器 → 锁定版 review profile 组装（assemble.ts，内核
 *   已测）→ 单 MR 运行 → 导出（audit-export.ts，已测）→ stdout 呈现
 *   （render.ts，已测）；
 * - smoke：网关冒烟自检（smoke.ts，已测）→ stdout 人话报告。
 *
 * 退出码契约（票面）：review 完成（含诚实截断——truncated 经 stdout 顶层
 * 呈现，是 POC1 record 语义的收敛标注而非失败）0 / 中止或错误 1；smoke 按
 * 诊断结论给码（通过 0 / 任何失败诊断 1）。
 *
 * .env.local（#46）：进程 cwd 的 .env.local 自动装载（resolve(".env.local")，
 * 与实验 CLI 同语义：不覆盖已有非空环境变量；摘要只报键名与行号，值绝不
 * 回显），必须在凭据解析前完成；摘要走 stderr——review 命令的 stdout 契约
 * 是单个 JSON 文档。凭据经 reviewer 角色环境变量（REVIEWER_API_KEY /
 * REVIEWER_URL，别名 DEEPSEEK_API_KEY / DEEPSEEK_URL），适配器构造期
 * fail fast，错误消息不回显 key 值。model 是实验数据（#45）：经 --model
 * 旗标下传（缺省 deepseek-v4-flash），无 model 环境变量。
 *
 * 进程调用形态：review-agent review --repo <path> --mr <diff-file>
 *   [--config A-E] [--issue <text>] [--out <dir>] [--model <id>]
 *   review-agent smoke [--model <id>]
 */

import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Context } from "@deepseek-ai/cordis";

import { writeAuditFile } from "../../../../src/audit/audit-writer.js";
import type { EnvLocalLoadResult } from "../../../../src/shared/env-local.js";
import { formatEnvLocalSummary, loadEnvLocalFile } from "../../../../src/shared/env-local.js";
import { toAuditFileContent } from "../audit/audit-export.js";
import { DeepSeekLlmAdapter } from "../llm/deepseek-adapter.js";
import { assembleReviewProfile, realApiReviewPolicy } from "../profile/assemble.js";
import { exitGracefully } from "../process/graceful-exit.js";
import { parseCliArgs, USAGE_TEXT, type ReviewCliArgs, type SmokeCliArgs } from "./args.js";
import { renderReviewOutcome } from "./render.js";
import { renderSmokeReport, runGatewaySmoke } from "./smoke.js";

/** 执行一次 review 命令；返回进程退出码（完成 0；任何错误经异常上抛 → 1） */
async function runReviewCommand(args: ReviewCliArgs): Promise<number> {
  // 环境前置先检（凭据 fail fast 在适配器构造期，早于文件系统触碰）
  const adapter = new DeepSeekLlmAdapter();

  const repoPath = resolve(args.repo);
  if (!(await stat(repoPath)).isDirectory()) {
    throw new Error(`--repo is not a directory: ${repoPath}`);
  }
  const diff = await readFile(resolve(args.mr), "utf8");

  const outDir = resolve(args.out);
  await mkdir(join(outDir, "sessions"), { recursive: true });
  const sessionRoot = await mkdtemp(join(outDir, "sessions", "run-"));

  const ctx = new Context();
  try {
    const handle = await assembleReviewProfile(ctx, {
      sessionRoot,
      adapter,
      policy: realApiReviewPolicy(args.config, args.model),
    });
    const result = await ctx.reviewRuntime.run({
      caseId: args.caseId,
      issueDescription: args.issue,
      diff,
      repoPath,
    });

    const content = toAuditFileContent(result);
    const auditPath = await writeAuditFile(join(outDir, "audit"), content);
    await new Promise<void>((flush) => process.stdout.write(renderReviewOutcome({
      caseId: content.caseId,
      configId: content.configId,
      runId: content.runId,
      truncated: content.truncated,
      rounds: content.rounds,
      toolCalls: content.toolCalls,
      findings: content.findings,
      auditPath,
    }), () => flush()));
    // cmdline 行请求的退出码（若曾请求——本 wrapper 不注入 cmdline 参数，正常
    // 为 null）优先；正常完成 = 0
    return handle.requestedExitCode() ?? 0;
  } finally {
    // 半挂树同样拆（组装失败时 mount helper 的同款清理语义）
    await ctx.fiber.dispose();
  }
}

/** 执行一次 smoke 命令（#46）：双探针 → stdout 人话报告；通过 0 / 失败诊断 1 */
async function runSmokeCommand(args: SmokeCliArgs): Promise<number> {
  const verdict = await runGatewaySmoke({ model: args.model });
  await new Promise<void>((flush) => process.stdout.write(renderSmokeReport(verdict), () => flush()));
  return verdict.kind === "pass" ? 0 : 1;
}

/** .env.local 装载摘要（stderr；措辞单源 formatEnvLocalSummary——与实验 CLI 同款，只报键名与行号，值绝不回显） */
function envLocalSummaryLine(result: EnvLocalLoadResult): string {
  return `review-agent: env: .env.local found — ${formatEnvLocalSummary(result)}`;
}

function main(): void {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`review-agent: ${parsed.message}\n${USAGE_TEXT}\n`, () => exitGracefully(1));
    return;
  }

  // .env.local（#46）：用法解析成功后才触碰文件系统；必须在凭据解析前。
  // 摘要走 stderr（review 的 stdout 契约 = 单个 JSON 文档；smoke 报告在 stdout）。
  // 读失败（非缺失，如 EACCES/EISDIR）→ 干净人话错误 + exit 1（与实验 CLI 的
  // 干净处理对齐，不留未捕获堆栈）。
  let envResult: EnvLocalLoadResult;
  try {
    envResult = loadEnvLocalFile(resolve(".env.local"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `review-agent: 无法读取 .env.local（${message}）——本机注入面中止\n`,
      () => exitGracefully(1),
    );
    return;
  }
  if (envResult.exists) {
    process.stderr.write(`${envLocalSummaryLine(envResult)}\n`);
  }

  const command = parsed.command === "smoke" ? runSmokeCommand(parsed.args) : runReviewCommand(parsed.args);
  command
    .then((code) => exitGracefully(code))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`review-agent: ${message}\n`, () => exitGracefully(1));
    });
}

main();
