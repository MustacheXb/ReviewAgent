import type { ConfigId } from "./config.js";
import type { Finding } from "./finding.js";
import type { LedgerEntry } from "./ledger.js";
import type { LlmRequest, LlmUsage } from "./llm-client.js";
import type { PrefetchLayerRecord } from "./prefetch.js";

/**
 * runReview(config, mrCase, llmClient) → RunResult 的输出契约（spec #1）。
 * 硬上界：max_rounds = 5，max_tool_calls = 6。
 */

/** 六阶段骨架的固定阶段名（顺序见 loop/phases.ts 的 PHASE_ORDER） */
export type ReviewPhase =
  | "Change Understanding"
  | "Risk Classification"
  | "Context Decision"
  | "Context Retrieval"
  | "Deep Reasoning"
  | "Evidence Verification";

export interface RunResult {
  readonly caseId: string;
  readonly configId: ConfigId;
  readonly findings: readonly Finding[];
  /** 本次 Run 累计 */
  readonly usage: LlmUsage;
  /** 实际执行的循环轮数（≤ 5） */
  readonly rounds: number;
  /** 实际发生的工具调用数（≤ 6） */
  readonly toolCalls: number;
  /** 审计痕迹：发出的每个请求（字节可重放）+ 工具调用序列 */
  readonly audit: RunAudit;
  /** 审计文件落盘路径（未落盘时缺省） */
  readonly auditPath?: string;
}

export interface RunAudit {
  readonly requests: readonly LlmRequest[];
  readonly toolCallLog: readonly ToolCallRecord[];
  /** 六阶段骨架的实际执行轨迹（证明阶段顺序固定） */
  readonly phaseLog: readonly PhaseRecord[];
  /** Evidence Gate 等候选拦截记录（No Evidence, No Finding 的留痕） */
  readonly rejections: readonly CandidateRejection[];
  /** 是否被硬上界截断 */
  readonly truncated: boolean;
  /** 截断原因（MAX_ROUNDS_REACHED / TOOL_BUDGET_EXHAUSTED） */
  readonly truncationReasons: readonly string[];
  /** config B（及未来复用预取的配置）的注入层记账：预算、截断、条目数（工单 #4 扩展字段） */
  readonly prefetch?: readonly PrefetchLayerRecord[];
  /** config C 全仓注入的记账：预算守卫、截断、文件数（工单 #6 扩展字段） */
  readonly fullRepo?: FullRepoRecord;
  /** config E Context Ledger 的登记快照（工单 #8 扩展字段；非 ledger 配置与显式工具覆盖缺省） */
  readonly ledger?: readonly LedgerEntry[];
}

/** config C 全仓注入的留痕（超限截断必须显式，不静默丢弃） */
export interface FullRepoRecord {
  readonly budgetChars: number;
  /** 最终注入内容的字符数（含截断提示） */
  readonly contentChars: number;
  readonly truncated: boolean;
  /** 快照内 Java 文件总数 */
  readonly totalFiles: number;
  /** 实际注入文件数（含被行级截断的尾文件） */
  readonly shownFiles: number;
}

export interface ToolCallRecord {
  readonly name: string;
  readonly argumentsJson: string;
  readonly resultSummary: string;
}

/** 一个阶段的执行记录 */
export interface PhaseRecord {
  readonly round: number;
  readonly phase: ReviewPhase;
  /** 本阶段消耗的 LLM 请求数 */
  readonly requestCount: number;
  /** 阶段异常说明（回复解析失败 / 工具被禁用 / 预算耗尽等） */
  readonly note?: string;
}

/** 候选结论被拦截的留痕 */
export interface CandidateRejection {
  readonly candidateId: string;
  readonly stage: RejectionStage;
  /** 英文的拦截原因 */
  readonly reason: string;
}

/** 拦截阶段：Schema 校验 → 语言检查 → 证据检查 → 验证裁决 */
export type RejectionStage =
  | "SCHEMA_INVALID"
  | "NON_ENGLISH"
  | "NO_EVIDENCE"
  | "VERIFICATION_FAILED"
  | "DUPLICATE_ID";
