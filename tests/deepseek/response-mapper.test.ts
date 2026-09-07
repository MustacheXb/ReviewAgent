import { describe, expect, it } from "vitest";
import { mapChatCompletionsResponse } from "../../src/deepseek/response-mapper.js";
import { DeepSeekResponseFormatError } from "../../src/deepseek/errors.js";
import { wireChatCompletion } from "../helpers/deepseek-stub.js";

describe("mapChatCompletionsResponse — usage accounting (miss / hit split)", () => {
  it("maps prompt_cache_miss_tokens to inputTokens and prompt_cache_hit_tokens to cacheReadTokens", () => {
    const wire = wireChatCompletion({
      content: "ok",
      usage: {
        prompt_tokens: 24,
        prompt_cache_hit_tokens: 16,
        prompt_cache_miss_tokens: 8,
        completion_tokens: 12,
        total_tokens: 36,
      },
    });
    const { response } = mapChatCompletionsResponse(wire);
    expect(response.usage).toEqual({ inputTokens: 8, outputTokens: 12, cacheReadTokens: 16 });
  });

  it("never invents cacheWriteTokens: DeepSeek usage has no such field (no double counting)", () => {
    const wire = wireChatCompletion({
      content: "ok",
      usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6, completion_tokens: 2 },
    });
    const { response } = mapChatCompletionsResponse(wire);
    expect(response.usage).not.toHaveProperty("cacheWriteTokens");
  });

  it("handles the cold-start edge: full miss, zero hit", () => {
    const { response } = mapChatCompletionsResponse(
      wireChatCompletion({
        usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100, completion_tokens: 5 },
      }),
    );
    expect(response.usage).toEqual({ inputTokens: 100, outputTokens: 5, cacheReadTokens: 0 });
  });

  it("defaults every usage field to 0 when usage is absent or empty (upstream-evolution tolerance)", () => {
    for (const usage of [undefined, {}]) {
      const { response } = mapChatCompletionsResponse(wireChatCompletion({ usage }));
      expect(response.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
    }
  });

  it("rejects usage fields of the wrong type", () => {
    const wire = {
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_cache_miss_tokens: "8" },
    };
    expect(() => mapChatCompletionsResponse(wire)).toThrowError(DeepSeekResponseFormatError);
    expect(() => mapChatCompletionsResponse(wire)).toThrowError(/prompt_cache_miss_tokens must be a finite number/);
  });
});

describe("mapChatCompletionsResponse — message and tool calls", () => {
  it("maps content, tool calls (arguments passed through byte-for-byte) and finish reason", () => {
    const wire = wireChatCompletion({
      content: "checking",
      toolCalls: [
        {
          id: "call_0",
          type: "function",
          function: { name: "review.get_symbol", arguments: '{"symbol":"MathUtils"}' },
        },
      ],
      finishReason: "tool_calls",
    });
    const { response, finishReason } = mapChatCompletionsResponse(wire);
    expect(response.content).toBe("checking");
    expect(response.toolCalls).toEqual([
      { id: "call_0", name: "review.get_symbol", argumentsJson: '{"symbol":"MathUtils"}' },
    ]);
    expect(finishReason).toBe("tool_calls");
  });

  it("maps null/absent content to an empty string and absent tool calls to an empty array", () => {
    const nullContent = mapChatCompletionsResponse({ choices: [{ message: { content: null } }] });
    expect(nullContent.response.content).toBe("");
    expect(nullContent.response.toolCalls).toEqual([]);

    const noContent = mapChatCompletionsResponse({ choices: [{ message: {} }] });
    expect(noContent.response.content).toBe("");
    expect(noContent.response.toolCalls).toEqual([]);
  });

  it("exposes finish_reason values used for retry decisions", () => {
    expect(mapChatCompletionsResponse(wireChatCompletion({ finishReason: "insufficient_system_resource" })).finishReason).toBe(
      "insufficient_system_resource",
    );
    expect(mapChatCompletionsResponse({ choices: [{ message: { content: "ok" } }] }).finishReason).toBeUndefined();
  });
});

describe("mapChatCompletionsResponse — malformed response bodies", () => {
  it("rejects bodies without choices or with an empty choices array", () => {
    for (const wire of [{ id: "x" }, { choices: [] }]) {
      expect(() => mapChatCompletionsResponse(wire)).toThrowError(/choices must be a non-empty array/);
    }
  });

  it("rejects choices whose message is missing or not an object", () => {
    expect(() => mapChatCompletionsResponse({ choices: [{}] })).toThrowError(
      /choices\[0\]\.message must be a JSON object/,
    );
    expect(() => mapChatCompletionsResponse({ choices: [{ message: "text" }] })).toThrowError(
      /choices\[0\]\.message must be a JSON object/,
    );
  });

  it("rejects non-string content", () => {
    expect(() => mapChatCompletionsResponse({ choices: [{ message: { content: 42 } }] })).toThrowError(
      /content must be a string or null/,
    );
  });

  it("rejects malformed tool call entries with a path-qualified error", () => {
    const wire = {
      choices: [
        {
          message: {
            content: "",
            tool_calls: [{ id: "call_0", function: { name: "review.get_file" } }],
          },
        },
      ],
    };
    expect(() => mapChatCompletionsResponse(wire)).toThrowError(
      /tool_calls\[0\]\.function\.arguments must be a string/,
    );
  });

  it("rejects a non-object body", () => {
    for (const wire of [null, "text", 42, []]) {
      expect(() => mapChatCompletionsResponse(wire)).toThrowError(/must be a JSON object/);
    }
  });
});
