/**
 * OpenAI Chat Completions 响应 → judge 客户端中间形状（纯函数，逐字段校验）。
 * usage 口径映射到共享 LlmUsage 形状（inputTokens = prompt_tokens 的未命中部分；
 * OpenAI 的 prompt_tokens_details.cached_tokens 为命中部分）。
 */

import type { LlmUsage } from "../contracts/llm-client.js";
import { GptJudgeResponseFormatError } from "./errors.js";

export interface MappedGptResponse {
  /** 助手回复正文（judge 裁定 JSON 文本） */
  readonly content: string;
  readonly finishReason: string | undefined;
  readonly usage: LlmUsage;
}

const ZERO_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

export function mapGptChatCompletionsResponse(wire: unknown): MappedGptResponse {
  const root = asRecord(wire, "response");
  const choices = root.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new GptJudgeResponseFormatError("response.choices must be a non-empty array");
  }
  const choice = asRecord(choices[0], "response.choices[0]");
  const message = asRecord(choice.message, "response.choices[0].message");
  return {
    content: mapContent(message.content),
    finishReason: optionalString(choice.finish_reason, "response.choices[0].finish_reason"),
    usage: mapUsage(root.usage),
  };
}

function mapContent(content: unknown): string {
  if (content === null || content === undefined) {
    return "";
  }
  if (typeof content !== "string") {
    throw new GptJudgeResponseFormatError(
      `response.choices[0].message.content must be a string or null (got ${typeof content})`,
    );
  }
  return content;
}

function mapUsage(value: unknown): LlmUsage {
  if (value === null || value === undefined) {
    return ZERO_USAGE;
  }
  const record = asRecord(value, "response.usage");
  const promptTokens = optionalFiniteNumber(record.prompt_tokens, "response.usage.prompt_tokens") ?? 0;
  const cachedTokens =
    cachedTokensOf(record.prompt_tokens_details) ?? 0;
  const outputTokens =
    optionalFiniteNumber(record.completion_tokens, "response.usage.completion_tokens") ?? 0;
  return {
    inputTokens: Math.max(0, promptTokens - cachedTokens),
    outputTokens,
    cacheReadTokens: cachedTokens,
  };
}

function cachedTokensOf(details: unknown): number | undefined {
  if (details === null || details === undefined) {
    return undefined;
  }
  if (typeof details !== "object" || Array.isArray(details)) {
    throw new GptJudgeResponseFormatError("response.usage.prompt_tokens_details must be an object");
  }
  return optionalFiniteNumber(
    (details as { readonly cached_tokens?: unknown }).cached_tokens,
    "response.usage.prompt_tokens_details.cached_tokens",
  );
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GptJudgeResponseFormatError(`${path} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new GptJudgeResponseFormatError(`${path} must be a string`);
  }
  return value;
}

function optionalFiniteNumber(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GptJudgeResponseFormatError(`${path} must be a finite number`);
  }
  return value;
}
