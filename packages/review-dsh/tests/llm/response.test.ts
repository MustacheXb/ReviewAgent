import { describe, expect, it } from "vitest";

import { mapUsage } from "../../src/llm/response.js";

function wireUsage(fields: Record<string, unknown>): Record<string, unknown> {
  return fields;
}

describe("mapUsage（ADR-0002 usage 口径：miss/hit 不相交）", () => {
  it("官方口径优先：inputTokens ← prompt_cache_miss_tokens，cacheReadTokens ← prompt_cache_hit_tokens", () => {
    const usage = mapUsage(
      wireUsage({
        prompt_tokens: 1000,
        prompt_cache_hit_tokens: 700,
        prompt_cache_miss_tokens: 300,
        completion_tokens: 42,
        total_tokens: 1042,
      }),
    );

    expect(usage).toEqual({
      inputTokens: 300,
      outputTokens: 42,
      cacheReadTokens: 700,
    });
  });

  it("网关 OpenAI 形态回退：cached_tokens 拆分，miss + hit = prompt_tokens", () => {
    const usage = mapUsage(
      wireUsage({
        prompt_tokens: 1000,
        prompt_tokens_details: { cached_tokens: 800 },
        completion_tokens: 10,
      }),
    );

    expect(usage).toEqual({
      inputTokens: 200,
      outputTokens: 10,
      cacheReadTokens: 800,
    });
  });

  it("缓存字段缺失时全零，不臆造 cacheReadTokens", () => {
    const usage = mapUsage(wireUsage({ prompt_tokens: 500, completion_tokens: 5 }));

    expect(usage).toEqual({ inputTokens: 0, outputTokens: 5 });
  });

  it("cached 超过 prompt_tokens 时夹紧（miss 不为负）", () => {
    const usage = mapUsage(
      wireUsage({
        prompt_tokens: 100,
        prompt_tokens_details: { cached_tokens: 150 },
        completion_tokens: 5,
      }),
    );

    expect(usage).toEqual({
      inputTokens: 0,
      outputTokens: 5,
      cacheReadTokens: 100,
    });
  });
});
