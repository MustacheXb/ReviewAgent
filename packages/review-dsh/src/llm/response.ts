/**
 * DeepSeek 响应侧映射（ADR-0002 usage 口径，1:1 移植自薄 harness 的 response-mapper）。
 *
 * usage 计数不相交：inputTokens 只计未命中，命中单列为 cacheReadTokens；
 * DeepSeek 无写缓存计数，cacheWriteTokens 永不设置。
 * 回退链：官方 prompt_cache_hit/miss_tokens → OpenAI 网关形态
 * prompt_tokens_details.cached_tokens 拆分 → 缓存字段缺失时全零。
 *
 * mapWireResponse 逐字段校验非流式响应形状（防上游演化），reasoning_content
 * 保留（DSH ReasoningBlock 的来源；POC1 丢弃，本核内按 DSH 词汇表无损保留）。
 */

import type { FinishReason, StreamChunk, TokenUsage } from "@deepseek-ai/dsh-llm";
import { ToolCallId } from "@deepseek-ai/dsh-llm";

import { DeepSeekResponseFormatError } from "./errors.js";

/** wire 响应的 usage 对象（宽松读取：字段可选、来源两条链） */
export type WireUsage = Record<string, unknown>;

function readNumber(source: WireUsage, key: string): number | undefined {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

/** miss/hit 不相交地映射 usage；cacheReadTokens 仅在命中数 > 0 时出现 */
export function mapUsage(wire: WireUsage): TokenUsage {
  const outputTokens = readNumber(wire, "completion_tokens") ?? 0;
  const promptTokens = readNumber(wire, "prompt_tokens");

  const officialHit = readNumber(wire, "prompt_cache_hit_tokens");
  const officialMiss = readNumber(wire, "prompt_cache_miss_tokens");
  if (officialHit !== undefined || officialMiss !== undefined) {
    const miss = officialMiss ?? Math.max(0, (promptTokens ?? 0) - (officialHit ?? 0));
    const hit = officialHit ?? Math.max(0, (promptTokens ?? 0) - miss);
    return {
      inputTokens: miss,
      outputTokens,
      ...(hit > 0 ? { cacheReadTokens: hit } : {}),
    };
  }

  const details = wire["prompt_tokens_details"];
  if (isRecord(details)) {
    const cached = readNumber(details, "cached_tokens");
    if (cached !== undefined && promptTokens !== undefined) {
      const hit = Math.min(cached, promptTokens);
      const miss = Math.max(0, promptTokens - hit);
      return {
        inputTokens: miss,
        outputTokens,
        ...(hit > 0 ? { cacheReadTokens: hit } : {}),
      };
    }
  }

  return { inputTokens: 0, outputTokens };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** wire 工具调用（OpenAI 兼容形状；name 为 wire 侧映射名） */
export interface WireToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/** 一次模型调用的中性响应形状（toolCalls 携 wire 名；反解回内部名属适配器的请求侧知识） */
export interface MappedWireResponse {
  /** 可见文本（wire content null / 缺席 → ""） */
  readonly content: string;
  /** thinking 模式推理文本（无则 null） */
  readonly reasoning: string | null;
  readonly toolCalls: readonly WireToolCall[];
  /** wire usage 对象缺席时不臆造记账（undefined → 不发 usage 块） */
  readonly usage: TokenUsage | undefined;
  readonly finishReason: string | undefined;
}

/** 非流式 chat/completions 响应 → 中性形状（逐字段校验，形状异常显式抛错） */
export function mapWireResponse(wire: unknown): MappedWireResponse {
  const root = asRecord(wire, "response");
  const choices = root.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new DeepSeekResponseFormatError("response.choices must be a non-empty array");
  }
  const choice = asRecord(choices[0], "response.choices[0]");
  const message = asRecord(choice.message, "response.choices[0].message");
  return {
    content: mapContent(message.content),
    reasoning:
      optionalString(message.reasoning_content, "response.choices[0].message.reasoning_content") ?? null,
    toolCalls: mapToolCalls(message.tool_calls),
    usage:
      root.usage === undefined || root.usage === null
        ? undefined
        : mapUsage(asRecord(root.usage, "response.usage")),
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

function mapToolCalls(value: unknown): MappedWireResponse["toolCalls"] {
  if (value === null || value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new DeepSeekResponseFormatError("response.choices[0].message.tool_calls must be an array");
  }
  return value.map((entry, index) => mapToolCall(entry, `response.choices[0].message.tool_calls[${index}]`));
}

function mapToolCall(value: unknown, path: string): WireToolCall {
  const record = asRecord(value, path);
  const id = requiredString(record.id, `${path}.id`);
  const fn = asRecord(record.function, `${path}.function`);
  const name = requiredString(fn.name, `${path}.function.name`);
  const args = optionalString(fn.arguments, `${path}.function.arguments`);
  if (args === undefined) {
    throw new DeepSeekResponseFormatError(`${path}.function.arguments must be a string`);
  }
  return { id, name, arguments: args };
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

/** usage 并账（POC1 addUsage 语义：失败尝试已消耗的并入成功尝试，cached 合计为零时省略） */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const cacheRead = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
  };
}

/**
 * wire finish_reason → DSH FinishReason。
 * 未知值（content_filter 等）→ error，code = 大写原值（稳定归因）；
 * insufficient_system_resource 到不了这里（适配器先转为可重试错误）。
 */
function mapFinishReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case undefined:
    case "stop":
      return { kind: "stop" };
    case "tool_calls":
      return { kind: "tool-calls" };
    case "length":
      return { kind: "max-tokens" };
    default:
      return { kind: "error", failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() } };
  }
}

/**
 * 非流式映射结果 → StreamChunk 块序列（DSH 适配器协议：块索引递增，
 * usage 在 finish 之前，finish 后不再发块）。
 * 顺序：reasoning → text → tool-calls → [usage] → finish（thinking 先行）。
 * toolCalls 的 wire 名经 wireToInternal 反解回内部点分名；未注册名原样透传
 * （幻觉名交由 executor 的 unknown-tool 语义处理）。
 */
export function* emitResponseChunks(
  mapped: MappedWireResponse,
  wireToInternal: ReadonlyMap<string, string>,
  extraUsage?: TokenUsage,
): Generator<StreamChunk> {
  let index = 0;
  if (mapped.reasoning !== null && mapped.reasoning.length > 0) {
    yield { type: "block-start", index, blockType: "reasoning" };
    yield { type: "reasoning-delta", index, text: mapped.reasoning };
    yield { type: "block-end", index, block: { type: "reasoning", text: mapped.reasoning } };
    index += 1;
  }
  if (mapped.content.length > 0) {
    yield { type: "block-start", index, blockType: "text" };
    yield { type: "text-delta", index, text: mapped.content };
    yield { type: "block-end", index, block: { type: "text", text: mapped.content } };
    index += 1;
  }
  for (const call of mapped.toolCalls) {
    const name = wireToInternal.get(call.name) ?? call.name;
    yield { type: "block-start", index, blockType: "tool-call" };
    yield { type: "tool-call-delta", index, id: ToolCallId(call.id), name, argumentsDelta: call.arguments };
    yield {
      type: "block-end",
      index,
      block: { type: "tool-call", id: ToolCallId(call.id), name, arguments: call.arguments },
    };
    index += 1;
  }
  const usages = [extraUsage, mapped.usage].filter((usage): usage is TokenUsage => usage !== undefined);
  if (usages.length > 0) {
    yield { type: "usage", usage: usages.reduce(addUsage) };
  }
  yield { type: "finish", reason: mapFinishReason(mapped.finishReason) };
}
