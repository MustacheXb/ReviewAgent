import type { LlmMessage, LlmRequest, ToolCall, ToolSchema } from "../contracts/llm-client.js";
import { DeepSeekClientError } from "./errors.js";
import type {
  WireChatCompletionsRequest,
  WireMessage,
  WireRequestToolCall,
  WireTool,
} from "./wire-types.js";

/**
 * LlmRequest → DeepSeek Chat Completions 请求体（纯函数）。
 * 请求字节纪律：字段顺序固定、effort/thinking 在客户端层锁定（ADR-0002）、
 * temperature/top_p/penalties/max_tokens 一律不传（thinking 模式下无效或无必要，保持字节最小）。
 */

/**
 * 客户端支持的 model id 白名单（ADR-0002 主力 deepseek-v4-flash；deepseek-v4-pro 仅用于
 * 高险子集升级消融，spec #1 user story 15，实验计划层强制搭配 highRiskOnly）。
 * deepseek-chat / deepseek-reasoner 已于 2026-07-24 退役，禁止出现。
 */
export const SUPPORTED_MODELS: readonly string[] = ["deepseek-v4-flash", "deepseek-v4-pro"];

/** harness 侧唯一合法的 effort 标签（runReview 默认档） */
export const LOCKED_EFFORT_LABEL = "default";

/** 锁定档位的线上字节：thinking 默认档 = enabled + reasoning_effort "high"（研究笔记结论） */
export const LOCKED_REASONING_EFFORT = "high";
export const LOCKED_THINKING = { type: "enabled" } as const;

const VALID_ROLES: ReadonlySet<string> = new Set(["system", "user", "assistant", "tool"]);

export function buildChatCompletionsBody(request: LlmRequest): WireChatCompletionsRequest {
  validateModel(request.model);
  validateEffortLabel(request.effort);
  validateMessages(request.messages);
  validateTools(request.tools);
  return {
    model: request.model,
    messages: request.messages.map(mapMessage),
    thinking: LOCKED_THINKING,
    reasoning_effort: LOCKED_REASONING_EFFORT,
    ...(request.tools.length > 0
      ? { tools: request.tools.map(mapTool), tool_choice: "auto" as const }
      : {}),
    stream: false as const,
  };
}

function validateModel(model: unknown): void {
  if (typeof model !== "string" || !SUPPORTED_MODELS.includes(model)) {
    throw new DeepSeekClientError(
      `unsupported model ${JSON.stringify(model)}: the DeepSeek client supports ${SUPPORTED_MODELS.map((m) => JSON.stringify(m)).join(", ")} (ADR-0002; deepseek-v4-pro is restricted to the high-risk-subset ablation at the experiment plan layer; deepseek-chat / deepseek-reasoner were retired on 2026-07-24 and must not be used)`,
    );
  }
}

function validateEffortLabel(effort: unknown): void {
  if (effort !== LOCKED_EFFORT_LABEL) {
    throw new DeepSeekClientError(
      `effort is locked at the client layer (ADR-0002 single effort gear): got ${JSON.stringify(effort)}, expected ${JSON.stringify(LOCKED_EFFORT_LABEL)}; the locked gear always serializes to thinking {type:"enabled"} + reasoning_effort ${JSON.stringify(LOCKED_REASONING_EFFORT)}, so the experiment cannot drift`,
    );
  }
}

function validateMessages(messages: unknown): void {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new DeepSeekClientError("request.messages must be a non-empty array of LlmMessage");
  }
  messages.forEach((message, index) => validateMessage(message, `request.messages[${index}]`));
}

function validateMessage(message: unknown, path: string): void {
  if (typeof message !== "object" || message === null) {
    throw new DeepSeekClientError(`${path} must be an LlmMessage object`);
  }
  const record = message as Partial<LlmMessage>;
  if (typeof record.role !== "string" || !VALID_ROLES.has(record.role)) {
    throw new DeepSeekClientError(
      `${path}.role must be one of "system", "user", "assistant", "tool" (got ${JSON.stringify(record.role)})`,
    );
  }
  if (typeof record.content !== "string") {
    throw new DeepSeekClientError(`${path}.content must be a string`);
  }
  if (record.role === "tool" && (typeof record.toolCallId !== "string" || record.toolCallId.length === 0)) {
    throw new DeepSeekClientError(`${path}.toolCallId must be a non-empty string for role "tool"`);
  }
  if (record.role !== "assistant" && record.toolCalls !== undefined) {
    throw new DeepSeekClientError(`${path}.toolCalls is only allowed on assistant messages`);
  }
  if (record.toolCalls !== undefined) {
    if (!Array.isArray(record.toolCalls)) {
      throw new DeepSeekClientError(`${path}.toolCalls must be an array of ToolCall`);
    }
    record.toolCalls.forEach((call, callIndex) => validateToolCall(call, `${path}.toolCalls[${callIndex}]`));
  }
}

function validateToolCall(call: unknown, path: string): void {
  if (typeof call !== "object" || call === null) {
    throw new DeepSeekClientError(`${path} must be a ToolCall object`);
  }
  const record = call as Partial<ToolCall>;
  if (typeof record.id !== "string" || record.id.length === 0) {
    throw new DeepSeekClientError(`${path}.id must be a non-empty string`);
  }
  if (typeof record.name !== "string" || record.name.length === 0) {
    throw new DeepSeekClientError(`${path}.name must be a non-empty string`);
  }
  if (typeof record.argumentsJson !== "string") {
    throw new DeepSeekClientError(`${path}.argumentsJson must be a string`);
  }
  try {
    JSON.parse(record.argumentsJson);
  } catch (error) {
    throw new DeepSeekClientError(
      `${path}.argumentsJson is not valid JSON: ${record.argumentsJson.slice(0, 80)}`,
      { cause: error },
    );
  }
}

function validateTools(tools: unknown): void {
  if (!Array.isArray(tools)) {
    throw new DeepSeekClientError("request.tools must be an array of ToolSchema");
  }
  tools.forEach((tool, index) => validateTool(tool, `request.tools[${index}]`));
}

function validateTool(tool: unknown, path: string): void {
  if (typeof tool !== "object" || tool === null) {
    throw new DeepSeekClientError(`${path} must be a ToolSchema object`);
  }
  const record = tool as Partial<ToolSchema>;
  if (typeof record.name !== "string" || record.name.length === 0) {
    throw new DeepSeekClientError(`${path}.name must be a non-empty string`);
  }
  if (typeof record.description !== "string" || record.description.length === 0) {
    throw new DeepSeekClientError(`${path}.description must be a non-empty string`);
  }
  if (typeof record.parametersJson !== "string" || record.parametersJson.length === 0) {
    throw new DeepSeekClientError(`${path}.parametersJson must be a non-empty JSON string`);
  }
  const parsed = tryParseJson(record.parametersJson);
  if (parsed === undefined || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DeepSeekClientError(`${path}.parametersJson must serialize to a JSON object`);
  }
}

function mapMessage(message: LlmMessage): WireMessage {
  if (message.role === "tool") {
    if (message.toolCallId === undefined || message.toolCallId.length === 0) {
      throw new DeepSeekClientError('tool message is missing toolCallId');
    }
    return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
  }
  if (message.role === "assistant") {
    const toolCalls = message.toolCalls ?? [];
    if (toolCalls.length === 0) {
      return { role: "assistant", content: message.content };
    }
    return {
      role: "assistant",
      content: message.content.length > 0 ? message.content : null,
      tool_calls: toolCalls.map(mapToolCall),
    };
  }
  if (message.role === "system") {
    return { role: "system", content: message.content };
  }
  return { role: "user", content: message.content };
}

function mapToolCall(call: ToolCall): WireRequestToolCall {
  return {
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: call.argumentsJson },
  };
}

function mapTool(tool: ToolSchema): WireTool {
  const parameters = tryParseJson(tool.parametersJson);
  if (parameters === undefined || typeof parameters !== "object" || parameters === null || Array.isArray(parameters)) {
    throw new DeepSeekClientError(`request.tools parametersJson for ${JSON.stringify(tool.name)} must serialize to a JSON object`);
  }
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: parameters as Record<string, unknown>,
    },
  };
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
