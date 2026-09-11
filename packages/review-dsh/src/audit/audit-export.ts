/**
 * 审计导出适配器（#24）：DSH ReviewRunResult → POC1 审计格式。
 *
 * - RunResult / AuditFileContent 的组装经冻结件（buildAuditFileContent 1:1），
 *   导出零漂移；DSH 侧唯一增量 = 请求携带 wire 捕获字节（真实适配器序列化点
 *   原文；fake 来源合法缺席）——POC1 读取端按结构化字段消费，扩展字段被忽略。
 * - 请求投影复用 review-runtime 的 toPoc1Request（同一转换逻辑单一来源）。
 * - 重放（AC2 语义）：从审计字节重建等价请求并通过校验——wire 在场时反解
 *   wire 字节（review_* → review.*、thinking 锁档 → effort 标签）并强制与
 *   结构化请求逐字段等价；缺席时结构化请求自校验（POC1「requests 数组即可
 *   重放的完整请求」语义）。
 * - 读取端零改动：metrics evaluateRun / judge judgeRun 消费的是 POC1
 *   RunResult 本体（toPoc1RunResult 产出），导出层不包装、不翻译读取端。
 */

import type { ConfigId } from "../../../../src/contracts/config.js";
import { CONFIGS } from "../../../../src/contracts/config.js";
import type { LlmRequest, LlmMessage, ToolCall } from "../../../../src/contracts/llm-client.js";
import { buildAuditFileContent, type AuditFileContent } from "../../../../src/audit/audit-writer.js";
import type { RunAudit, RunResult } from "../../../../src/contracts/run.js";
import { LOCKED_EFFORT_LABEL, LOCKED_REASONING_EFFORT, LOCKED_THINKING } from "../llm/wire.js";
import { REVIEW_PHASES, type ReviewPhase } from "../plugins/review-policy.js";
import { toPoc1Request, type PhaseLogEntry, type ReviewAudit, type ReviewRunResult } from "../plugins/review-runtime.js";

/** DSH 导出审计请求：POC1 LlmRequest + wire 捕获字节（真实适配器来源在场；fake 缺席） */
export type ExportedAuditRequest = LlmRequest & { readonly wireBody?: string };

/** DSH 导出审计文件内容：POC1 AuditFileContent 契约 + 请求级 wire 扩展 */
export interface DshAuditFileContent extends AuditFileContent {
  readonly requests: readonly ExportedAuditRequest[];
}

/** DSH 运行结果 → POC1 RunResult（metrics / judge 读取端直接消费的形态） */
export function toPoc1RunResult(result: ReviewRunResult): RunResult {
  const audit = result.audit;
  return {
    caseId: audit.caseId,
    configId: audit.configId,
    findings: result.findings,
    usage: audit.usage,
    rounds: audit.rounds,
    toolCalls: audit.toolCalls,
    audit: toPoc1RunAudit(audit),
  };
}

/** DSH 运行结果 → POC1 审计文件内容（冻结 buildAuditFileContent 组装 + wire 合并） */
export function toAuditFileContent(result: ReviewRunResult): DshAuditFileContent {
  const audit = result.audit;
  const base = buildAuditFileContent({
    runId: audit.runId,
    caseId: audit.caseId,
    configId: narrowConfigId(audit.configId),
    model: audit.model,
    effort: audit.effort,
    startedAt: new Date(audit.startedAt),
    finishedAt: new Date(audit.finishedAt),
    rounds: audit.rounds,
    toolCalls: audit.toolCalls,
    usage: audit.usage,
    findings: result.findings,
    audit: toPoc1RunAudit(audit),
    ...accountingSpreads(audit),
  });
  // wire 字节在导出时合并（票面：来自适配器捕获，与 session 日志按调用序对位）
  return {
    ...base,
    requests: base.requests.map((request, index) => {
      const wireBody = audit.requests[index]?.wireBody;
      return wireBody !== undefined ? { ...request, wireBody } : request;
    }),
  };
}

/** 审计重放：从审计字节重建等价请求并通过校验。
 *
 * wire 在场（真实适配器来源）：反解 wire 字节重建请求，并强制与结构化请求
 * 逐字段等价（不等价即抛——wire 与 session 日志错位是审计完整性事故）。
 * wire 缺席（fake 来源）：结构化请求即重放源（自校验后原样返回）。
 */
export function replayAuditRequest(request: ExportedAuditRequest): LlmRequest {
  const structured = validateLlmRequest(stripWire(request));
  if (request.wireBody === undefined) {
    return structured;
  }
  const rebuilt = fromWireBody(request.wireBody);
  // 等价性以规范序列化对照（键序敏感是特性不是缺陷）：两侧都按冻结字段序
  // 构造（toPoc1Request / fromWireBody 同一投影序），键序漂移只能来自实现
  // 分叉——那正是这里要 fail fast 暴露的事故。
  if (JSON.stringify(rebuilt) !== JSON.stringify(structured)) {
    throw new Error(
      `audit-export: replay mismatch — wire bytes do not rebuild the structured request (model/effort/messages/tools diverge); the audit is not self-consistent and must not be replayed`,
    );
  }
  return rebuilt;
}

/** DSH 审计 → POC1 RunAudit（请求投影 + phaseLog 阶段名收窄，其余字段同构直传） */
function toPoc1RunAudit(audit: ReviewAudit): RunAudit {
  return {
    requests: audit.requests.map((request) => toPoc1Request(request)),
    toolCallLog: [...audit.toolCallLog],
    phaseLog: audit.phaseLog.map(toPoc1PhaseRecord),
    rejections: [...audit.rejections],
    cacheBreaks: [...audit.cacheBreaks],
    truncated: audit.truncated,
    truncationReasons: [...audit.truncationReasons],
    ...accountingSpreads(audit),
  };
}

/** 可选记账字段（预取 / 全仓 / Ledger）的「定义即在」展开——审计文件顶层与
 * RunAudit 两处消费同一形态 */
function accountingSpreads(audit: ReviewAudit) {
  return {
    ...(audit.prefetch !== undefined ? { prefetch: audit.prefetch } : {}),
    ...(audit.fullRepo !== undefined ? { fullRepo: audit.fullRepo } : {}),
    ...(audit.ledger !== undefined ? { ledger: audit.ledger } : {}),
  };
}

/** phaseLog 条目 → POC1 PhaseRecord（阶段名必须是六阶段之一，未知名 fail fast） */
function toPoc1PhaseRecord(entry: PhaseLogEntry): RunAudit["phaseLog"][number] {
  return { ...entry, phase: narrowPhase(entry.phase) };
}

function narrowPhase(phase: string): ReviewPhase {
  if (!(REVIEW_PHASES as readonly string[]).includes(phase)) {
    throw new Error(
      `audit-export: phaseLog contains unknown phase ${JSON.stringify(phase)} (expected one of the six review phases); the DSH kernel only emits the frozen phase order`,
    );
  }
  return phase as ReviewPhase;
}

/** configId 收窄：MetricsConfigId → ConfigId（内核矩阵收口只产 A–E；
 * "claude-code" 是核外参照标签，出现在内核审计里即装配事故） */
function narrowConfigId(configId: string): ConfigId {
  if (!(configId in CONFIGS)) {
    throw new Error(
      `audit-export: audit configId ${JSON.stringify(configId)} is not an A-E config id (the kernel assembles only the five matrix forms; "claude-code" is an external reference label)`,
    );
  }
  return configId as ConfigId;
}

/** 请求契约校验（POC1 LlmRequest 不变量；重放的「通过校验」半边） */
const MESSAGE_ROLES: readonly LlmMessage["role"][] = ["system", "user", "assistant", "tool"];

function validateLlmRequest(request: LlmRequest): LlmRequest {
  if (typeof request.model !== "string" || request.model.length === 0) {
    throw new Error("audit-export: replayed request has no model");
  }
  if (typeof request.effort !== "string" || request.effort.length === 0) {
    throw new Error("audit-export: replayed request has no effort");
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new Error("audit-export: replayed request has no messages");
  }
  for (const message of request.messages) {
    if (!MESSAGE_ROLES.includes(message.role)) {
      throw new Error(`audit-export: replayed request has invalid message role ${JSON.stringify(message.role)}`);
    }
    if (typeof message.content !== "string") {
      throw new Error(`audit-export: replayed request has non-string content in role ${JSON.stringify(message.role)}`);
    }
  }
  if (!Array.isArray(request.tools)) {
    throw new Error("audit-export: replayed request has no tools array");
  }
  for (const tool of request.tools) {
    if (typeof tool.name !== "string" || typeof tool.description !== "string" || typeof tool.parametersJson !== "string") {
      throw new Error(`audit-export: replayed request has a malformed tool schema entry (${JSON.stringify(tool.name)})`);
    }
  }
  return request;
}

function stripWire(request: ExportedAuditRequest): LlmRequest {
  const { wireBody: _wireBody, ...structured } = request;
  return structured;
}

// ---------- wire 字节反解（chat/completions 请求体 → POC1 LlmRequest） ----------

/** wire 消息的最小形状（反解只读已知字段，未知字段透传忽略）。
 * 与 wire.ts 的 WireMessage（内核消息块）同名异形，故冠 Chat 消歧。 */
interface WireChatMessage {
  readonly role: string;
  readonly content: string | null;
  readonly tool_calls?: readonly {
    readonly id: string;
    readonly function: { readonly name: string; readonly arguments: string };
  }[];
  readonly tool_call_id?: string;
}

interface WireRequestBody {
  readonly model: string;
  readonly messages: readonly WireChatMessage[];
  readonly thinking?: { readonly type: string };
  readonly reasoning_effort?: string;
  readonly tools?: readonly {
    readonly function: { readonly name: string; readonly description: string; readonly parameters: unknown };
  }[];
}

/** wire 字节 → POC1 LlmRequest（review_* → review.*、thinking 锁档 → effort 标签）。
 * 反向映射与 wire.ts 的正向序列化互逆（ADR-0002 锁档：effort "default" ⇄
 * thinking enabled + reasoning_effort "high"）。 */
function fromWireBody(wireBody: string): LlmRequest {
  let body: WireRequestBody;
  try {
    body = JSON.parse(wireBody) as WireRequestBody;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`audit-export: wire body is not valid JSON (${message})`);
  }
  if (body.thinking?.type !== LOCKED_THINKING.type || body.reasoning_effort !== LOCKED_REASONING_EFFORT) {
    throw new Error(
      `audit-export: wire body is not in the locked effort gear (ADR-0002: thinking enabled + reasoning_effort "high"); got thinking=${JSON.stringify(body.thinking)}, reasoning_effort=${JSON.stringify(body.reasoning_effort)}`,
    );
  }
  return {
    model: body.model,
    effort: LOCKED_EFFORT_LABEL,
    messages: body.messages.map(fromWireMessage),
    tools: (body.tools ?? []).map((tool) => ({
      name: fromWireToolName(tool.function.name),
      description: tool.function.description,
      parametersJson: JSON.stringify(tool.function.parameters),
    })),
  };
}

function fromWireMessage(message: WireChatMessage): LlmMessage {
  if (message.role === "assistant" && message.tool_calls !== undefined) {
    const toolCalls: readonly ToolCall[] = message.tool_calls.map((call) => ({
      id: call.id,
      name: fromWireToolName(call.function.name),
      argumentsJson: call.function.arguments,
    }));
    return { role: "assistant", content: message.content ?? "", ...(toolCalls.length > 0 ? { toolCalls } : {}) };
  }
  if (message.role === "tool") {
    if (message.tool_call_id === undefined) {
      throw new Error("audit-export: wire tool message has no tool_call_id");
    }
    return { role: "tool", content: message.content ?? "", toolCallId: message.tool_call_id };
  }
  return { role: message.role as LlmMessage["role"], content: message.content ?? "" };
}

/** wire 工具名 → 内部点号名。
 * 正映射（wire.ts toWireToolName）把所有点号折叠为下划线，本身不可逆；内核
 * 工具名遵循「单点号命名空间 + snake_case 后缀」约定（review.get_diff），故
 * 反解只把首个下划线还原为点号。约定被破坏（多级点号名）时往返不等，由
 * replayAuditRequest 的逐字段对照 fail fast 兜底。 */
function fromWireToolName(name: string): string {
  const separator = name.indexOf("_");
  return separator === -1 ? name : `${name.slice(0, separator)}.${name.slice(separator + 1)}`;
}
