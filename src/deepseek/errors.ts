import type { LlmUsage } from "../contracts/llm-client.js";

/**
 * DeepSeek 客户端错误分类。
 * 错误信息只包含状态码与服务端返回的 message/code，绝不包含 API key 或请求头。
 */

/** 基类：请求构造错（model/effort/messages/tools 校验失败）等不可重试错误 */
export class DeepSeekClientError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "DeepSeekClientError";
  }
}

/** HTTP 层错误（非 2xx）。retryable 仅限可安全重试的状态码 */
export class DeepSeekHttpError extends DeepSeekClientError {
  readonly status: number;
  readonly retryable: boolean;
  readonly errorCode?: string | undefined;

  constructor(args: {
    readonly status: number;
    readonly message: string;
    readonly errorCode?: string | undefined;
    readonly retryable: boolean;
  }) {
    super(args.message);
    this.name = "DeepSeekHttpError";
    this.status = args.status;
    this.retryable = args.retryable;
    this.errorCode = args.errorCode;
  }
}

/** 网络层错误（连接失败 / DNS / 传输中断 / 超时），可安全重试 */
export class DeepSeekNetworkError extends DeepSeekClientError {
  readonly timedOut: boolean;

  constructor(args: {
    readonly message: string;
    readonly timedOut: boolean;
    readonly cause?: unknown;
  }) {
    super(args.message, args.cause === undefined ? undefined : { cause: args.cause });
    this.name = "DeepSeekNetworkError";
    this.timedOut = args.timedOut;
  }
}

/**
 * 200 但 finish_reason=insufficient_system_resource（DeepSeek 特有的瞬时过载信号）。
 * 可安全重试；该次尝试已消耗的 usage 附在错误上，重试成功后并入记账（真实成本不丢）。
 */
export class DeepSeekInsufficientResourceError extends DeepSeekClientError {
  readonly usage?: LlmUsage | undefined;

  constructor(usage: LlmUsage | undefined) {
    super(
      'DeepSeek API returned finish_reason "insufficient_system_resource" (transient server overload); the attempt is retried when budget remains',
    );
    this.name = "DeepSeekInsufficientResourceError";
    this.usage = usage;
  }
}

/** 响应体异常（非法 JSON / 形状不符），不可重试 */
export class DeepSeekResponseFormatError extends DeepSeekClientError {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "DeepSeekResponseFormatError";
  }
}

/** 可安全重试的 HTTP 状态码（研究笔记：429 限流 / 500 / 503 过载；其余直接抛） */
export const RETRYABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([429, 500, 503]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUSES.has(status);
}

/** 重试决策：仅 HTTP 可重试状态、网络/超时错误与 insufficient_system_resource 重试；请求构造错与响应体异常直接抛 */
export function isRetryableDeepSeekError(error: unknown): boolean {
  if (error instanceof DeepSeekHttpError) {
    return error.retryable;
  }
  if (error instanceof DeepSeekNetworkError) {
    return true;
  }
  if (error instanceof DeepSeekInsufficientResourceError) {
    return true;
  }
  return false;
}

/** 失败尝试已消耗的 usage（目前仅 insufficient_system_resource 携带） */
export function usageOfError(error: unknown): LlmUsage | undefined {
  return error instanceof DeepSeekInsufficientResourceError ? error.usage : undefined;
}
