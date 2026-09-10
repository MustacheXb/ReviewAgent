/**
 * review-runtime：核内策略驱动器插件（ADR-0006）。
 *
 * 驱动器独占阶段指令推进权：一阶段 = 一 turn（agent.followup），阶段内工具循环 =
 * turn 内 steps；MAX_ROUNDS 由驱动器状态控制；phase-6 verdict complete=false 时
 * followup 开启下一轮（多轮驱动随轮次票落地，本形态跑 config A 六阶段 × 1 轮）。
 *
 * MR intro 以 agent.inject 在会话启动时注入（idle driver 留待首条 followup 唤醒，
 * 同批进入请求——walking-skeleton 实测：inject 落 messages[0]、followup 落其后，
 * 与 POC1 请求 1 布局 [system(Zone A), MR intro, Phase 1] 逐字节对齐）。
 */

import type { Context, Plugin } from "@deepseek-ai/cordis";
import { createUserMessage, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { Message, ToolCallBlock, ToolResultBlock, ToolSchema, UserMessage } from "@deepseek-ai/dsh-llm";
import type { Session, SessionEvent, TurnEndReason } from "@deepseek-ai/dsh-session";
import { SessionId } from "@deepseek-ai/dsh-session";

import type { LedgerEntry } from "../../../../src/contracts/ledger.js";
import { createToolBudgetGuard, toDshToolDefinitions } from "../context/review-tools.js";
import { LOCKED_EFFORT_LABEL, joinTextBlocks } from "../llm/wire.js";
import type { CapturedWireRequest } from "../llm/wire-log.js";
import { parseCandidatesReply, parseVerificationReply } from "../loop/parse.js";
import type { CapturedKernelRequest } from "./review-cache.js";
import type { MrInput } from "./review-context.js";
import type { CandidateRejection, Finding } from "./review-evidence.js";

/** 本形态唯一配置：config A（零工具、Diff-only）；工具形态（C/D/E）经政策开关挂载 */
const CONFIG_ID = "A";

/** POC1 审计 phaseLog 条目 */
export interface PhaseLogEntry {
  readonly round: number;
  readonly phase: string;
  readonly requestCount: number;
  readonly note?: string;
}

/**
 * POC1 LlmMessage 形态的审计消息投影：assistant 工具调用（toolCalls）与工具结果
 * （role "tool" + toolCallId）完整留痕；工具名为内部点号名（review.* 映射只发生在
 * DeepSeek 适配器的 wire 序列化点）。
 */
export type AuditMessage =
  | { readonly role: "system" | "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly toolCalls?: readonly { readonly id: string; readonly name: string; readonly argumentsJson: string }[];
    }
  | { readonly role: "tool"; readonly content: string; readonly toolCallId: string };

/** POC1 审计 ToolCallRecord（resultSummary = 模型可见的工具结果文本，含 Error: 拒绝） */
export interface ToolCallRecord {
  readonly name: string;
  readonly argumentsJson: string;
  readonly resultSummary: string;
}

/** POC1 审计 LlmRequest（结构化请求快照；messages 含 messages[0] 的 system 槽） */
export interface AuditLlmRequest {
  readonly model: string;
  readonly effort: string;
  readonly messages: readonly AuditMessage[];
  /** POC1 契约：请求携带完整 ToolSchema 列表（config A 恒为空数组） */
  readonly tools: readonly ToolSchema[];
  /**
   * wire 序列化点的精确请求字节（JSON 原文，可原样重放——POC1「可重放字节」契约）。
   * DeepSeek 适配器运行时逐条携带；fake 适配器无 wire 序列化，字段缺席。
   */
  readonly wireBody?: string;
}

/** embryonic POC1 审计（config A 形态；cacheBreaks 随对应票扩展） */
export interface ReviewAudit {
  readonly runId: string;
  readonly caseId: string;
  readonly configId: string;
  readonly model: string;
  readonly effort: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly rounds: number;
  readonly toolCalls: number;
  readonly truncated: boolean;
  readonly truncationReasons: readonly string[];
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens?: number };
  readonly findings: readonly Finding[];
  readonly phaseLog: readonly PhaseLogEntry[];
  readonly rejections: readonly CandidateRejection[];
  readonly cacheBreaks: readonly unknown[];
  readonly requests: readonly AuditLlmRequest[];
  readonly toolCallLog: readonly ToolCallRecord[];
  /** Context Ledger 登记快照（功能态 config E；惰性态与非工具配置合法缺席） */
  readonly ledger?: readonly LedgerEntry[];
}

/** 一次检视会话的产出 */
export interface ReviewRunResult {
  /** 通过 Evidence Gate 的最终 findings */
  readonly findings: readonly Finding[];
  /** 阶段轨迹（round × phase × requestCount） */
  readonly phaseLog: readonly PhaseLogEntry[];
  /** embryonic POC1 格式审计 */
  readonly audit: ReviewAudit;
}

/** reviewRuntime 服务：检视会话入口（策略驱动器） */
export interface ReviewRuntimeService {
  /** 发起一次检视会话：MR 输入 → Finding + 阶段轨迹 + 审计（进程内） */
  run(input: MrInput): Promise<ReviewRunResult>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    reviewRuntime: ReviewRuntimeService;
  }
}

/** review-runtime 插件：策略驱动器服务 */
export const reviewRuntime: Plugin.Object = {
  name: "review-runtime",
  inject: ["agentLoop", "llm", "reviewPolicy", "reviewContext", "reviewCache", "reviewEvidence"],
  apply(ctx: Context) {
    const service: ReviewRuntimeService = {
      run: (input) => driveReview(ctx, input),
    };
    return ctx.provide("reviewRuntime", service);
  },
};

async function driveReview(ctx: Context, input: MrInput): Promise<ReviewRunResult> {
  const policy = ctx.reviewPolicy;
  const startedAt = new Date();
  const runId = buildRunId(startedAt, CONFIG_ID, input.caseId);

  // 工具挂载（toolsEnabled）：run 私有工具箱（独立 Ledger），先于 agent 创建构建——
  // setup 闭包经 DSH 注册面（scoped tools + guard）把它接入该 agent 的世界
  const toolkit = policy.toolsEnabled
    ? ctx.reviewContext.buildToolkit(input, { ledger: policy.ledger })
    : undefined;

  const handle = await ctx.agentLoop.createAgent(ctx, {
    sessionId: SessionId(sanitizeId(runId)),
    agentOptions: {
      provider: policy.provider,
      model: policy.model,
      reasoningEffort: ReasoningEffortId(policy.effortLabel),
    },
    ...(toolkit !== undefined
      ? {
          // 发布前的组合点：scoped 工具注册（首请求即携带 7 个 schema）+ 预算守卫
          setup: (agentCtx: Context) => {
            for (const definition of toDshToolDefinitions(toolkit)) {
              agentCtx.tools.register(definition);
            }
            agentCtx.tools.guard(createToolBudgetGuard(policy.maxToolCalls));
          },
        }
      : {}),
  });
  const agent = handle.agent;
  const session = agent.session;

  // 会话启动注入：MR intro（Zone C 起点材料，非指令；留待首条 followup 同批入请求）
  agent.inject(ctx.reviewContext.buildMrIntro(input));

  // 回复与计量收集（kernel 侧：session 事件）
  const replies = new Map<number, string>();
  const usageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  const toolCallLog: ToolCallRecord[] = [];
  const openToolCalls = new Map<string, { readonly name: string; readonly argumentsJson: string }>();
  let toolCalls = 0;
  const offEvents = ctx.on("session/event", (eventSession: Session, event: SessionEvent) => {
    if (eventSession !== session) return;
    if (event.type === "assistant/message") {
      replies.set(event.data.turn, messageText(event.data.message));
      const usage = event.data.usage;
      if (usage !== undefined) {
        usageTotals.inputTokens += usage.inputTokens;
        usageTotals.outputTokens += usage.outputTokens;
        usageTotals.cacheReadTokens += usage.cacheReadTokens ?? 0;
      }
    } else if (event.type === "tool/call") {
      toolCalls += 1;
      openToolCalls.set(event.data.callId, {
        name: event.data.name,
        argumentsJson: event.data.arguments,
      });
    } else if (event.type === "tool/result") {
      // ToolResultMessage 是 user 角色单块消息：callId 在 ToolResultBlock 上
      const result = event.data.message.content[0];
      if (result !== undefined && result.type === "tool-result") {
        const open = openToolCalls.get(result.toolCallId);
        if (open !== undefined) {
          openToolCalls.delete(result.toolCallId);
          toolCallLog.push({ ...open, resultSummary: toolResultText(result) });
        }
      }
    }
  });

  try {
    // 六阶段骨架 × 1 轮：一阶段 = 一 turn，驱动器独占推进
    const phaseLog: PhaseLogEntry[] = [];
    let parseNote: string | undefined;
    for (const [index, phase] of policy.phases.entries()) {
      const turn = index + 1;
      const turnEnded = awaitTurnEnd(ctx, session, turn, policy.turnTimeoutMs);
      const requestsBefore = ctx.reviewCache.requests.length;
      agent.followup(phaseUserMessage(policy.phaseInstruction(phase)));
      const reason = await turnEnded;
      if (reason.kind !== "completed") {
        throw new Error(`review-runtime: turn ${turn} (${phase}) ended with reason "${reason.kind}"`);
      }
      // turn/end 后 kick 驱动器还有一个微任务尾巴（置 idle）；等它落定再发下一条
      // followup——否则 followup 撞上 running→idle 的窗口，wake 被吞、消息悬死
      // inbox（0.1.2-rc.1 实测；whenIdle 是 DSH 驱动器的标准节拍）
      await agent.whenIdle();
      phaseLog.push({
        round: 1,
        phase,
        requestCount: ctx.reviewCache.requests.length - requestsBefore,
      });
    }

    // 解析阶段回复：候选（Deep Reasoning）× 裁决（Evidence Verification），
    // turn 序号从 policy.phases 推导，不硬编码
    const deepReasoningTurn = policy.phases.indexOf("Deep Reasoning") + 1;
    const evidenceVerificationTurn = policy.phases.indexOf("Evidence Verification") + 1;
    const reasoning = parseCandidatesReply(replies.get(deepReasoningTurn) ?? "");
    const verification = parseVerificationReply(replies.get(evidenceVerificationTurn) ?? "");
    if (!verification.complete) {
      throw new Error(
        "review-runtime: multi-round driving (complete=false) lands with the rounds ticket; the walking skeleton runs exactly one round",
      );
    }
    parseNote = reasoning.note ?? verification.note;

    // Evidence Gate：候选 × 裁决 → findings + rejections
    const gate = ctx.reviewEvidence.applyGate({
      candidates: reasoning.candidates,
      verdicts: verification.verdicts,
      emittedIds: new Set<string>(),
      round: 1,
    });

    const finishedAt = new Date();
    const audit: ReviewAudit = {
      runId,
      caseId: input.caseId,
      configId: CONFIG_ID,
      model: policy.model,
      effort: policy.effortLabel,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      rounds: 1,
      toolCalls,
      truncated: false,
      truncationReasons: [],
      usage: {
        inputTokens: usageTotals.inputTokens,
        outputTokens: usageTotals.outputTokens,
        ...(usageTotals.cacheReadTokens > 0 ? { cacheReadTokens: usageTotals.cacheReadTokens } : {}),
      },
      findings: gate.findings,
      phaseLog:
        parseNote !== undefined
          ? phaseLog.map((entry) => (entry.phase === "Evidence Verification" ? { ...entry, note: parseNote } : entry))
          : phaseLog,
      rejections: gate.rejections,
      cacheBreaks: [],
      requests: toAuditRequests(
        ctx.reviewCache.requests,
        ctx.reviewCache.wireRequests,
        ctx.reviewCache.wireCaptureEnabled,
      ),
      toolCallLog,
      // 功能态 Ledger 留痕（POC1 契约：config.ledger 且 toolkit 在场；惰性态缺席）
      ...(toolkit !== undefined && policy.ledger ? { ledger: toolkit.ledger.snapshot() } : {}),
    };

    return { findings: gate.findings, phaseLog: audit.phaseLog, audit };
  } finally {
    // 不逐 run dispose：handle.dispose 会等 loop 静默，而超时/异常路径的 turn 可能
    // 永远不静默（适配器挂起即死锁）。当前产品形态 profile-per-run，agent 生命周期
    // 由组装树拆卸（ctx.fiber.dispose → loop 排空全部 agent）统一收口
    offEvents();
  }
}

function phaseUserMessage(instruction: string): UserMessage {
  return createUserMessage({
    content: [{ type: "text", text: instruction }],
    source: { kind: "user" },
  });
}

/** DSH Message → 纯文本（wire 同款投影；无 text 块按空串，工具块经投影函数分流） */
function messageText(message: Message): string {
  return joinTextBlocks(message) ?? "";
}

/** ToolResultBlock → 模型可见结果文本（POC1 resultSummary 语义：结果原文，含 Error: 拒绝） */
function toolResultText(result: ToolResultBlock): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** DSH Message → POC1 LlmMessage 审计形态；一条消息可投影多条（tool 结果独立成行） */
function projectMessage(message: Message): AuditMessage[] {
  if (message.role === "assistant") {
    const toolCalls = message.content
      .filter((block): block is ToolCallBlock => block.type === "tool-call")
      .map((block) => ({ id: block.id, name: block.name, argumentsJson: block.arguments }));
    return toolCalls.length > 0
      ? [{ role: "assistant", content: messageText(message), toolCalls }]
      : [{ role: "assistant", content: messageText(message) }];
  }
  const toolResults = message.content.filter(
    (block): block is ToolResultBlock => block.type === "tool-result",
  );
  if (toolResults.length > 0) {
    return toolResults.map((result) => ({
      role: "tool" as const,
      content: toolResultText(result),
      toolCallId: result.toolCallId,
    }));
  }
  return [{ role: "user", content: messageText(message) }];
}

/** 等待指定 turn 结束（政策时限内未结束显式失败；只认本 session 的 turn/end） */
function awaitTurnEnd(
  ctx: Context,
  session: Session,
  turn: number,
  turnTimeoutMs: number,
): Promise<TurnEndReason> {
  return new Promise<TurnEndReason>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`review-runtime: turn ${turn} did not end within ${turnTimeoutMs}ms`));
    }, turnTimeoutMs);
    const off = ctx.on("session/event", (eventSession: Session, event: SessionEvent) => {
      if (eventSession !== session) return;
      if (event.type === "turn/end" && event.data.turn === turn) {
        cleanup();
        resolve(event.data.reason);
      }
    });
    function cleanup() {
      clearTimeout(timer);
      off();
    }
  });
}

/**
 * kernel 侧请求快照 × wire 字节按调用序合并为审计请求序列。
 *
 * 硬不变量：wire 捕获挂载时两流长度必须相等——kernel 快照在 llm/stream waterfall
 * 分发时入列，wire 字节在适配器序列化点入列，一次成功调用两处各记一条；任何
 * 早退的分发（预中止 / 路由校验拒绝）产生「有快照无字节」，若静默按位 zip，
 * 后续所有 wireBody 会错位归因到错误的调用。违背即 fail fast，绝不产出错位审计。
 * wire 捕获未挂载（fake 适配器）时 wireRequests 恒空，字段合法缺席。
 */
export function toAuditRequests(
  requests: readonly CapturedKernelRequest[],
  wireRequests: readonly CapturedWireRequest[],
  wireCaptureEnabled: boolean,
): AuditLlmRequest[] {
  if (wireCaptureEnabled && wireRequests.length !== requests.length) {
    throw new Error(
      `review-runtime: wire capture is misaligned: ${wireRequests.length} wire record(s) for ${requests.length} kernel request(s); replay bytes would be attributed to the wrong call (one dispatch exited before the serialization point)`,
    );
  }
  return requests.map((request, index) => toAuditRequest(request, wireRequests[index]));
}

/** kernel 侧请求快照 → POC1 审计请求形态（system 落 messages[0]，工具调用/结果全投影，wire 字节按调用序并入） */
function toAuditRequest(request: CapturedKernelRequest, wire?: CapturedWireRequest): AuditLlmRequest {
  return {
    model: request.model,
    effort: request.reasoningEffort ?? LOCKED_EFFORT_LABEL,
    messages: [
      ...(request.system !== undefined ? [{ role: "system" as const, content: request.system }] : []),
      ...request.messages.flatMap((message) => projectMessage(message)),
    ],
    tools: request.tools,
    ...(wire !== undefined ? { wireBody: wire.text } : {}),
  };
}

/** POC1 runId：`<ISO 去连字符与冒号去 Z>-<configId>-<caseId 清洗>`（对齐冻结 audit-writer） */
function buildRunId(startedAt: Date, configId: string, caseId: string): string {
  const stamp = startedAt.toISOString().replace(/[-:]/g, "").replace("Z", "");
  return `${stamp}-${configId}-${sanitizeId(caseId)}`;
}

/** 会话 id / runId 尾段的路径安全清洗（Windows 目录名禁 ":" 等） */
function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}
