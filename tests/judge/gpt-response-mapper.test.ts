import { describe, expect, it } from "vitest";
import { GptJudgeResponseFormatError } from "../../src/judge/errors.js";
import { mapGptChatCompletionsResponse } from "../../src/judge/gpt-response-mapper.js";

function wireResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    model: "gpt-5.2-pro",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "judge json" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    ...overrides,
  };
}

describe("mapGptChatCompletionsResponse — 正常路径", () => {
  it("提取 content / finishReason", () => {
    const mapped = mapGptChatCompletionsResponse(wireResponse());
    expect(mapped.content).toBe("judge json");
    expect(mapped.finishReason).toBe("stop");
  });

  it("content null（纯 tool_calls 回复形态）归一为空串", () => {
    const mapped = mapGptChatCompletionsResponse(
      wireResponse({
        choices: [{ index: 0, message: { role: "assistant", content: null }, finish_reason: "stop" }],
      }),
    );
    expect(mapped.content).toBe("");
  });
});

describe("mapGptChatCompletionsResponse — usage 口径（OpenAI → LlmUsage）", () => {
  it("inputTokens = prompt_tokens − cached_tokens，cacheReadTokens = cached_tokens", () => {
    const mapped = mapGptChatCompletionsResponse(
      wireResponse({
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 200,
          total_tokens: 1200,
          prompt_tokens_details: { cached_tokens: 400 },
        },
      }),
    );
    expect(mapped.usage).toEqual({ inputTokens: 600, outputTokens: 200, cacheReadTokens: 400 });
  });

  it("无 usage / 无 cached_tokens 字段时零值兜底", () => {
    const noUsage = mapGptChatCompletionsResponse(wireResponse({ usage: undefined }));
    expect(noUsage.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
    const noDetails = mapGptChatCompletionsResponse(
      wireResponse({ usage: { prompt_tokens: 50, completion_tokens: 5 } }),
    );
    expect(noDetails.usage).toEqual({ inputTokens: 50, outputTokens: 5, cacheReadTokens: 0 });
  });

  it("cached_tokens 超过 prompt_tokens 时 inputTokens 钳制为 0（不出现负数）", () => {
    const mapped = mapGptChatCompletionsResponse(
      wireResponse({
        usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 250 } },
      }),
    );
    expect(mapped.usage.inputTokens).toBe(0);
    expect(mapped.usage.cacheReadTokens).toBe(250);
  });
});

describe("mapGptChatCompletionsResponse — 形状校验（有界失败）", () => {
  it("根非对象 / choices 缺失 / 空数组 → 显式错误", () => {
    expect(() => mapGptChatCompletionsResponse("nope")).toThrowError(/must be a JSON object/);
    expect(() => mapGptChatCompletionsResponse({})).toThrowError(/choices must be a non-empty array/);
    expect(() => mapGptChatCompletionsResponse({ choices: [] })).toThrowError(
      /choices must be a non-empty array/,
    );
  });

  it("message 缺失 / content 非字符串 → 显式错误", () => {
    expect(() =>
      mapGptChatCompletionsResponse({ choices: [{ index: 0, finish_reason: "stop" }] }),
    ).toThrowError(/choices\[0\].message must be a JSON object/);
    expect(() =>
      mapGptChatCompletionsResponse({
        choices: [{ index: 0, message: { role: "assistant", content: 42 }, finish_reason: "stop" }],
      }),
    ).toThrowError(/content must be a string or null/);
  });

  it("usage 形状异常 → 显式错误", () => {
    expect(() =>
      mapGptChatCompletionsResponse(wireResponse({ usage: { prompt_tokens: "many" } })),
    ).toThrowError(/prompt_tokens must be a finite number/);
    expect(() =>
      mapGptChatCompletionsResponse(wireResponse({ usage: { prompt_tokens_details: "nope" } })),
    ).toThrowError(/prompt_tokens_details must be an object/);
  });

  it("错误类型为 GptJudgeResponseFormatError", () => {
    try {
      mapGptChatCompletionsResponse(null);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(GptJudgeResponseFormatError);
    }
  });
});
