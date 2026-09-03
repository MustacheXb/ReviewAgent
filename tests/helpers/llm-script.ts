import type { LlmResponse, LlmUsage } from "../../src/contracts/llm-client.js";

/** 测试辅助：构造 LlmResponse / LlmUsage */

export function usage(inputTokens: number, outputTokens: number, extra: Partial<LlmUsage> = {}): LlmUsage {
  return { inputTokens, outputTokens, ...extra };
}

export function reply(content: string, usageValue: LlmUsage = usage(100, 10)): LlmResponse {
  return { content, toolCalls: [], usage: usageValue };
}

export function toolCallReply(toolCalls: LlmResponse["toolCalls"], usageValue: LlmUsage = usage(100, 10)): LlmResponse {
  return { content: "", toolCalls, usage: usageValue };
}
