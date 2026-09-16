import type { LlmUsage } from "../contracts/llm-client.js";
import type { RunResult } from "../contracts/run.js";
import { profileOf } from "review-llm";
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
 *
 * 缓存命中率口径分叉（#43，画像 usage.cacheMetering 驱动）：
 * - 模型画像声明有缓存计量字段（deepseek-* / glm-*）→ 照常计算；
 * - 模型画像声明无缓存计量 → cacheHitRate 记 null（N/A：未知 ≠ 0，
 *   provider 不上报缓存字段时误报 0 会污染跨模型对比）；
 * - model 缺省（旧记录 / DSH 路径 / 无模型信息的调用方）→ 旧口径不变。
 *   CARC 不受影响：cached 记 0 天然是保守上界（全输入按未命中计价，见 efficiency.ts）。
 */

/** 一次 Run 的 token 记账（纯函数；model 用于画像分口径，缺省走旧口径） */
export function computeTokenMetrics(usage: LlmUsage, model?: string): TokenMetrics {
  validateUsage(usage);
  const uncachedInputTokens = usage.inputTokens;
  const cachedInputTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  const outputTokens = usage.outputTokens;
  const totalInputTokens = uncachedInputTokens + cachedInputTokens + cacheWriteTokens;
  const totalTokens = totalInputTokens + outputTokens;
  const cacheHitRate =
    model !== undefined && !profileOf(model).usage.cacheMetering
      ? null
      : totalInputTokens > 0
        ? cachedInputTokens / totalInputTokens
        : null;
  return {
    uncachedInputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    totalInputTokens,
    totalTokens,
    cacheHitRate,
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
