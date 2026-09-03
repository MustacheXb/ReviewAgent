import type { ConfigId } from "./config.js";
import type { Finding } from "./finding.js";
import type { LlmRequest, LlmUsage } from "./llm-client.js";

/**
 * runReview(config, mrCase, llmClient) → RunResult 的输出契约（spec #1）。
 * 硬上界：max_rounds = 5，max_tool_calls = 6。
 */

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
}

export interface RunAudit {
  readonly requests: readonly LlmRequest[];
  readonly toolCallLog: readonly ToolCallRecord[];
}

export interface ToolCallRecord {
  readonly name: string;
  readonly argumentsJson: string;
  readonly resultSummary: string;
}
