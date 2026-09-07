/**
 * OpenAI Chat Completions 线上契约（GPT judge 用）。
 * 事实来源：MCR-Bench 官方 call_llm.py（openai provider，temperature 0.2 / top_p 0.95 /
 * max_tokens 8192）与 OpenAI 兼容 API 通用形状；请求侧由 gpt-request-mapper 构造
 * （字段顺序固定），响应侧由 gpt-response-mapper 逐字段校验（防上游演化）。
 */

/** 请求侧消息（judge 仅用 system + user 两条） */
export type WireGptMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string };

/** POST /chat/completions 请求体（字段顺序即序列化顺序） */
export interface WireGptChatCompletionsRequest {
  readonly model: string;
  readonly messages: readonly WireGptMessage[];
  readonly temperature: number;
  readonly top_p: number;
  readonly max_tokens: number;
  readonly stream: false;
}

/** 响应侧（形状描述；运行时校验见 gpt-response-mapper） */
export interface WireGptChatCompletionsResponse {
  readonly choices?: readonly unknown[];
  readonly usage?: unknown;
}

export interface WireGptChoice {
  readonly message?: unknown;
  readonly finish_reason?: string;
}

export interface WireGptResponseMessage {
  readonly content?: string | null;
}

/** OpenAI usage 线上字段（prompt_tokens 含缓存命中；judge 侧仅作记账参考） */
export interface WireGptUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
  readonly prompt_tokens_details?: { readonly cached_tokens?: number };
}

/** 非 2xx 错误体（OpenAI 风格：{"error":{"message","type","param","code"}}） */
export interface WireGptErrorBody {
  readonly error?: {
    readonly message?: string;
    readonly type?: string;
    readonly param?: string;
    readonly code?: string;
  };
}
