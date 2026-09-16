import { describe, expect, it } from "vitest";
import type { LlmMessage, LlmRequest } from "../../src/contracts/llm-client.js";
import { buildChatCompletionsBody } from "../../src/deepseek/request-mapper.js";

/**
 * DeepSeek 默认路径的 golden 字节回归（#43 发布硬门槛）。
 *
 * 自定义 LLM 接入（#40）让 reviewer 的 wire 序列化器改由 provider 画像表驱动
 * （thinking / reasoning_effort / max_tokens）；本文件把 DeepSeek 默认路径
 * （deepseek-v4-flash / deepseek-v4-pro）的请求体字节逐字节钉死——任何重构
 * 若改变这些字节（字段顺序、字段在场性、取值），此处必须红。
 *
 * 字节纪律的依据：请求前缀字节是缓存归因（Cache Break 留痕）与既有实验
 * 可比性的地基（ADR-0002；spec #40「DeepSeek 默认路径请求字节不变」承诺）。
 * golden 字符串 = JSON.stringify(buildChatCompletionsBody(...)) 的完整输出，
 * 手工展开成模板字面量以便 review diff 逐字节可见。
 */

function baseRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: "deepseek-v4-flash",
    effort: "default",
    messages: [
      { role: "system", content: "system prompt" },
      { role: "user", content: "phase instruction" },
    ],
    tools: [],
    ...overrides,
  };
}

const TOOL = {
  name: "review.get_symbol",
  description: "Get a symbol definition",
  parametersJson: '{"type":"object","properties":{"symbol":{"type":"string"}},"required":["symbol"]}',
};

/** 六阶段循环的真实消息形态样本（assistant 带工具调用 + tool 回传轮） */
const LOOP_MESSAGES: readonly LlmMessage[] = [
  { role: "system", content: "system prompt" },
  { role: "user", content: "phase instruction" },
  {
    role: "assistant" as const,
    content: "",
    toolCalls: [{ id: "call_0", name: "review.get_symbol", argumentsJson: '{"symbol":"MathUtils"}' }],
  },
  { role: "tool" as const, content: "symbol body", toolCallId: "call_0" },
];

describe("golden bytes — DeepSeek 默认路径请求体（发布硬门槛）", () => {
  it("deepseek-v4-flash 零工具（config A/B 形态）：字节逐字节钉死", () => {
    const golden =
      '{"model":"deepseek-v4-flash",' +
      '"messages":[{"role":"system","content":"system prompt"},{"role":"user","content":"phase instruction"}],' +
      '"thinking":{"type":"enabled"},' +
      '"reasoning_effort":"high",' +
      '"stream":false}';
    expect(JSON.stringify(buildChatCompletionsBody(baseRequest()))).toBe(golden);
  });

  it("deepseek-v4-flash 带工具（config C/D/E 形态）：工具 schema 与 tool_choice 字节钉死", () => {
    const golden =
      '{"model":"deepseek-v4-flash",' +
      '"messages":[{"role":"system","content":"system prompt"},{"role":"user","content":"phase instruction"}],' +
      '"thinking":{"type":"enabled"},' +
      '"reasoning_effort":"high",' +
      '"tools":[{"type":"function","function":{"name":"review_get_symbol","description":"Get a symbol definition",' +
      '"parameters":{"type":"object","properties":{"symbol":{"type":"string"}},"required":["symbol"]}}}],' +
      '"tool_choice":"auto",' +
      '"stream":false}';
    expect(JSON.stringify(buildChatCompletionsBody(baseRequest({ tools: [TOOL] })))).toBe(golden);
  });

  it("deepseek-v4-flash 循环中段（assistant 工具调用 + tool 回传）：消息序列字节钉死", () => {
    const golden =
      '{"model":"deepseek-v4-flash",' +
      '"messages":[{"role":"system","content":"system prompt"},{"role":"user","content":"phase instruction"},' +
      '{"role":"assistant","content":null,"tool_calls":[{"id":"call_0","type":"function",' +
      '"function":{"name":"review_get_symbol","arguments":"{\\"symbol\\":\\"MathUtils\\"}"}}]},' +
      '{"role":"tool","content":"symbol body","tool_call_id":"call_0"}],' +
      '"thinking":{"type":"enabled"},' +
      '"reasoning_effort":"high",' +
      '"stream":false}';
    expect(JSON.stringify(buildChatCompletionsBody(baseRequest({ messages: LOOP_MESSAGES })))).toBe(golden);
  });

  it("deepseek-v4-pro（高险子集消融档）：与主力档同一锁定字节纪律，仅 model 字段不同", () => {
    const golden =
      '{"model":"deepseek-v4-pro",' +
      '"messages":[{"role":"system","content":"system prompt"},{"role":"user","content":"phase instruction"}],' +
      '"thinking":{"type":"enabled"},' +
      '"reasoning_effort":"high",' +
      '"stream":false}';
    expect(JSON.stringify(buildChatCompletionsBody(baseRequest({ model: "deepseek-v4-pro" })))).toBe(golden);
  });

  it("字节稳定性：同一请求重复构造逐字节一致（缓存归因前提）", () => {
    const first = JSON.stringify(buildChatCompletionsBody(baseRequest({ tools: [TOOL] })));
    const second = JSON.stringify(buildChatCompletionsBody(baseRequest({ tools: [TOOL] })));
    expect(first).toBe(second);
  });
});
