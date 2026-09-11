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
 * 单元隔离：每请求全新 Context + assembleReviewProfile（profile-per-run，与
 * CLI wrapper 同款）——reviewCache / 工具预算 / Ledger 均为请求私有，单元间
 * 零共享状态；config 经请求参数逐单元切换（REVIEW_PRESETS 真源）。失败单元
 * 经错误帧回报（-32603），进程存活继续下一单元（实验运行器的失败隔离）。
 *
 * 凭据经环境变量（DEEPSEEK_API_KEY / DEEPSEEK_URL），适配器每请求构造期
 * fail fast；错误消息不回显 key 值。stdout 只承载 JSON-RPC 帧（协议纯净性
 * 由部署保证——同 dsh-sdk-jsonrpc-server 约定），诊断不写 stdout。
 *
 * 进程调用形态：review-kernel-host（stdin/stdout = JSON-RPC；EOF / shutdown /
 * 信号均以 0 退出）。
 */

import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";

import { writeAuditFile } from "../../../../src/audit/audit-writer.js";
import type { ConfigId } from "../../../../src/contracts/config.js";
import { toAuditFileContent, toPoc1RunResult } from "../audit/audit-export.js";
import { DeepSeekLlmAdapter } from "../llm/deepseek-adapter.js";
import { REVIEW_PRESETS } from "../presets/review-presets.js";
import { assembleReviewProfile } from "../profile/assemble.js";

/** review/run 请求参数（进程边界契约；字段校验 fail fast） */
interface ReviewRunParams {
  readonly configId: ConfigId;
  readonly caseId: string;
  readonly issueDescription: string;
  readonly diff: string;
  readonly repoPath?: string;
  readonly auditDir: string;
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
  return {
    configId: configId as ConfigId,
    caseId: requireString(params, "caseId"),
    issueDescription: issueDescription ?? "",
    diff: requireString(params, "diff"),
    ...(repoPath !== undefined ? { repoPath } : {}),
    auditDir: requireString(params, "auditDir"),
  };
}

/** review/run：组装 → 运行 → 导出（审计落盘 + POC1 RunResult 返回） */
async function handleReviewRun(params: Record<string, unknown>): Promise<unknown> {
  const request = parseReviewRunParams(params);
  // 环境凭据先检（适配器构造期 fail fast——错误帧回报，进程存活）
  const adapter = new DeepSeekLlmAdapter();

  const sessionParent = join(request.auditDir, "sessions");
  await mkdir(sessionParent, { recursive: true });
  const sessionRoot = await mkdtemp(join(sessionParent, "run-"));

  const ctx = new Context();
  try {
    await assembleReviewProfile(ctx, {
      sessionRoot,
      adapter,
      policy: REVIEW_PRESETS[request.configId],
    });
    const result = await ctx.reviewRuntime.run({
      caseId: request.caseId,
      issueDescription: request.issueDescription,
      diff: request.diff,
      ...(request.repoPath !== undefined ? { repoPath: request.repoPath } : {}),
    });
    const content = toAuditFileContent(result);
    const auditPath = await writeAuditFile(join(request.auditDir, "audit"), content);
    // POC1 RunResult（metrics / judge 读取端直接消费）+ auditPath
    return { ...toPoc1RunResult(result), auditPath };
  } finally {
    // 每请求树拆卸（半挂树同样拆；失败单元不污染下一单元的内核状态）
    await ctx.fiber.dispose();
  }
}

const transport = new JsonRpcLineTransport(process.stdin, process.stdout);

transport.onRequest(async (method, params) => {
  if (method === "review/run") {
    return handleReviewRun(params);
  }
  if (method === "shutdown") {
    // 响应帧由 transport 在 handler 返回后写出；微任务写帧完成后 flush 再退
    setTimeout(() => {
      void transport.flush().finally(() => process.exit(0));
    }, 0);
    return {};
  }
  throw new Error(`kernel-host: unknown method ${JSON.stringify(method)} (expected "review/run" or "shutdown")`);
});

transport.start();

// EOF / 信号退出（客户端 close 阶梯的兜底路径；进程退出码恒 0）
process.stdin.on("end", () => {
  void transport.flush().finally(() => process.exit(0));
});
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
