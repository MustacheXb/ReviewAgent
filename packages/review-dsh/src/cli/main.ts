/**
 * #26/#46/#56 CLI wrapper 主缝：子命令分发 + 参数透传 + 结果呈现 only（票面 AC4）。
 *
 * 本文件是胶水：解析（args.ts，已测——含 caseId 派生与旗标硬化）→ .env.local
 * 装载（#46，与实验 CLI 同语义）→ 命令执行 → stdout/stderr 呈现 → 退出码。
 * 检视行为本体全部留在进程内主缝上。
 *
 * 命令面（#46 起双子命令）：
 * - review：环境凭据前置检查（适配器构造期 fail fast）→ #56 切分内建编排
 *   （orchestration.ts 适配 + orchestrateReview 分流：域内直通，字节与 #26
 *   原路径一致；超界切分串行、合并为单份结果；运行单元 profile-per-run，
 *   kernel-host 单元隔离同款）→ 按片审计落盘（audit-export.ts，已测）→
 *   stdout 呈现（render.ts，已测）。diff 不可解析（纯重命名 / 二进制块等）
 *   无法判定边界 → 退回 #26 原路径直通（旧 CLI 从不解析 diff，该输入集的
 *   域内 MR 必须保真——绝不比旧行为差）；
 * - smoke：网关冒烟自检（smoke.ts，已测）→ stdout 人话报告。
 *
 * 退出码契约（#56 三态）：review 完成（含诚实截断、超界切分与超界单片执行；
 * 不可解析 diff 的直通同此）0 / 分片数超限拒绝 2（人话错误含所需片数与上限
 * ——与运行失败可区分，平台侧可据此提示拆 MR）/ 其余中止或错误 1；smoke 按
 * 诊断结论给码（通过 0 / 任何失败诊断 1）。
 *
 * .env.local（#46）：进程 cwd 的 .env.local 自动装载（resolve(".env.local")，
 * 与实验 CLI 同语义：不覆盖已有非空环境变量；摘要只报键名与行号，值绝不
 * 回显），必须在凭据解析前完成；摘要走 stderr——review 命令的 stdout 契约
 * 是单个 JSON 文档。凭据经 reviewer 角色环境变量（REVIEWER_API_KEY /
 * REVIEWER_URL，别名 DEEPSEEK_API_KEY / DEEPSEEK_URL），适配器构造期
 * fail fast，错误消息不回显 key 值。model 是实验数据（#45）：经 --model
 * 旗标下传（缺省 deepseek-v4-flash），无 model 环境变量。outputLanguage（#58）：
 * 经 --language 旗标下传（缺省 en；zh 切换 Zone A 分序列与语言门档位），无
 * language 环境变量。
 *
 * 进程调用形态：review-agent review --repo <path> --mr <diff-file>
 *   [--config A-E] [--issue <text>] [--out <dir>] [--model <id>] [--language en|zh]
 *   review-agent smoke [--model <id>]
 */

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { type DatasetError } from "../../../../src/dataset/diff/types.js";
import type { MergedFinding } from "../../../../src/sharding/merge-findings.js";
import { orchestrateReview } from "../../../../src/sharding/orchestrate-review.js";
import type { EnvLocalLoadResult } from "../../../../src/shared/env-local.js";
import { formatEnvLocalSummary, loadEnvLocalFile } from "../../../../src/shared/env-local.js";
import { DeepSeekLlmAdapter } from "../llm/deepseek-adapter.js";
import { exitGracefully } from "../process/graceful-exit.js";
import { parseCliArgs, USAGE_TEXT, type ReviewCliArgs, type SmokeCliArgs } from "./args.js";
import { cliMrCase, dshSingleMrRunner, type ProductionMrRun } from "./orchestration.js";
import { renderReviewOutcome, renderShardedReviewOutcome } from "./render.js";
import { renderSmokeReport, runGatewaySmoke } from "./smoke.js";

/** #56 分片数超限拒绝的专用退出码（与运行失败 1 可区分） */
const EXIT_SHARD_LIMIT_REJECTED = 2;

/** 凭据前置检查：适配器构造期 fail fast（实例即弃——运行单元每片自建适配器，wire 字节捕获按片私有） */
function assertReviewerCredentials(): void {
  new DeepSeekLlmAdapter();
}

/** 域内直通呈现：单次运行原样输出（字段取自导出审计，与 #26 路径同源同序） */
async function presentDirectRun(run: ProductionMrRun): Promise<number> {
  await writeStdout(
    renderReviewOutcome({
      caseId: run.content.caseId,
      configId: run.content.configId,
      runId: run.content.runId,
      truncated: run.content.truncated,
      rounds: run.content.rounds,
      toolCalls: run.content.toolCalls,
      findings: run.content.findings,
      auditPath: run.auditPath,
    }),
  );
  // cmdline 行请求的退出码（若曾请求——本 wrapper 不注入 cmdline 参数，正常
  // 为 null）优先；正常完成 = 0
  return run.requestedExitCode ?? 0;
}

/** 编排层计划类拒绝（零运行成本）三分：超限人话拒绝 / 不可解析退回原路径 / 其余异常 */
async function presentOrchestrationRejection(
  error: DatasetError,
  mrCase: ReturnType<typeof cliMrCase>,
  runner: ReturnType<typeof dshSingleMrRunner>,
): Promise<number> {
  if (error.code === "SHARD_LIMIT_EXCEEDED") {
    // 分片数超限 = 定义结局而非异常（同 smoke 的 verdict 路径先例）：stderr
    // 人话错误（含所需片数与上限）+ 专用退出码 2，与运行失败（异常 → 1）可区分
    process.stderr.write(
      `review-agent: 拒绝检视——${error.message}；请主动拆分 MR 后再提交检视\n`,
    );
    return EXIT_SHARD_LIMIT_REJECTED;
  }
  if (error.code === "MALFORMED_DIFF") {
    // 不可解析 diff（纯重命名 / 二进制块等）无法判定边界 → 退回 #26 原路径
    // 直通：旧 CLI 从不解析 diff，该输入集的域内 MR 必须保真（AC1 回归锁），
    // 绝不比旧行为差
    return presentDirectRun(await runner.run(mrCase));
  }
  // 其余计划错误（配置非法等）按异常路径上抛（→ 1）
  throw new Error(error.message);
}

/** 执行一次 review 命令；返回进程退出码（完成 0 / 分片超限拒绝 2；其余错误经异常上抛 → 1） */
async function runReviewCommand(args: ReviewCliArgs): Promise<number> {
  // 环境前置先检（凭据 fail fast 在适配器构造期，早于文件系统触碰——分片超限
  // 拒绝同样先过凭据关）
  assertReviewerCredentials();

  const repoPath = resolve(args.repo);
  if (!(await stat(repoPath)).isDirectory()) {
    throw new Error(`--repo is not a directory: ${repoPath}`);
  }
  const diff = await readFile(resolve(args.mr), "utf8");

  const outDir = resolve(args.out);

  // #56 切分内建：同一编排函数分流（决策 2 / 18）——域内直通（呈现与审计
  // 写盘与 #26 原路径逐字节一致）；超界切分串行、每片独立审计（runId 命名
  // 文件）、findings 按锚点键合并为单份结果。运行单元 profile-per-run
  // （kernel-host 单元隔离同款），sessions / audit 目录由运行器按片创建。
  const mrCase = cliMrCase(args, repoPath, diff);
  const runner = dshSingleMrRunner({ config: args.config, model: args.model, language: args.language, outDir });
  const orchestrated = await orchestrateReview(mrCase, runner);
  if (!orchestrated.ok) {
    return presentOrchestrationRejection(orchestrated.error, mrCase, runner);
  }
  const { sharded, findings, usage, runs, shards } = orchestrated.value;

  if (!sharded) {
    return presentDirectRun(runs[0]!);
  }

  // 超界合并呈现：跨片求和摘要（rounds / toolCalls / usage = 各片之和——
  // 决策 13 计量口径在呈现面落地；truncated 任一片截断即 true）+ shards 节
  // （每片 runId / auditPath 关联独立审计）+ 合并 findings（shardIds 溯源）。
  // sharded = true 时 shards 节必在场（直通分支已提前返回）。findings 收紧为
  // MergedFinding：切分产出经 merge-findings 构造必携带 shardIds（决策 11），
  // 编排接口以域内/切分共面的 Finding 承载，该不变式在此单点表达。
  await writeStdout(
    renderShardedReviewOutcome({
      caseId: args.caseId,
      configId: runs[0]!.content.configId,
      truncated: runs.some((run) => run.content.truncated),
      rounds: runs.reduce((sum, run) => sum + run.content.rounds, 0),
      toolCalls: runs.reduce((sum, run) => sum + run.content.toolCalls, 0),
      usage,
      findings: findings as readonly MergedFinding[],
      shards: shards!,
    }),
  );
  // cmdline 面未接入本 wrapper（恒无退出请求）：超界完成 = 0
  return 0;
}

/** stdout 整写（flush 后 resolve——退出前保证字节已落地） */
function writeStdout(text: string): Promise<void> {
  return new Promise<void>((flush) => process.stdout.write(text, () => flush()));
}

/** 执行一次 smoke 命令（#46）：双探针 → stdout 人话报告；通过 0 / 失败诊断 1 */
async function runSmokeCommand(args: SmokeCliArgs): Promise<number> {
  const verdict = await runGatewaySmoke({ model: args.model });
  await writeStdout(renderSmokeReport(verdict));
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
