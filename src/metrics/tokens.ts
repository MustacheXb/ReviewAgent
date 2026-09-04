import type { LlmUsage } from "../contracts/llm-client.js";
import type { RunResult } from "../contracts/run.js";
import type { TokenMetrics, ToolCostPricing } from "./types.js";
import { DEFAULT_TOOL_COST_PRICING } from "./types.js";

/**
 * Token 记账与工具成本计价（口径全显式）。
 *
 * 口径（DeepSeek 语义）：
 * - uncachedInputTokens = usage.inputTokens（prompt_cache_miss_tokens）
 * - cachedInputTokens   = usage.cacheReadTokens（prompt_cache_hit_tokens）
 * - cacheWriteTokens    = usage.cacheWriteTokens（DeepSeek 不上报，通常 0；计入总输入）
 * - totalInputTokens    = 三者之和；totalTokens = totalInputTokens + outputTokens
 * - cacheHitRate        = cachedInputTokens / totalInputTokens（分母 0 → null）
 */

/** 一次 Run 的 token 记账（纯函数） */
export function computeTokenMetrics(usage: LlmUsage): TokenMetrics {
  validateUsage(usage);
  const uncachedInputTokens = usage.inputTokens;
  const cachedInputTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  const outputTokens = usage.outputTokens;
  const totalInputTokens = uncachedInputTokens + cachedInputTokens + cacheWriteTokens;
  const totalTokens = totalInputTokens + outputTokens;
  return {
    uncachedInputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    totalInputTokens,
    totalTokens,
    cacheHitRate: totalInputTokens > 0 ? cachedInputTokens / totalInputTokens : null,
  };
}

/**
 * 工具成本（token 口径）：fixedCostPerCall × 调用次数 + costPerResultChar × 结果总字符数。
 * 调用次数与结果长度均取自 audit.toolCallLog（resultSummary 的字符数即"结果长度"）。
 * 默认计价全 0（不计价）；真实计价由 Ticket 12 运行器按实验配置传入。
 */
export function computeToolCostTokens(
  run: RunResult,
  pricing: ToolCostPricing = DEFAULT_TOOL_COST_PRICING,
): number {
  validatePricing(pricing);
  const toolCallLog = run.audit.toolCallLog;
  const callCount = toolCallLog.length;
  const resultChars = toolCallLog.reduce((acc, call) => acc + call.resultSummary.length, 0);
  return pricing.fixedCostPerCall * callCount + pricing.costPerResultChar * resultChars;
}

function validateUsage(usage: LlmUsage): void {
  if (typeof usage !== "object" || usage === null) {
    throw new Error("usage must be an LlmUsage object");
  }
  requireNonNegativeInt(usage.inputTokens, "usage.inputTokens");
  requireNonNegativeInt(usage.outputTokens, "usage.outputTokens");
  if (usage.cacheReadTokens !== undefined) {
    requireNonNegativeInt(usage.cacheReadTokens, "usage.cacheReadTokens");
  }
  if (usage.cacheWriteTokens !== undefined) {
    requireNonNegativeInt(usage.cacheWriteTokens, "usage.cacheWriteTokens");
  }
}

function validatePricing(pricing: ToolCostPricing): void {
  if (typeof pricing !== "object" || pricing === null) {
    throw new Error("pricing must be a ToolCostPricing object");
  }
  requireNonNegativeNumber(pricing.fixedCostPerCall, "pricing.fixedCostPerCall");
  requireNonNegativeNumber(pricing.costPerResultChar, "pricing.costPerResultChar");
}

function requireNonNegativeInt(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer (got ${JSON.stringify(value)})`);
  }
}

function requireNonNegativeNumber(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative finite number (got ${JSON.stringify(value)})`);
  }
}
