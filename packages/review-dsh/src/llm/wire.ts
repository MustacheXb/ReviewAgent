/**
 * chat/completions wire 契约（键序骨架移植自 ADR-0002 冻结薄 harness，消费线
 * npm 0.1.2-rc.1；非 deepseek 画像差异由本层吸收，ADR-0002）。
 *
 * 请求体在序列化点即字节确定：键序 model → messages → [thinking →
 * reasoning_effort] → [max_tokens] → [tools → tool_choice] → stream，
 * 采样参数一律不发。骨架移植自冻结薄 harness 的 src/deepseek/wire-types.ts
 * 与 request-mapper.ts，输入从 POC1 的 LlmMessage 适配为 DSH 的
 * Message/ToolSchema。
 *
 * #45 起序列化策略由 provider 画像表驱动（review-llm profileOf，与 POC1
 * request-mapper 同一单源）：thinking / reasoning_effort 只在画像声明
 * enabled 时出场（DeepSeek 锁定档），max_tokens 按画像信封补齐。双包对
 * 同一逻辑请求的逐字节一致由 tests/llm/wire-parity.test.ts 钉死。
 */

import type { ContentBlock, GenerateOptions, Message, TextBlock, ToolCallBlock, ToolResultBlock, ToolSchema } from "@deepseek-ai/dsh-llm";

import { profileOf } from "review-llm";

/** 锁定档位的线上字节：thinking 默认档 = enabled + reasoning_effort "high"（ADR-0002 单档） */
export const LOCKED_EFFORT_LABEL = "default";
export const LOCKED_REASONING_EFFORT = "high";
export const LOCKED_THINKING = { type: "enabled" } as const;

/** 本适配器实测可用的 DeepSeek 官方模型（listModels 建议性清单，非准入白名单——#45 起准入由画像表 + 退役清单决定） */
export const SUPPORTED_MODELS: readonly string[] = ["deepseek-v4-flash", "deepseek-v4-pro"];

/** POST /chat/completions 请求体（字段顺序即序列化顺序） */
export interface WireChatCompletionsRequest {
  readonly model: string;
  readonly messages: readonly WireMessage[];
  /** ADR-0002：thinking 默认档，显式传（字节可审计，勿依赖服务端默认）。画像 omit 档整体不发（#45）。 */
  readonly thinking?: { readonly type: "enabled" };
  readonly reasoning_effort?: "high";
  /** completion 信封（画像声明时序列化；DeepSeek thinking wire 不传，#45） */
  readonly max_tokens?: number;
  readonly tools?: readonly WireTool[];
  readonly tool_choice?: "auto";
  readonly stream: false;
}

/** 请求侧消息（OpenAI chat 格式）。assistant 轮不回传 reasoning_content（POC1 契约无该字段）。 */
export type WireMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string | null; readonly tool_calls?: readonly WireRequestToolCall[] }
  | { readonly role: "tool"; readonly content: string; readonly tool_call_id: string };

export interface WireRequestToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface WireTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

/** `review.*` → `review_*`：DSH 工具名允许点号，DeepSeek 函数名只允许 [a-zA-Z0-9_-] */
export function toWireToolName(name: string): string {
  return name.split(".").join("_");
}

/** wire 名 → 内部名的反查表；重名或非法 wire 名 fail fast（POC1 语义） */
export function buildWireToolNameMap(tools: readonly ToolSchema[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const tool of tools) {
    const wireName = toWireToolName(tool.name);
    const existing = map.get(wireName);
    if (existing !== undefined && existing !== tool.name) {
      throw new Error(`tool name collision after wire mapping: ${wireName} maps to both ${existing} and ${tool.name}`);
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(wireName)) {
      throw new Error(`wire tool name must match ^[a-zA-Z0-9_-]+$: got ${JSON.stringify(wireName)}`);
    }
    map.set(wireName, tool.name);
  }
  return map;
}

function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === "text";
}

function isToolCallBlock(block: ContentBlock): block is ToolCallBlock {
  return block.type === "tool-call";
}

function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
  return block.type === "tool-result";
}

/** DSH Message → 按 "\n" 连接的纯文本；无 text 块时 null（wire 与审计共用的投影） */
export function joinTextBlocks(message: Message): string | null {
  const texts = message.content.filter(isTextBlock).map((block) => block.text);
  if (texts.length === 0) {
    return null;
  }
  return texts.join("\n");
}

/** DSH Message 序列（含 system 槽）→ wire messages；一条 DSH 消息可投影多条 wire 消息（tool 结果独立成行） */
export function toWireMessages(options: GenerateOptions): readonly WireMessage[] {
  const wire: WireMessage[] = [];
  if (options.system !== undefined) {
    wire.push({ role: "system", content: options.system });
  }
  for (const message of options.messages) {
    if (message.role === "assistant") {
      const toolCalls = message.content.filter(isToolCallBlock).map((block) => ({
        id: block.id,
        type: "function" as const,
        function: { name: toWireToolName(block.name), arguments: block.arguments },
      }));
      const content = joinTextBlocks(message);
      wire.push(
        toolCalls.length > 0
          ? { role: "assistant", content, tool_calls: toolCalls }
          : { role: "assistant", content },
      );
      continue;
    }
    const toolResults = message.content.filter(isToolResultBlock);
    if (toolResults.length > 0) {
      for (const result of toolResults) {
        const text = result.content
          .filter(isTextBlock)
          .map((block) => block.text)
          .join("\n");
        wire.push({ role: "tool", content: text, tool_call_id: result.toolCallId });
      }
      continue;
    }
    const content = joinTextBlocks(message);
    if (content !== null) {
      wire.push({ role: "user", content });
    }
  }
  return wire;
}

/**
 * 组装 chat/completions 请求体。字段顺序即 JSON.stringify 的序列化顺序；
 * 零工具时 tools/tool_choice 整体省略（不发空数组）。thinking 档与
 * max_tokens 信封由画像表分派（#45），键序与 POC1 request-mapper 逐位对齐。
 */
export function buildChatCompletionsBody(
  options: GenerateOptions,
  system?: string,
): WireChatCompletionsRequest {
  const profile = profileOf(options.model);
  const messages = toWireMessages(system !== undefined ? { ...options, system } : options);
  const tools: readonly WireTool[] = (options.tools ?? []).map((tool) => ({
    type: "function",
    function: {
      name: toWireToolName(tool.name),
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
  const body: WireChatCompletionsRequest = {
    model: options.model,
    messages,
    ...(profile.thinking.kind === "enabled"
      ? { thinking: LOCKED_THINKING, reasoning_effort: profile.thinking.reasoningEffort }
      : {}),
    ...(profile.completionMaxTokens !== undefined ? { max_tokens: profile.completionMaxTokens } : {}),
    ...(tools.length > 0 ? { tools, tool_choice: "auto" as const } : {}),
    stream: false,
  };
  return body;
}
