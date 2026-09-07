/**
 * 主 seam 契约（spec #1 Testing Decisions）：
 * FakeLlmClient 与真实 DeepSeek 客户端实现同一接口；
 * 测试通过可编程 fake 脚本化回复并捕获收到的每个 LlmRequest（请求字节）。
 */

export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  /** JSON Schema 序列化（字节稳定：由注册表固定字段顺序） */
  readonly parametersJson: string;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly argumentsJson: string;
}

export interface LlmMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly toolCallId?: string;
}

/** 一次模型请求（主 seam 的观测对象：请求字节 = 序列化后的全部字段） */
export interface LlmRequest {
  readonly model: string;
  readonly effort: string;
  readonly messages: readonly LlmMessage[];
  /** A/B 为空数组；C/D/E 为同一套 7 个 review.* 工具 schema（字节一致） */
  readonly tools: readonly ToolSchema[];
}

export interface LlmUsage {
  /** 未命中缓存的输入 token（DeepSeek prompt_cache_miss_tokens） */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** 命中缓存的输入 token（prompt_cache_hit_tokens） */
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export interface LlmResponse {
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: LlmUsage;
}

export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResponse>;
}
