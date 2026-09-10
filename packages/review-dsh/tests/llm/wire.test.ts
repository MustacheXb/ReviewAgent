import { describe, expect, it } from "vitest";

import type { GenerateOptions } from "@deepseek-ai/dsh-llm";
import { createAssistantMessage, createUserMessage } from "@deepseek-ai/dsh-llm";

import { buildChatCompletionsBody } from "../../src/llm/wire.js";

function userMessage(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [{ type: "text", text }],
    source: { kind: "user" },
  });
}

function baseOptions(
  messages: GenerateOptions["messages"],
): GenerateOptions {
  return {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    messages,
    system: "system prompt bytes",
  };
}

describe("buildChatCompletionsBody（ADR-0002 wire 契约）", () => {
  it("config A 形态：零工具请求体键序 model → messages → thinking → reasoning_effort → stream，tools 整体省略", () => {
    const body = buildChatCompletionsBody(
      baseOptions([userMessage("Merge request under review."), userMessage("Phase 1 of 6 - Change Understanding.")]),
    );

    expect(Object.keys(body)).toEqual(["model", "messages", "thinking", "reasoning_effort", "stream"]);
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("high");
    expect(body.stream).toBe(false);
    expect("tools" in body).toBe(false);
    expect("tool_choice" in body).toBe(false);
  });

  it("不发送任何采样参数（temperature / top_p / presence_penalty / frequency_penalty / max_tokens 一律缺席）", () => {
    const body = buildChatCompletionsBody(baseOptions([userMessage("x")]));

    expect("temperature" in body).toBe(false);
    expect("top_p" in body).toBe(false);
    expect("presence_penalty" in body).toBe(false);
    expect("frequency_penalty" in body).toBe(false);
    expect("max_tokens" in body).toBe(false);
  });

  it("system 落在 messages[0]（system 槽），DSH user 消息映射为 wire user", () => {
    const body = buildChatCompletionsBody(baseOptions([userMessage("hello")]), "Zone A bytes");

    expect(body.messages).toEqual([
      { role: "system", content: "Zone A bytes" },
      { role: "user", content: "hello" },
    ]);
  });

  it("assistant 文本消息映射为 wire assistant，content 透传", () => {
    const assistant = createAssistantMessage({
      content: [{ type: "text", text: '{"summary":"changed url encoding"}' }],
      source: { provider: "deepseek", model: "deepseek-v4-flash" },
    });
    const body = buildChatCompletionsBody(baseOptions([userMessage("q"), assistant]));

    expect(body.messages).toEqual([
      { role: "system", content: "system prompt bytes" },
      { role: "user", content: "q" },
      { role: "assistant", content: '{"summary":"changed url encoding"}' },
    ]);
  });

  it("带工具 schema 时键序 model → messages → thinking → reasoning_effort → tools → tool_choice → stream，review.* 映射为 review_*", () => {
    const body = buildChatCompletionsBody({
      ...baseOptions([userMessage("q")]),
      tools: [
        {
          name: "review.get_diff",
          description: "Get the MR diff.",
          parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        },
      ],
    });

    expect(Object.keys(body)).toEqual([
      "model",
      "messages",
      "thinking",
      "reasoning_effort",
      "tools",
      "tool_choice",
      "stream",
    ]);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "review_get_diff",
          description: "Get the MR diff.",
          parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        },
      },
    ]);
    expect(body.tool_choice).toBe("auto");
  });
});
