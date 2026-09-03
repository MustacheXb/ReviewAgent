import type { ReviewConfig } from "../contracts/config.js";
import type { Finding } from "../contracts/finding.js";
import type {
  LlmClient,
  LlmMessage,
  LlmRequest,
  LlmResponse,
  LlmUsage,
  ToolCall,
  ToolSchema,
} from "../contracts/llm-client.js";
import type { MRCase } from "../contracts/mr-case.js";
import type { CandidateRejection, PhaseRecord, ReviewPhase, ToolCallRecord } from "../contracts/run.js";
import { applyCandidateGate } from "../gate/candidate-gate.js";
import { MAX_ROUNDS, MAX_TOOL_CALLS, TRUNCATION_MAX_ROUNDS, TRUNCATION_TOOL_BUDGET } from "./constants.js";
import { buildInitialMessages, type ContextMessages } from "./messages.js";
import type { CandidatesParseResult, VerificationParseResult } from "./parse.js";
import { parseCandidatesReply, parseVerificationReply } from "./parse.js";
import { PHASE_INSTRUCTIONS, PHASE_ORDER } from "./phases.js";
import type { ToolExecutor } from "./tools.js";
import { failedToolCallRecord, skippedToolCallRecord } from "./tools.js";
import { addUsage, ZERO_USAGE } from "./usage.js";

/** Review Loop 输入（run-review.ts 组装） */
export interface LoopInputs {
  readonly config: ReviewConfig;
  readonly mrCase: MRCase;
  readonly llmClient: LlmClient;
  readonly model: string;
  readonly effort: string;
  /** T03 挂载的 review.* 工具 schema（toolsEnabled=false 时请求不带任何工具） */
  readonly tools: readonly ToolSchema[];
  /** T03 挂载的工具执行器 */
  readonly toolExecutor: ToolExecutor | undefined;
  /** 工单 #4：config B 的确定性上下文注入（Zone B + 预取层），循环开始前一次性构造 */
  readonly contextMessages?: ContextMessages;
}

/** Review Loop 输出（组装 RunResult / RunAudit 的全部素材） */
export interface LoopOutcome {
  readonly findings: readonly Finding[];
  readonly rejections: readonly CandidateRejection[];
  readonly usage: LlmUsage;
  readonly requests: readonly LlmRequest[];
  readonly phaseLog: readonly PhaseRecord[];
  readonly toolCallLog: readonly ToolCallRecord[];
  readonly toolCallCount: number;
  readonly rounds: number;
  readonly truncated: boolean;
  readonly truncationReasons: readonly string[];
}

interface LoopState {
  readonly messages: readonly LlmMessage[];
  readonly requests: readonly LlmRequest[];
  readonly usage: LlmUsage;
  readonly phaseLog: readonly PhaseRecord[];
  readonly toolCallLog: readonly ToolCallRecord[];
  readonly toolCallCount: number;
  readonly findings: readonly Finding[];
  readonly rejections: readonly CandidateRejection[];
  readonly emittedIds: ReadonlySet<string>;
  readonly truncationReasons: readonly string[];
  readonly rounds: number;
}

interface PhaseRunResult {
  readonly state: LoopState;
  readonly candidates: CandidatesParseResult | undefined;
  readonly verification: VerificationParseResult | undefined;
}

interface ToolCycleResult {
  readonly state: LoopState;
  readonly messages: readonly LlmMessage[];
  readonly notes: readonly string[];
  /** true = 工具结果已回填，需要再次调用 LLM；false = 阶段就地终止 */
  readonly recall: boolean;
}

/**
 * 六阶段骨架循环（主文档第 3 章）：
 * 轮 = 一次完整的六阶段推进；max_rounds / max_tool_calls 硬上界强制生效。
 */
export async function runReviewLoop(inputs: LoopInputs): Promise<LoopOutcome> {
  let state: LoopState = {
    messages: buildInitialMessages(inputs.mrCase, inputs.contextMessages),
    requests: [],
    usage: ZERO_USAGE,
    phaseLog: [],
    toolCallLog: [],
    toolCallCount: 0,
    findings: [],
    rejections: [],
    emittedIds: new Set<string>(),
    truncationReasons: [],
    rounds: 0,
  };
  let complete = false;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    state = { ...state, rounds: round };
    const roundResult = await runRound(state, inputs, round);
    state = roundResult.state;
    complete = roundResult.complete;
    if (complete) {
      break;
    }
  }
  if (!complete) {
    state = { ...state, truncationReasons: appendReason(state.truncationReasons, TRUNCATION_MAX_ROUNDS) };
  }
  return { ...state, truncated: !complete };
}

async function runRound(
  state: LoopState,
  inputs: LoopInputs,
  round: number,
): Promise<{ readonly state: LoopState; readonly complete: boolean }> {
  let current = state;
  let candidates: readonly unknown[] = [];
  let verification: VerificationParseResult | undefined;
  for (const phase of PHASE_ORDER) {
    const phaseRun = await runPhase(current, inputs, phase, round);
    current = phaseRun.state;
    if (phaseRun.candidates !== undefined) {
      candidates = phaseRun.candidates.candidates;
    }
    if (phaseRun.verification !== undefined) {
      verification = phaseRun.verification;
    }
  }
  const gate = applyCandidateGate({
    candidates,
    verdicts: verification?.verdicts ?? new Map(),
    emittedIds: current.emittedIds,
    round,
  });
  current = {
    ...current,
    findings: [...current.findings, ...gate.findings],
    rejections: [...current.rejections, ...gate.rejections],
    emittedIds: gate.emittedIds,
  };
  return { state: current, complete: verification?.complete ?? false };
}

async function runPhase(
  state: LoopState,
  inputs: LoopInputs,
  phase: ReviewPhase,
  round: number,
): Promise<PhaseRunResult> {
  let messages: readonly LlmMessage[] = [
    ...state.messages,
    { role: "user", content: PHASE_INSTRUCTIONS[phase] },
  ];
  let current = state;
  let requestCount = 0;
  let notes: readonly string[] = [];
  let lastResponse: LlmResponse | undefined;

  for (;;) {
    const call = await callLlm(current, inputs, messages, phase, round);
    current = call.state;
    lastResponse = call.response;
    requestCount++;
    if (lastResponse.toolCalls.length === 0) {
      messages = [...messages, { role: "assistant", content: lastResponse.content }];
      break;
    }
    const cycle = await processToolCalls(current, inputs, messages, lastResponse);
    current = cycle.state;
    messages = cycle.messages;
    notes = [...notes, ...cycle.notes];
    if (!cycle.recall) {
      break;
    }
  }
  if (lastResponse === undefined) {
    throw new Error(`phase "${phase}" (round ${round}) completed without an LLM response`);
  }

  const parsed = parsePhaseOutput(phase, lastResponse.content);
  const note = [...notes, ...(parsed.note !== undefined ? [parsed.note] : [])].join("; ");
  const phaseRecord: PhaseRecord = {
    round,
    phase,
    requestCount,
    ...(note.length > 0 ? { note } : {}),
  };
  current = { ...current, messages, phaseLog: [...current.phaseLog, phaseRecord] };
  return { state: current, candidates: parsed.candidates, verification: parsed.verification };
}

function parsePhaseOutput(
  phase: ReviewPhase,
  content: string,
): {
  readonly candidates?: CandidatesParseResult;
  readonly verification?: VerificationParseResult;
  readonly note?: string;
} {
  if (phase === "Deep Reasoning") {
    const candidates = parseCandidatesReply(content);
    return { candidates, ...(candidates.note !== undefined ? { note: candidates.note } : {}) };
  }
  if (phase === "Evidence Verification") {
    const verification = parseVerificationReply(content);
    return { verification, ...(verification.note !== undefined ? { note: verification.note } : {}) };
  }
  return {};
}

async function callLlm(
  state: LoopState,
  inputs: LoopInputs,
  messages: readonly LlmMessage[],
  phase: ReviewPhase,
  round: number,
): Promise<{ readonly state: LoopState; readonly response: LlmResponse }> {
  const request: LlmRequest = {
    model: inputs.model,
    effort: inputs.effort,
    messages,
    tools: inputs.config.toolsEnabled ? inputs.tools : [],
  };
  try {
    const response = await inputs.llmClient.complete(request);
    return {
      state: {
        ...state,
        requests: [...state.requests, request],
        usage: addUsage(state.usage, response.usage),
      },
      response,
    };
  } catch (error) {
    throw new Error(
      `LLM call failed during phase "${phase}" (round ${round}): ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

async function processToolCalls(
  state: LoopState,
  inputs: LoopInputs,
  messages: readonly LlmMessage[],
  response: LlmResponse,
): Promise<ToolCycleResult> {
  const assistantWithToolCalls: LlmMessage = {
    role: "assistant",
    content: response.content,
    toolCalls: response.toolCalls,
  };
  let appended: readonly LlmMessage[] = [...messages, assistantWithToolCalls];
  if (!inputs.config.toolsEnabled || inputs.toolExecutor === undefined) {
    const records = response.toolCalls.map((call) =>
      skippedToolCallRecord(call, "tools are not enabled in this configuration"),
    );
    return {
      state: appendToolRecords(state, records),
      messages: appended,
      notes: ["tool calls ignored: tools are not enabled in this configuration"],
      recall: false,
    };
  }
  const remaining = MAX_TOOL_CALLS - state.toolCallCount;
  if (remaining <= 0) {
    return {
      state: addTruncationReason(state, TRUNCATION_TOOL_BUDGET),
      messages: appended,
      notes: ["phase force-completed: tool call budget exhausted"],
      recall: false,
    };
  }
  let current = state;
  const toExecute = response.toolCalls.slice(0, remaining);
  const overflow = response.toolCalls.slice(remaining);
  for (const call of toExecute) {
    const record = await executeToolCall(inputs.toolExecutor, call);
    current = {
      ...current,
      toolCallCount: current.toolCallCount + 1,
      toolCallLog: [...current.toolCallLog, record],
    };
    appended = [...appended, { role: "tool", content: record.resultSummary, toolCallId: call.id }];
  }
  const notes: string[] = [];
  if (overflow.length > 0) {
    current = appendToolRecords(
      current,
      overflow.map((call) => skippedToolCallRecord(call, "tool call budget exhausted")),
    );
    current = addTruncationReason(current, TRUNCATION_TOOL_BUDGET);
    notes.push(`${overflow.length} tool call(s) skipped: budget exhausted`);
  }
  return { state: current, messages: appended, notes, recall: true };
}

async function executeToolCall(executor: ToolExecutor, call: ToolCall): Promise<ToolCallRecord> {
  try {
    const result = await executor.execute(call);
    return { name: call.name, argumentsJson: call.argumentsJson, resultSummary: result };
  } catch (error) {
    return failedToolCallRecord(call, errorMessage(error));
  }
}

function appendToolRecords(state: LoopState, records: readonly ToolCallRecord[]): LoopState {
  return { ...state, toolCallLog: [...state.toolCallLog, ...records] };
}

function addTruncationReason(state: LoopState, reason: string): LoopState {
  return { ...state, truncationReasons: appendReason(state.truncationReasons, reason) };
}

function appendReason(reasons: readonly string[], reason: string): readonly string[] {
  return reasons.includes(reason) ? reasons : [...reasons, reason];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
