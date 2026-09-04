import type { EfficiencyMetrics, PRFMetrics, TokenMetrics } from "./types.js";

/**
 * 派生效率指标（主文档第 7 章）：
 * - RIE（Review Intelligence Efficiency）= line-level Recall × Precision / (Total Tokens / 1K)
 *   除零显式处理：totalTokens = 0 → null；Recall/Precision 任一 null → null。
 * - CARC（Cache-adjusted Review Cost）= 非缓存输入 + 输出 + 工具成本（token 口径）
 *   = uncachedInputTokens + cacheWriteTokens + outputTokens + toolCostTokens。
 *   缓存命中（cachedInputTokens）不计入；cacheWriteTokens 属非缓存命中输入，计入。
 */
export function computeEfficiencyMetrics(input: {
  readonly lineLevel: PRFMetrics;
  readonly tokens: TokenMetrics;
  readonly toolCostTokens: number;
}): EfficiencyMetrics {
  const { recall, precision } = input.lineLevel;
  const rie =
    recall !== null && precision !== null && input.tokens.totalTokens > 0
      ? (recall * precision) / (input.tokens.totalTokens / 1000)
      : null;
  const carc =
    input.tokens.uncachedInputTokens +
    input.tokens.cacheWriteTokens +
    input.tokens.outputTokens +
    input.toolCostTokens;
  return { rie, carc };
}
