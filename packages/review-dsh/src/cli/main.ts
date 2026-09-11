/**
 * #26 CLI wrapper 主缝：参数透传 + 结果呈现 only（票面 AC4）。
 *
 * 本文件是胶水：解析（args.ts，已测——含 caseId 派生与旗标硬化）→ 环境凭据
 * 适配器 → 锁定版 review profile 组装（assemble.ts，内核已测）→ 单 MR 运行 →
 * 导出（audit-export.ts，已测）→ stdout 呈现（render.ts，已测）→ 退出码。
 * 检视行为本体全部留在进程内主缝上。
 *
 * 退出码契约（票面）：完成（含诚实截断——truncated 经 stdout 顶层呈现，是
 * POC1 record 语义的收敛标注而非失败）0 / 中止或错误 1。
 * 凭据经环境变量（DEEPSEEK_API_KEY / DEEPSEEK_URL），适配器构造期 fail fast，
 * 错误消息不回显 key 值。
 *
 * 进程调用形态：review-agent review --repo <path> --mr <diff-file>
 *   [--config A-E] [--issue <text>] [--out <dir>]
 */

import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Context } from "@deepseek-ai/cordis";

import { writeAuditFile } from "../../../../src/audit/audit-writer.js";
import { toAuditFileContent } from "../audit/audit-export.js";
import { DeepSeekLlmAdapter } from "../llm/deepseek-adapter.js";
import { assembleReviewProfile, realApiReviewPolicy } from "../profile/assemble.js";
import { exitGracefully } from "../process/graceful-exit.js";
import { parseReviewArgs, USAGE_TEXT, type ReviewCliArgs } from "./args.js";
import { renderReviewOutcome } from "./render.js";

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
      policy: realApiReviewPolicy(args.config),
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

function main(): void {
  const parsed = parseReviewArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`review-agent: ${parsed.message}\n${USAGE_TEXT}\n`, () => exitGracefully(1));
    return;
  }
  runReviewCommand(parsed.args)
    .then((code) => exitGracefully(code))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`review-agent: ${message}\n`, () => exitGracefully(1));
    });
}

main();
