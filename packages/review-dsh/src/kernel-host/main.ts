/**
 * #27 kernel host：SDK JSON-RPC wire（sdk-protocol transport）上的长驻内核进程。
 *
 * 实验面的进程边界：一个 host 进程服务整批检视单元（不为单元 spawn 进程），
 * 每单元一个 agent（review-runtime 驱动器 per-run createAgent，既有语义）。
 * 方法面 review/run + shutdown——不复用 dsh-sdk-jsonrpc-server 的
 * session/prompt 脸：那会为每个 sessionId 另建一个走自由 agent-loop 的 agent
 * （prompt 即用户消息、模型自行推进），与「策略驱动器代码级强制六阶段」
 * （ADR-0006）正面冲突；本 host 在 SDK 传输层上直接暴露检视服务调用面。
 *
 * 单元隔离：每请求全新运行单元（#61 第一步起与 CLI 共享 dshSingleMrRunner——
 * profile-per-run：reviewCache / 工具预算 / Ledger 均为请求私有，单元间零共享
 * 状态）；config 经请求参数逐单元切换（REVIEW_PRESETS 真源）。失败单元
 * 经错误帧回报（-32603），进程存活继续下一单元（实验运行器的失败隔离）。
 *
 * #61 超界编排（spec Q1–Q9）：review/run 套 orchestrateReview（与 CLI 同一
 * 编排函数——单一语义入口，双面零漂移）——域内直通形状零变化（实验面兼容）；
 * 超界切分串行合并（求和口径摘要 + shards 节，每片一帧 review/progress
 * 通知，仅切分执行时发）；分片数超限 → 专用错误帧 -32000 + error.data（经
 * Q9 接管的服务端分发产生，见 request-dispatch.ts——SDK transport 服务端无
 * 自定义错误帧路径）；不可解析 diff 退回直通（内核从不解析 diff，现状保真）。
 *
 * 凭据经 reviewer 角色环境变量（REVIEWER_API_KEY / REVIEWER_URL，别名
 * DEEPSEEK_API_KEY / DEEPSEEK_URL），适配器每请求构造期 fail fast；错误消息
 * 不回显 key 值。model 是实验数据（#45）：经 review/run 参数下传进 policy
 * （缺省回落 DEFAULT_MODEL），无 model 环境变量。outputLanguage（#58）：
 * 经 review/run 的 language 参数下传（缺省 en；zh 切换 Zone A 分序列与
 * 语言门档位），非法值错误帧、进程存活（与 CLI --language 旗标双通道同
 * 语义）。stdout 只承载 JSON-RPC 帧
 * （协议纯净性由部署保证——同 dsh-sdk-jsonrpc-server 约定），诊断不写 stdout。
 *
 * 进程调用形态：review-kernel-host（stdin/stdout = JSON-RPC；EOF / shutdown /
 * 信号均以 0 退出）。
 */

import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";

import type { ConfigId } from "../../../../src/contracts/config.js";
import type { MRCase } from "../../../../src/contracts/mr-case.js";
import { isOutputLanguage, type OutputLanguage } from "../../../../src/contracts/output-language.js";
import type { DatasetError } from "../../../../src/dataset/diff/types.js";
import { DEFAULT_ORCHESTRATION_CONFIG, orchestrateReview } from "../../../../src/sharding/orchestrate-review.js";
import { toPoc1RunResult } from "../audit/audit-export.js";
import { DeepSeekLlmAdapter } from "../llm/deepseek-adapter.js";
import { REVIEW_PRESETS } from "../presets/review-presets.js";
import { dshSingleMrRunner } from "../run-unit/single-mr-runner.js";
import { installHostRequestDispatch, ShardLimitRejection } from "./request-dispatch.js";
import { exitGracefully } from "../process/graceful-exit.js";

/** review/run 请求参数（进程边界契约；字段校验 fail fast） */
interface ReviewRunParams {
  readonly configId: ConfigId;
  readonly caseId: string;
  readonly issueDescription: string;
  readonly diff: string;
  readonly repoPath?: string;
  readonly auditDir: string;
  /** 被测模型（#45）：缺省回落 DEFAULT_MODEL；自由 id 透传（空串 fail fast） */
  readonly model?: string;
  /** 输出语言（#58）：缺省 en；en|zh 枚举（非法值 fail fast 错误帧） */
  readonly language?: OutputLanguage;
}

/** 必填非空字符串字段提取（缺场/空串/类型错误 = fail fast 错误帧） */
function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`review/run: "${key}" must be a non-empty string`);
  }
  return value;
}

/** review/run 参数校验：configId 对照 preset 注册表（A–E 矩阵真源） */
function parseReviewRunParams(params: Record<string, unknown>): ReviewRunParams {
  const configId = requireString(params, "configId");
  if (!(configId in REVIEW_PRESETS)) {
    throw new Error(`review/run: invalid configId ${JSON.stringify(configId)}: expected one of A, B, C, D, E`);
  }
  const repoPath = params.repoPath;
  if (repoPath !== undefined && typeof repoPath !== "string") {
    throw new Error(`review/run: "repoPath" must be a string when present`);
  }
  const issueDescription = params.issueDescription;
  if (issueDescription !== undefined && typeof issueDescription !== "string") {
    throw new Error(`review/run: "issueDescription" must be a string when present`);
  }
  const model = params.model;
  if (model !== undefined && (typeof model !== "string" || model.trim().length === 0)) {
    throw new Error(`review/run: "model" must be a non-empty string when present`);
  }
  const language = params.language;
  if (language !== undefined && !isOutputLanguage(language)) {
    throw new Error(`review/run: "language" must be "en" or "zh" when present (got ${JSON.stringify(language)})`);
  }
  return {
    configId: configId as ConfigId,
    caseId: requireString(params, "caseId"),
    issueDescription: issueDescription ?? "",
    diff: requireString(params, "diff"),
    ...(repoPath !== undefined ? { repoPath } : {}),
    auditDir: requireString(params, "auditDir"),
    ...(model !== undefined ? { model } : {}),
    ...(language !== undefined ? { language } : {}),
  };
}

/** review/run：单语义入口（#61——与 CLI 同一 orchestrateReview 分流，双面同语义）
 * 域内直通（现状形状零变化，AC4）/ 超界切分串行合并（超界形状，AC1）/ 计划类
 * 拒绝映射（超限 → ShardLimitRejection → -32000 帧，AC2；不可解析 → 退回直通，AC3） */
async function handleReviewRun(params: Record<string, unknown>): Promise<unknown> {
  const request = parseReviewRunParams(params);
  // 环境凭据先检（适配器构造期 fail fast——错误帧回报，进程存活）；实例即弃：
  // 运行单元每片自建适配器（wire 字节捕获按片私有）——CLI 侧凭据前置检查同款
  new DeepSeekLlmAdapter();

  const runner = dshSingleMrRunner({
    config: request.configId,
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.language !== undefined ? { language: request.language } : {}),
    outDir: request.auditDir,
  });
  // MRCase 构造（truth 恒 null、labels 中性载体——与 CLI cliMrCase 同款）；
  // repoPath 可选 → 空串占位（MRCase 契约必填 string；共享 runner falsy 归一
  // 回缺席语义——config A 零工具时合法缺席，与 #27 既有行为一致）
  const mrCase: MRCase = {
    caseId: request.caseId,
    repoPath: request.repoPath ?? "",
    diff: request.diff,
    issueDescription: request.issueDescription,
    truth: null,
    labels: { source: "production", riskClass: "Medium", allowedConfigs: [request.configId] },
  };
  const orchestrated = await orchestrateReview(mrCase, runner, DEFAULT_ORCHESTRATION_CONFIG, {
    // 片完成进度帧（Q4/Q6）：每片一帧 review/progress（transport.notify 公开面），
    // 仅切分执行时发生（域内直通与超限拒绝零帧——与 shards 节同口径）
    onShardRunComplete: (info) => {
      transport.notify("review/progress", {
        shardIndex: info.shardIndex,
        shardCount: info.shardCount,
        shardId: info.shardId,
        runId: info.run.runId,
        ...(info.run.auditPath !== undefined ? { auditPath: info.run.auditPath } : {}),
      });
    },
  });
  if (!orchestrated.ok) {
    return mapPlannedRejection(orchestrated.error, mrCase, runner);
  }
  const { sharded, findings, usage, runs, shards } = orchestrated.value;
  if (!sharded) {
    // 域内直通：现状形状零变化（POC1 RunResult + auditPath——实验面兼容硬约束）
    const run = runs[0]!;
    return { ...toPoc1RunResult(run.result), auditPath: run.auditPath };
  }
  // 超界合并形状（Q2）：求和口径摘要（决策 13：rounds / toolCalls / usage =
  // 各片之和，truncated 任一片即 true）+ shards 节（每片 runId / auditPath
  // 关联独立审计）+ 合并 findings（shardIds 溯源）；顶层无 audit 投影与
  // auditPath（超界由多次运行组成，无单一关联键——各片条目承载）。
  // sharded = true 时 shards 节必在场（直通分支已提前返回）。
  const first = runs[0]!.content;
  return {
    caseId: request.caseId,
    configId: first.configId,
    ...(first.model !== undefined ? { model: first.model } : {}),
    ...(first.outputLanguage !== undefined ? { outputLanguage: first.outputLanguage } : {}),
    truncated: runs.some((run) => run.content.truncated),
    rounds: runs.reduce((sum, run) => sum + run.content.rounds, 0),
    toolCalls: runs.reduce((sum, run) => sum + run.content.toolCalls, 0),
    usage,
    findings,
    shards: shards!,
  };
}

/** 计划类拒绝的 host 侧映射（Q1）：超限 → ShardLimitRejection（分发层映射
 * -32000 + error.data 帧）；不可解析 diff → 退回直通（现状行为——内核从不
 * 解析 diff，该输入集保真，绝不比旧行为差）；其余计划错误按异常上抛（→ -32603） */
async function mapPlannedRejection(
  error: DatasetError,
  mrCase: MRCase,
  runner: ReturnType<typeof dshSingleMrRunner>,
): Promise<unknown> {
  if (error.code === "SHARD_LIMIT_EXCEEDED") {
    throw new ShardLimitRejection(error.message, {
      rejectReason: "shard-limit",
      ...(error.details ?? {}),
    });
  }
  if (error.code === "MALFORMED_DIFF") {
    const run = await runner.run(mrCase);
    return { ...toPoc1RunResult(run.result), auditPath: run.auditPath };
  }
  throw new Error(error.message);
}

const transport = new JsonRpcLineTransport(process.stdin, process.stdout);

/** 方法面分发（review/run + shutdown；未知方法按异常 → -32603） */
async function handleRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (method === "review/run") {
    return handleReviewRun(params);
  }
  if (method === "shutdown") {
    // 响应帧由分发层在 handler 返回后写出；微任务写帧完成后优雅退出
    // （停读 stdin 等循环排干——立即 exit 与在飞线程池写竞争会 fail-fast）
    setTimeout(() => {
      void transport.flush().finally(() => exitGracefully(0, { destroyStdin: true }));
    }, 0);
    return {};
  }
  throw new Error(`kernel-host: unknown method ${JSON.stringify(method)} (expected "review/run" or "shutdown")`);
}

// #61 Q9：SDK transport 服务端无自定义错误帧路径（onRequest handler 拿不到
// 请求 id、throw 恒 -32603、writeError 无 data——已核验全部已发布版本）——
// 接管 handleIncomingRequest 为 host 自家分发以持有 id，计划类拒绝（超限）
// 自写 -32000 + error.data 帧。私有依赖收敛到该方法名与签名；AC2 裸 wire
// 测试锁帧形状（详见 request-dispatch.ts 头注与 #61 Q9 注记）。
installHostRequestDispatch(transport, process.stdout, handleRequest);

transport.start();

// EOF / 信号退出（客户端 close 阶梯的兜底路径；进程退出码恒 0）
process.stdin.on("end", () => {
  void transport.flush().finally(() => exitGracefully(0, { destroyStdin: true }));
});
process.on("SIGTERM", () => exitGracefully(0, { destroyStdin: true }));
process.on("SIGINT", () => exitGracefully(0, { destroyStdin: true }));
