import type { LlmResponse, ToolCall } from "../contracts/llm-client.js";
import { DeepSeekResponseFormatError } from "./errors.js";

/**
 * DeepSeek Chat Completions 响应 → LlmResponse（纯函数，逐字段校验，响应体异常显式抛错）。
 *
 * usage 口径对账（契约 llm-client.ts 注释为准，miss / hit 二分，不重复计数）：
 * - inputTokens   ← prompt_cache_miss_tokens（未命中缓存的输入 token）
 * - cacheReadTokens ← prompt_cache_hit_tokens（命中缓存的输入 token）
 * - cacheWriteTokens：DeepSeek usage 无对应字段 → 保持缺省（不映射、不虚增）
 * - outputTokens  ← completion_tokens（含思考 token，与 CARC 输出口径一致）
 */

export interface MappedChatCompletions {
  readonly response: LlmResponse;
  readonly finishReason: string | undefined;
}

const ZERO_USAGE: LlmResponse["usage"] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

export function mapChatCompletionsResponse(wire: unknown): MappedChatCompletions {
  const root = asRecord(wire, "response");
  const choices = root.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new DeepSeekResponseFormatError("response.choices must be a non-empty array");
  }
  const choice = asRecord(choices[0], "response.choices[0]");
  const message = asRecord(choice.message, "response.choices[0].message");
  return {
    response: {
      content: mapContent(message.content),
      toolCalls: mapToolCalls(message.tool_calls),
      usage: mapUsage(root.usage),
    },
    finishReason: optionalString(choice.finish_reason, "response.choices[0].finish_reason"),
  };
}

function mapContent(content: unknown): string {
  if (content === null || content === undefined) {
    return "";
  }
  if (typeof content !== "string") {
    throw new DeepSeekResponseFormatError(
      `response.choices[0].message.content must be a string or null (got ${typeof content})`,
    );
  }
  return content;
}

function mapToolCalls(value: unknown): readonly ToolCall[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new DeepSeekResponseFormatError("response.choices[0].message.tool_calls must be an array");
  }
  return value.map((entry, index) => mapToolCall(entry, `response.choices[0].message.tool_calls[${index}]`));
}

function mapToolCall(value: unknown, path: string): ToolCall {
  const record = asRecord(value, path);
  const id = requiredString(record.id, `${path}.id`);
  const fn = asRecord(record.function, `${path}.function`);
  const name = requiredString(fn.name, `${path}.function.name`);
  const args = optionalString(fn.arguments, `${path}.function.arguments`);
  if (args === undefined) {
    throw new DeepSeekResponseFormatError(`${path}.function.arguments must be a string`);
  }
  return { id, name, argumentsJson: args };
}

function mapUsage(value: unknown): LlmResponse["usage"] {
  if (value === null || value === undefined) {
    return ZERO_USAGE;
  }
  const record = asRecord(value, "response.usage");
  return {
    inputTokens: optionalFiniteNumber(record.prompt_cache_miss_tokens, "response.usage.prompt_cache_miss_tokens") ?? 0,
    outputTokens: optionalFiniteNumber(record.completion_tokens, "response.usage.completion_tokens") ?? 0,
    cacheReadTokens: optionalFiniteNumber(record.prompt_cache_hit_tokens, "response.usage.prompt_cache_hit_tokens") ?? 0,
  };
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DeepSeekResponseFormatError(`${path} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DeepSeekResponseFormatError(`${path} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new DeepSeekResponseFormatError(`${path} must be a string`);
  }
  return value;
}

function optionalFiniteNumber(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DeepSeekResponseFormatError(`${path} must be a finite number`);
  }
  return value;
}
