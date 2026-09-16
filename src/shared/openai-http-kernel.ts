/**
 * OpenAI 兼容 HTTP 内核（DeepSeek 主客户端与 GPT judge 客户端共享，去重自两份
 * 镜像实现的 fetch/重试/脱敏/解析代码）。
 *
 * 覆盖：POST fetch（Bearer 鉴权 + JSON 体 + AbortSignal 超时）、有界重试 +
 * 指数退避、网络/HTTP/响应格式错误构造、API key 脱敏、JSON 解析、服务端
 * error.message / error.code 提取。
 *
 * 参数化边界（内核不知道具体服务商）：
 * - 服务标签（错误消息前缀，如 "DeepSeek API" / "OpenAI API"）；
 * - 错误工厂（各客户端注入自有错误类型，保持 instanceof / name 语义不变）。
 *
 * endpoint/key 解析已收敛至 review-llm 共享包（#41；双包单源），
 * 本文件不再持有解析函数。
 *
 * 模型白名单不属于 HTTP 内核：留在各请求映射器（deepseek 与 gpt 的模型
 * 约束语义不同源——前者退役 id 拒绝，后者要求与被测模型异构）。
 *
 * 纪律：key 绝不硬编码、绝不出现在错误信息中（redact 兜底服务端回显）。
 */

/** HTTP 层错误参数（与各客户端 HttpError 构造器同形） */
export interface HttpErrorArgs {
  readonly status: number;
  readonly message: string;
  readonly errorCode?: string | undefined;
  readonly retryable: boolean;
}

/** 网络层错误参数（与各客户端 NetworkError 构造器同形） */
export interface NetworkErrorArgs {
  readonly message: string;
  readonly timedOut: boolean;
  readonly cause?: unknown;
}

/** 内核构造异常时使用的错误工厂（由各客户端注入自有类型） */
export interface HttpKernelErrorFactories {
  /** 选项校验失败等本地错误（客户端基类） */
  readonly clientError: (message: string) => Error;
  readonly networkError: (args: NetworkErrorArgs) => Error;
  readonly httpError: (args: HttpErrorArgs) => Error;
  readonly responseFormatError: (message: string, options?: { readonly cause?: unknown }) => Error;
  /** HTTP 状态码是否可安全重试（各客户端同口径：429/500/503） */
  readonly isRetryableStatus: (status: number) => boolean;
}

/** 内核配置（各客户端构造期装配；构造期校验由模块级 helper 完成） */
export interface OpenAiHttpKernelOptions {
  /** 服务标签：错误消息前缀（"DeepSeek API" / "OpenAI API"） */
  readonly serviceLabel: string;
  readonly endpointUrl: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly fetchFn: typeof fetch;
  readonly errors: HttpKernelErrorFactories;
}

const ERROR_MESSAGE_SNIPPET_LENGTH = 300;
const INVALID_JSON_SNIPPET_LENGTH = 120;

export class OpenAiHttpKernel {
  private readonly serviceLabel: string;
  private readonly endpointUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly errors: HttpKernelErrorFactories;

  constructor(options: OpenAiHttpKernelOptions) {
    this.serviceLabel = options.serviceLabel;
    this.endpointUrl = options.endpointUrl;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs;
    this.fetchFn = options.fetchFn;
    this.errors = options.errors;
  }

  /** POST JSON（Bearer 鉴权 + 超时中断）；fetch 抛出的网络/超时异常统一映射为 networkError */
  async postJson(body: unknown): Promise<Response> {
    try {
      return await this.fetchFn(this.endpointUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw this.errors.networkError({
        message: this.redact(
          isTimeoutError(error)
            ? `${this.serviceLabel} request timed out after ${this.timeoutMs}ms`
            : `${this.serviceLabel} network error: ${errorMessage(error)}`,
        ),
        timedOut: isTimeoutError(error),
        cause: error,
      });
    }
  }

  /** 读取响应体文本；读取失败映射为 networkError */
  async readBodyText(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch (error) {
      throw this.errors.networkError({
        message: this.redact(`${this.serviceLabel} response body could not be read: ${errorMessage(error)}`),
        timedOut: false,
        cause: error,
      });
    }
  }

  /** 解析响应体 JSON；非法 JSON 映射为 responseFormatError（截断防日志爆炸） */
  parseJsonBody(text: string): unknown {
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw this.errors.responseFormatError(
        this.redact(`response body is not valid JSON: ${truncate(collapseWhitespace(text), INVALID_JSON_SNIPPET_LENGTH)}`),
        { cause: error },
      );
    }
  }

  /** 非 2xx → httpError（服务端 error.message 优先，含脱敏与可重试标记） */
  async httpErrorFrom(response: Response): Promise<Error> {
    const text = await response.text().catch(() => "");
    const serverMessage = extractServerError(text);
    const fallback = response.statusText.length > 0 ? response.statusText : `HTTP ${response.status}`;
    return this.errors.httpError({
      status: response.status,
      message: this.redact(
        `${this.serviceLabel} HTTP ${response.status}: ${truncate(serverMessage ?? fallback, ERROR_MESSAGE_SNIPPET_LENGTH)}`,
      ),
      errorCode: extractServerErrorCode(text),
      retryable: this.errors.isRetryableStatus(response.status),
    });
  }

  /** 错误信息脱敏：key 若被服务端/异常文本回显，一律替换为 [REDACTED] */
  redact(message: string): string {
    return this.apiKey.length > 0 ? message.split(this.apiKey).join("[REDACTED]") : message;
  }
}

/** 有界重试循环（总尝试 = 1 + maxRetries）；onError 在每次失败后、重试决策前回调（DeepSeek 用途：累计失败尝试已消耗的 usage） */
export async function runWithRetries<T>(options: {
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
  readonly sleepFn: (ms: number) => Promise<void>;
  readonly isRetryable: (error: unknown) => boolean;
  readonly onError?: (error: unknown) => void;
  readonly operation: () => Promise<T>;
}): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await options.operation();
    } catch (error) {
      options.onError?.(error);
      if (attempt >= options.maxRetries || !options.isRetryable(error)) {
        throw error;
      }
      await options.sleepFn(backoffDelayMs(options.retryBaseDelayMs, attempt));
      attempt++;
    }
  }
}

/** 指数退避：第 n 次重试等待 base * 2^n */
export function backoffDelayMs(base: number, attempt: number): number {
  return base * 2 ** attempt;
}

/** 缺省 sleep 注入（生产路径；测试注入零等待替身） */
export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const name = (error as { readonly name?: unknown }).name;
  return name === "TimeoutError" || name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractServerError(text: string): string | undefined {
  const parsed = tryParseJson(text);
  if (parsed === undefined || typeof parsed !== "object" || parsed === null) {
    const trimmed = collapseWhitespace(text).trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  const message = (parsed as { readonly error?: { readonly message?: unknown } }).error?.message;
  return typeof message === "string" && message.length > 0 ? message : undefined;
}

function extractServerErrorCode(text: string): string | undefined {
  const parsed = tryParseJson(text);
  if (parsed === undefined || typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const code = (parsed as { readonly error?: { readonly code?: unknown } }).error?.code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}
