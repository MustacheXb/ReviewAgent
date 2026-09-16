import { describe, expect, it } from "vitest";

import { profileOf } from "./profile.js";

/**
 * provider 参数画像表（#42 落地）：模型 id pattern → 画像三维度
 * （thinking 字段序列化策略、completion 信封、usage 字段能力）。
 *
 * 画像是数据契约，非 judge 专属——本表的首个消费者是 judge 链的
 * completion 信封（gpt-request-mapper），#43 的 reviewer wire 序列化器
 * 与指标分口径将消费 thinking 策略与 usage 能力声明。
 */

describe("profileOf — pattern 查表（前缀匹配，大小写不敏感）", () => {
  it("deepseek-* 命中 deepseek 画像（主力 flash / 消融 pro 同档）", () => {
    expect(profileOf("deepseek-v4-flash").thinking).toEqual({ kind: "enabled", reasoningEffort: "high" });
    expect(profileOf("deepseek-v4-pro").thinking).toEqual({ kind: "enabled", reasoningEffort: "high" });
  });

  it("glm-* 命中 glm 画像（#39 实测推理模型，completion 含 reasoning tokens）", () => {
    expect(profileOf("glm-5-3-260814").completionMaxTokens).toBe(32_768);
    expect(profileOf("GLM-5.3").completionMaxTokens).toBe(32_768);
  });

  it("未知模型回落保守默认画像（gpt / qwen / minimax / 任意自定义 id）", () => {
    for (const model of ["gpt-5.2-pro", "qwen3.8-flash", "MiniMax-M3", "some-gateway-model"]) {
      expect(profileOf(model)).toEqual({
        thinking: { kind: "omit" },
        completionMaxTokens: 8_192,
        usage: { cacheMetering: false },
      });
    }
  });

  it("前缀不匹配的相似 id 不误命中（保守回落而非家族联想）", () => {
    expect(profileOf("xglm-1").completionMaxTokens).toBe(8_192);
    expect(profileOf("my-deepseek-clone").thinking).toEqual({ kind: "omit" });
  });
});

describe("内建三档画像内容（整档锚定——加字段/改值须过目此测试）", () => {
  it("deepseek 档：thinking enabled + reasoning_effort high；不序列化 max_tokens；usage 报告缓存计量", () => {
    expect(profileOf("deepseek-v4-flash")).toEqual({
      // ADR-0002 锁定档：线上恒 thinking {type:"enabled"} + reasoning_effort "high"
      thinking: { kind: "enabled", reasoningEffort: "high" },
      // DeepSeek wire 现状：thinking 模式下不传 max_tokens（字节最小，#43 序列化器消费）
      completionMaxTokens: undefined,
      // 官方缓存计量字段 prompt_cache_hit_tokens / prompt_cache_miss_tokens
      usage: { cacheMetering: true },
    });
  });

  it("glm 档：不发 thinking 字段（推理默认开）；32768 信封；usage 报告缓存计量", () => {
    expect(profileOf("glm-5-3-260814")).toEqual({
      thinking: { kind: "omit" },
      // #39：reasoning 计入 completion 预算，实测需求 6447 的 5 倍余量
      completionMaxTokens: 32_768,
      // 网关探针实测（.cache/glm-probe.json）：prompt_tokens_details.cached_tokens
      usage: { cacheMetering: true },
    });
  });

  it("默认档：不发 thinking 字段、8192 保守信封、不声明缓存计量（Cache-Hit-Rate 记 N/A 的依据）", () => {
    expect(profileOf("totally-unknown-model")).toEqual({
      thinking: { kind: "omit" },
      completionMaxTokens: 8_192,
      usage: { cacheMetering: false },
    });
  });
});

describe("usage 能力声明（指标分口径查询面，#43 消费）", () => {
  it("声明为有缓存计量的模型族：deepseek / glm；未声明：未知模型", () => {
    expect(profileOf("deepseek-v4-flash").usage.cacheMetering).toBe(true);
    expect(profileOf("glm-5-3-260814").usage.cacheMetering).toBe(true);
    expect(profileOf("qwen3.8-flash").usage.cacheMetering).toBe(false);
  });
});
