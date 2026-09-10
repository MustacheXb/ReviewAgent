/**
 * DeepSeek 响应侧映射（ADR-0002 usage 口径，1:1 移植自薄 harness 的 response-mapper）。
 *
 * usage 计数不相交：inputTokens 只计未命中，命中单列为 cacheReadTokens；
 * DeepSeek 无写缓存计数，cacheWriteTokens 永不设置。
 * 回退链：官方 prompt_cache_hit/miss_tokens → OpenAI 网关形态
 * prompt_tokens_details.cached_tokens 拆分 → 缓存字段缺失时全零。
 */

import type { TokenUsage } from "@deepseek-ai/dsh-llm";

/** wire 响应的 usage 对象（宽松读取：字段可选、来源两条链） */
export type WireUsage = Record<string, unknown>;

function readNumber(source: WireUsage, key: string): number | undefined {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

/** miss/hit 不相交地映射 usage；cacheReadTokens 仅在命中数 > 0 时出现 */
export function mapUsage(wire: WireUsage): TokenUsage {
  const outputTokens = readNumber(wire, "completion_tokens") ?? 0;
  const promptTokens = readNumber(wire, "prompt_tokens");

  const officialHit = readNumber(wire, "prompt_cache_hit_tokens");
  const officialMiss = readNumber(wire, "prompt_cache_miss_tokens");
  if (officialHit !== undefined || officialMiss !== undefined) {
    const miss = officialMiss ?? Math.max(0, (promptTokens ?? 0) - (officialHit ?? 0));
    const hit = officialHit ?? Math.max(0, (promptTokens ?? 0) - miss);
    return {
      inputTokens: miss,
      outputTokens,
      ...(hit > 0 ? { cacheReadTokens: hit } : {}),
    };
  }

  const details = wire["prompt_tokens_details"];
  if (isRecord(details)) {
    const cached = readNumber(details, "cached_tokens");
    if (cached !== undefined && promptTokens !== undefined) {
      const hit = Math.min(cached, promptTokens);
      const miss = Math.max(0, promptTokens - hit);
      return {
        inputTokens: miss,
        outputTokens,
        ...(hit > 0 ? { cacheReadTokens: hit } : {}),
      };
    }
  }

  return { inputTokens: 0, outputTokens };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
