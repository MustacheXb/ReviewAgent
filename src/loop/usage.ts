import type { LlmUsage } from "../contracts/llm-client.js";

/** 零值 usage（累计起点） */
export const ZERO_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0 };

/** 纯函数累加：返回新对象，不改写入参 */
export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  const hasCacheRead = a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined;
  const hasCacheWrite = a.cacheWriteTokens !== undefined || b.cacheWriteTokens !== undefined;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(hasCacheRead ? { cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0) } : {}),
    ...(hasCacheWrite ? { cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0) } : {}),
  };
}
