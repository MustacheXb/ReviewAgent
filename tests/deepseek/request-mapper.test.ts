import { describe, expect, it } from "vitest";
import type { LlmRequest } from "../../src/contracts/llm-client.js";
import {
  buildChatCompletionsBody,
  LOCKED_EFFORT_LABEL,
} from "../../src/deepseek/request-mapper.js";

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

describe("buildChatCompletionsBody — locked experiment bytes", () => {
  it("pins model, thinking, reasoning_effort and stream in the wire body", () => {
    const body = buildChatCompletionsBody(baseRequest());
    expect(body.model).toBe("deepseek-v4-flash");
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("high");
    expect(body.stream).toBe(false);
  });

  it("keeps request bytes stable: identical requests serialize identically", () => {
    const first = JSON.stringify(buildChatCompletionsBody(baseRequest()));
    const second = JSON.stringify(buildChatCompletionsBody(baseRequest()));
    expect(first).toBe(second);
  });

  it("omits every sampling parameter that is void in thinking mode", () => {
    const body = buildChatCompletionsBody(baseRequest()) as unknown as Record<string, unknown>;
    for (const absent of ["temperature", "top_p", "presence_penalty", "frequency_penalty", "max_tokens"]) {
      expect(body, `${absent} must not be sent`).not.toHaveProperty(absent);
    }
  });

  it("rejects effort labels that would drift the locked gear (ADR-0002)", () => {
    for (const effort of ["low", "high", "max", "", undefined]) {
      expect(
        () => buildChatCompletionsBody(baseRequest({ effort: effort as string })),
        `effort ${JSON.stringify(effort)} must be rejected`,
      ).toThrowError(/effort is locked at the client layer/);
    }
  });

  it("accepts only the locked harness effort label", () => {
    expect(LOCKED_EFFORT_LABEL).toBe("default");
    expect(() => buildChatCompletionsBody(baseRequest({ effort: "default" }))).not.toThrow();
  });

  it("rejects unsupported model ids, including retired deepseek-chat / deepseek-reasoner", () => {
    for (const model of ["deepseek-chat", "deepseek-reasoner", "gpt-4o", ""]) {
      expect(() => buildChatCompletionsBody(baseRequest({ model })), `model ${model} must be rejected`).toThrowError(
        /unsupported model .*deepseek-v4-flash/,
      );
    }
  });
});

describe("buildChatCompletionsBody — messages serialization", () => {
  it("maps system / user / assistant / tool messages to the OpenAI wire format", () => {
    const request = baseRequest({
      messages: [
        { role: "system", content: "You are a reviewer." },
        { role: "user", content: "Review this MR." },
        { role: "assistant", content: "Understood, starting review." },
        { role: "assistant", content: "", toolCalls: [{ id: "call_0", name: "review.get_symbol", argumentsJson: '{"symbol":"MathUtils"}' }] },
        { role: "tool", content: "symbol body", toolCallId: "call_0" },
      ],
    });
    const body = buildChatCompletionsBody(request);
    expect(body.messages).toEqual([
      { role: "system", content: "You are a reviewer." },
      { role: "user", content: "Review this MR." },
      { role: "assistant", content: "Understood, starting review." },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_0",
            type: "function",
            function: { name: "review.get_symbol", arguments: '{"symbol":"MathUtils"}' },
          },
        ],
      },
      { role: "tool", content: "symbol body", tool_call_id: "call_0" },
    ]);
  });

  it("keeps assistant content when it accompanies tool calls", () => {
    const request = baseRequest({
      messages: [
        { role: "assistant", content: "checking", toolCalls: [{ id: "call_1", name: "review.get_file", argumentsJson: "{}" }] },
      ],
    });
    expect(buildChatCompletionsBody(request).messages).toEqual([
      {
        role: "assistant",
        content: "checking",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "review.get_file", arguments: "{}" } },
        ],
      },
    ]);
  });

  it("treats an empty toolCalls array as a plain assistant message", () => {
    const request = baseRequest({
      messages: [{ role: "assistant", content: "done", toolCalls: [] }],
    });
    expect(buildChatCompletionsBody(request).messages).toEqual([
      { role: "assistant", content: "done" },
    ]);
  });

  it("validates message shape: empty list, bad role, missing toolCallId, malformed argumentsJson", () => {
    expect(() => buildChatCompletionsBody(baseRequest({ messages: [] }))).toThrowError(
      /messages must be a non-empty array/,
    );
    expect(
      () => buildChatCompletionsBody(baseRequest({ messages: [{ role: "developer" as never, content: "x" }] })),
    ).toThrowError(/role must be one of/);
    expect(
      () => buildChatCompletionsBody(baseRequest({ messages: [{ role: "tool", content: "x", toolCallId: "" }] })),
    ).toThrowError(/toolCallId must be a non-empty string/);
    expect(
      () =>
        buildChatCompletionsBody(
          baseRequest({
            messages: [
              { role: "assistant", content: "", toolCalls: [{ id: "c", name: "n", argumentsJson: "{nope" }] },
            ],
          }),
        ),
    ).toThrowError(/argumentsJson is not valid JSON/);
  });
});

describe("buildChatCompletionsBody — tools serialization", () => {
  const tool = {
    name: "review.get_symbol",
    description: "Get a symbol definition",
    parametersJson: '{"type":"object","properties":{"symbol":{"type":"string"}},"required":["symbol"]}',
  };

  it("parses parametersJson into the JSON Schema object and sets tool_choice auto", () => {
    const body = buildChatCompletionsBody(baseRequest({ tools: [tool] }));
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "review.get_symbol",
          description: "Get a symbol definition",
          parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
        },
      },
    ]);
    expect(body.tool_choice).toBe("auto");
  });

  it("omits tools and tool_choice entirely for zero-tool configurations (A/B)", () => {
    const body = buildChatCompletionsBody(baseRequest({ tools: [] })) as unknown as Record<string, unknown>;
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
  });

  it("keeps tool schema bytes stable across calls", () => {
    const first = JSON.stringify(buildChatCompletionsBody(baseRequest({ tools: [tool] })).tools);
    const second = JSON.stringify(buildChatCompletionsBody(baseRequest({ tools: [tool] })).tools);
    expect(first).toBe(second);
  });

  it("validates tool schema shape and requires parametersJson to be a JSON object", () => {
    expect(() => buildChatCompletionsBody(baseRequest({ tools: [{ ...tool, name: "" }] }))).toThrowError(
      /tools\[0\]\.name must be a non-empty string/,
    );
    expect(() => buildChatCompletionsBody(baseRequest({ tools: [{ ...tool, parametersJson: "[]" }] }))).toThrowError(
      /parametersJson must serialize to a JSON object/,
    );
    expect(() => buildChatCompletionsBody(baseRequest({ tools: [{ ...tool, parametersJson: "{oops" }] }))).toThrowError(
      /parametersJson must serialize to a JSON object/,
    );
  });
});
