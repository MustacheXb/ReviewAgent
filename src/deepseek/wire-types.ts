/**
 * DeepSeek Chat Completions 的线上契约（OpenAI 兼容 + DeepSeek 扩展字段）。
 * 事实来源：docs/adr/0002 与研究笔记 deepseek-api-client.md（api-docs.deepseek.com，2026-09-03）。
 *
 * 请求侧类型由 request-mapper 构造（字段顺序固定 → 请求字节稳定，缓存可归因）；
 * 响应侧类型只描述形状，运行时由 response-mapper 逐字段校验（防上游演化）。
 */

/** 请求侧消息（OpenAI chat 格式）。assistant 轮不回传 reasoning_content：契约 LlmMessage 无该字段（见 T04 完成报告）。 */
export type WireMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string | null;
      readonly tool_calls?: readonly WireRequestToolCall[];
    }
  | { readonly role: "tool"; readonly content: string; readonly tool_call_id: string };

/** 请求侧 tool call 回传（arguments 为模型产出的原始 JSON 字符串，原样字节回传） */
export interface WireRequestToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

/** 请求侧工具 schema（ToolSchema.parametersJson 反序列化为 JSON Schema 对象） */
export interface WireTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

/** POST /chat/completions 请求体（字段顺序即序列化顺序） */
export interface WireChatCompletionsRequest {
  readonly model: string;
  readonly messages: readonly WireMessage[];
  /** ADR-0002：thinking 默认档，显式传（字节可审计，勿依赖服务端默认） */
  readonly thinking: { readonly type: "enabled" };
  readonly reasoning_effort: "high";
  readonly tools?: readonly WireTool[];
  readonly tool_choice?: "auto";
  readonly stream: false;
}

/** 响应侧（形状描述；运行时校验见 response-mapper） */
export interface WireChatCompletionsResponse {
  readonly id?: string;
  readonly model?: string;
  readonly system_fingerprint?: string;
  readonly choices?: readonly unknown[];
  readonly usage?: unknown;
}

export interface WireChoice {
  readonly message?: unknown;
  readonly finish_reason?: string;
}

export interface WireAssistantMessage {
  readonly content?: string | null;
  readonly reasoning_content?: string | null;
  readonly tool_calls?: readonly unknown[];
}

export interface WireResponseToolCall {
  readonly id?: string;
  readonly type?: string;
  readonly function?: { readonly name?: string; readonly arguments?: string };
}

/**
 * usage 线上字段（非流式下五个字段均为 required，解析侧按 optional 容错）。
 * 缓存口径：prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens；
 * DeepSeek 无 cache write 计数字段。
 */
export interface WireUsage {
  readonly prompt_tokens?: number;
  readonly prompt_cache_hit_tokens?: number;
  readonly prompt_cache_miss_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
  readonly completion_tokens_details?: { readonly reasoning_tokens?: number };
}

/** 非 2xx 错误体（OpenAI 风格：{"error":{"message","type","param","code"}}） */
export interface WireErrorBody {
  readonly error?: {
    readonly message?: string;
    readonly type?: string;
    readonly param?: string;
    readonly code?: string;
  };
}
