/**
 * Judge 客户端错误分类（镜像 src/deepseek/errors.ts 的模式）。
 * 错误信息只包含状态码与服务端返回的 message/code，绝不包含 API key 或请求头。
 */

/** 基类：请求构造错（卡片/上下文校验失败）、模型异构约束违反等不可重试错误 */
export class JudgeClientError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "JudgeClientError";
  }
}

/** HTTP 层错误（非 2xx）。retryable 仅限可安全重试的状态码 */
export class GptJudgeHttpError extends JudgeClientError {
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
    this.name = "GptJudgeHttpError";
    this.status = args.status;
    this.retryable = args.retryable;
    this.errorCode = args.errorCode;
  }
}

/** 网络层错误（连接失败 / DNS / 传输中断 / 超时），可安全重试 */
export class GptJudgeNetworkError extends JudgeClientError {
  readonly timedOut: boolean;

  constructor(args: {
    readonly message: string;
    readonly timedOut: boolean;
    readonly cause?: unknown;
  }) {
    super(args.message, args.cause === undefined ? undefined : { cause: args.cause });
    this.name = "GptJudgeNetworkError";
    this.timedOut = args.timedOut;
  }
}

/** 响应体异常（非法 JSON / 形状不符 / 无法提取匹配裁定），不可重试 */
export class GptJudgeResponseFormatError extends JudgeClientError {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "GptJudgeResponseFormatError";
  }
}

/** 可安全重试的 HTTP 状态码（与 DeepSeek 客户端同口径：429 限流 / 500 / 503 过载） */
export const RETRYABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([429, 500, 503]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUSES.has(status);
}

/** 重试决策：仅 HTTP 可重试状态与网络/超时错误重试；请求构造错与响应体异常直接抛 */
export function isRetryableJudgeError(error: unknown): boolean {
  if (error instanceof GptJudgeHttpError) {
    return error.retryable;
  }
  if (error instanceof GptJudgeNetworkError) {
    return true;
  }
  return false;
}
