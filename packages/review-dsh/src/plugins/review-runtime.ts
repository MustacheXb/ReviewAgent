/**
 * review-runtime：核内策略驱动器插件（ADR-0006）。
 *
 * 驱动器独占阶段指令推进权：一阶段 = 一 turn（agent.followup），阶段内工具循环 =
 * turn 内 steps；MAX_ROUNDS 由驱动器状态控制；phase-6 verdict complete=false 时
 * followup 开启下一轮（多轮驱动随轮次票落地，本形态跑六阶段 × 1 轮）。
 *
 * 会话启动注入（#18 落锤 + #22 生产化）：MR intro 以 agent.inject 注入（idle
 * driver 留待首条 followup 唤醒，同批进入请求）；config B 预取开启时，Zone B
 * 消息在 MR intro 前、三层预取消息在其后，多连 inject 按调用序排列——与 POC1
 * 请求 1 布局 [system(Zone A), Zone B, MR intro, Symbol, Reference, Call chain,
 * Phase 1] 逐字节对齐。
 */

import type { Context, Plugin } from "@deepseek-ai/cordis";
import { createUserMessage, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { Message, TokenUsage, ToolCallBlock, ToolResultBlock, ToolSchema, UserMessage } from "@deepseek-ai/dsh-llm";
import type { Session, SessionEvent, TurnEndReason } from "@deepseek-ai/dsh-session";
import { SessionId } from "@deepseek-ai/dsh-session";

import type { MetricsConfigId } from "../../../../src/contracts/config.js";
import type { LlmRequest, LlmUsage } from "../../../../src/contracts/llm-client.js";
import type { PrefetchLayerRecord } from "../../../../src/contracts/prefetch.js";
import type { CacheBreakRecord } from "../../../../src/contracts/run.js";
import type { LedgerEntry } from "../../../../src/contracts/ledger.js";
import { classifyCacheBreaks } from "../../../../src/loop/cache-break.js";
import { TRUNCATION_TOOL_BUDGET } from "../../../../src/loop/constants.js";
import { addUsage, ZERO_USAGE } from "../../../../src/loop/usage.js";
import { createToolBudgetGuard, toDshToolDefinitions, TOOL_BUDGET_DENIED_TEXT } from "../context/review-tools.js";
import { LOCKED_EFFORT_LABEL, joinTextBlocks } from "../llm/wire.js";
import type { CapturedWireRequest } from "../llm/wire-log.js";
import { parseCandidatesReply, parseVerificationReply } from "../loop/parse.js";
import type { CapturedKernelRequest } from "./review-cache.js";
import type { MrInput } from "./review-context.js";
import type { CandidateRejection, Finding } from "./review-evidence.js";

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

/** embryonic POC1 审计（A/B/C/E 形态经政策开关；configId 如实推导） */
export interface ReviewAudit {
  readonly runId: string;
  readonly caseId: string;
  readonly configId: MetricsConfigId;
  readonly model: string;
  readonly effort: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly rounds: number;
  /** POC1 契约：实际发生的工具调用数（≤ maxToolCalls；执行 + 失败计入，预算拒绝不计——拒绝只进 toolCallLog） */
  readonly toolCalls: number;
  readonly truncated: boolean;
  readonly truncationReasons: readonly string[];
  /** 事件流 usage 聚合（POC1 LlmUsage 口径：inputTokens = 未命中；可选字段任一事件定义即在，含 0） */
  readonly usage: LlmUsage;
  readonly findings: readonly Finding[];
  readonly phaseLog: readonly PhaseLogEntry[];
  readonly rejections: readonly CandidateRejection[];
  /** 相邻请求前缀分歧的归因分类（POC1 冻结分类器；纯观测，不改变请求字节） */
  readonly cacheBreaks: readonly CacheBreakRecord[];
  readonly requests: readonly AuditLlmRequest[];
  readonly toolCallLog: readonly ToolCallRecord[];
  /** Context Ledger 登记快照（功能态 config E；惰性态与非工具配置合法缺席） */
  readonly ledger?: readonly LedgerEntry[];
  /** config B 注入层记账（POC1 RunAudit.prefetch 契约；非预取配置合法缺席） */
  readonly prefetch?: readonly PrefetchLayerRecord[];
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
  const configId = deriveConfigId(policy);
  const runId = buildRunId(startedAt, configId, input.caseId);

  // 工具挂载（toolsEnabled）：run 私有工具箱（独立 Ledger），先于 agent 创建构建——
  // setup 闭包经 DSH 注册面（scoped tools + guard）把它接入该 agent 的世界
  const toolkit = policy.toolsEnabled
    ? ctx.reviewContext.buildToolkit(input, { ledger: policy.ledger })
    : undefined;

  // config B 预取（prefetch）：Zone B + 三层注入材料（同仓库同 diff 字节级相同），
  // 同样先于 agent 创建构建——失败即 run 失败（POC1：run 启动期装配上下文）
  const prefetch = policy.prefetch ? await ctx.reviewContext.buildPrefetch(input) : undefined;

  // 预算守卫（run 私有闭包计数）：放行数 = 实际发生的工具调用数——POC1 toolCalls
  // 语义（执行 + 失败计入、被拒不计、恒 ≤ max），审计经 allowedCount() 读取
  const toolBudget = createToolBudgetGuard(policy.maxToolCalls);

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
            agentCtx.tools.guard(toolBudget.guard);
          },
        }
      : {}),
  });
  const agent = handle.agent;
  const session = agent.session;

  // 会话启动注入（#18 落锤：inject 不唤醒 idle driver，留待首条 followup 同批
  // 入请求，多连 inject 按调用序）：Zone B → MR intro（Zone C 起点材料）→ 三层
  // 预取——POC1 请求 1 布局 [system, Zone B, MR intro, Symbol, Reference, Call chain]
  if (prefetch !== undefined) {
    agent.inject(userTextMessage(prefetch.zoneBMessage.content));
  }
  agent.inject(ctx.reviewContext.buildMrIntro(input));
  for (const layer of prefetch?.layerMessages ?? []) {
    agent.inject(userTextMessage(layer.content));
  }

  // 回复与计量收集（kernel 侧：session 事件）
  const replies = new Map<number, string>();
  const usageEvents: TokenUsage[] = [];
  const toolCallLog: ToolCallRecord[] = [];
  const openToolCalls = new Map<string, { readonly name: string; readonly argumentsJson: string }>();
  // 预算拒绝按 turn 归因：POC1 把溢出 note 记在发生阶段的 phaseLog 条目上
  const deniedByTurn = new Map<number, number>();
  const offEvents = ctx.on("session/event", (eventSession: Session, event: SessionEvent) => {
    if (eventSession !== session) return;
    if (event.type === "assistant/message") {
      replies.set(event.data.turn, messageText(event.data.message));
      if (event.data.usage !== undefined) {
        usageEvents.push(event.data.usage);
      }
    } else if (event.type === "tool/call") {
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
          const text = toolResultText(result);
          toolCallLog.push({ ...open, resultSummary: text });
          // 预算拒绝辨识（isError + 守卫物化文本双因子；被拒调用计入 toolCallLog
          // 但不计入 toolCalls——放行数由守卫闭包持有，不经事件流计数）
          if (result.isError === true && text === TOOL_BUDGET_DENIED_TEXT) {
            deniedByTurn.set(event.data.turn, (deniedByTurn.get(event.data.turn) ?? 0) + 1);
          }
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
      agent.followup(userTextMessage(policy.phaseInstruction(phase)));
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
    // phaseLog note 装配（POC1 同位语义）：预算拒绝记 "N tool call(s) skipped:
    // budget exhausted" 于发生阶段条目，解析 note 落 Evidence Verification——
    // POC1 把工具周期 note 与解析 note 以 "; " 串联，此处同构
    const phaseLogWithNotes = phaseLog.map((entry, index) => {
      const notes: string[] = [];
      const denied = deniedByTurn.get(index + 1);
      if (denied !== undefined) {
        notes.push(`${denied} tool call(s) skipped: budget exhausted`);
      }
      if (entry.phase === "Evidence Verification" && parseNote !== undefined) {
        notes.push(parseNote);
      }
      return notes.length > 0 ? { ...entry, note: notes.join("; ") } : entry;
    });
    const auditRequests = toAuditRequests(
      ctx.reviewCache.requests,
      ctx.reviewCache.wireRequests,
      ctx.reviewCache.wireCaptureEnabled,
    );
    const audit: ReviewAudit = {
      runId,
      caseId: input.caseId,
      configId,
      model: policy.model,
      effort: policy.effortLabel,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      rounds: 1,
      toolCalls: toolBudget.allowedCount(),
      // POC1 语义：truncated = 评审未完成（!complete）才置 true——本形态
      // complete=false 直接显式失败（多轮驱动随轮次票），预算耗尽只追加
      // truncationReason，不翻转 truncated
      truncated: false,
      truncationReasons: toolBudget.deniedCount() > 0 ? [TRUNCATION_TOOL_BUDGET] : [],
      // 冻结 addUsage 直用（reduce + ZERO_USAGE）：聚合语义单一来源——可选字段
      // 任一事件定义即在，含 0（网关显式回报 cached_tokens: 0 是有信息量的记账）
      usage: usageEvents.reduce(addUsage, ZERO_USAGE),
      findings: gate.findings,
      phaseLog: phaseLogWithNotes,
      rejections: gate.rejections,
      cacheBreaks: classifyAuditCacheBreaks(auditRequests),
      requests: auditRequests,
      toolCallLog,
      // 功能态 Ledger 留痕（POC1 契约：config.ledger 且 toolkit 在场；惰性态缺席）
      ...(toolkit !== undefined && policy.ledger ? { ledger: toolkit.ledger.snapshot() } : {}),
      // config B 注入层记账（POC1 RunAudit.prefetch 契约；非预取配置缺席）
      ...(prefetch !== undefined ? { prefetch: prefetch.records } : {}),
    };

    return { findings: gate.findings, phaseLog: audit.phaseLog, audit };
  } finally {
    // 不逐 run dispose：handle.dispose 会等 loop 静默，而超时/异常路径的 turn 可能
    // 永远不静默（适配器挂起即死锁）。当前产品形态 profile-per-run，agent 生命周期
    // 由组装树拆卸（ctx.fiber.dispose → loop 排空全部 agent）统一收口
    offEvents();
  }
}

/** 纯文本 user 消息（阶段指令、Zone B 与预取层注入共用的 DSH 形态转换） */
function userTextMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: "text", text }],
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
  // role 透传（DSH Message role = 'system' | 'user' | 'assistant'，assistant 已
  // 分流）：保真投影而非硬编码 "user"
  return [{ role: message.role, content: messageText(message) }];
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

/** configId 推导（既有政策开关 → A–E 标签；#25 preset 注册表落地前的最小诚实化）：
 * prefetch → B；toolsEnabled → ledger ? E : C；缺省 → A。D（stablePrefix）随其票
 * 获得开关。政策互斥校验（review-policy）保证组合空间内标签无歧义。
 */
function deriveConfigId(policy: {
  readonly prefetch: boolean;
  readonly toolsEnabled: boolean;
  readonly ledger: boolean;
}): MetricsConfigId {
  if (policy.prefetch) {
    return "B";
  }
  if (policy.toolsEnabled) {
    return policy.ledger ? "E" : "C";
  }
  return "A";
}

/** 审计请求 → POC1 LlmRequest 形态（tools 的 parameters 对象经 JSON 序列化还原
 * parametersJson——round-trip 字节 = 注册表 canonical，#20 已锁定该等价） */
function toPoc1Request(request: AuditLlmRequest): LlmRequest {
  return {
    model: request.model,
    effort: request.effort,
    messages: [...request.messages],
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parametersJson: JSON.stringify(tool.parameters),
    })),
  };
}

/** 审计请求序列 → Cache Break 归因（POC1 冻结分类器 1:1；纯观测，不改变请求字节） */
export function classifyAuditCacheBreaks(requests: readonly AuditLlmRequest[]): readonly CacheBreakRecord[] {
  return classifyCacheBreaks(requests.map(toPoc1Request));
}

/** POC1 runId：`<ISO 去连字符与冒号去 Z>-<configId>-<caseId 清洗>`（对齐冻结 audit-writer） */
function buildRunId(startedAt: Date, configId: MetricsConfigId, caseId: string): string {
  const stamp = startedAt.toISOString().replace(/[-:]/g, "").replace("Z", "");
  return `${stamp}-${configId}-${sanitizeId(caseId)}`;
}

/** 会话 id / runId 尾段的路径安全清洗（Windows 目录名禁 ":" 等） */
function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}
