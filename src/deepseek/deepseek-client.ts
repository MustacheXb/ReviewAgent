import type { LlmClient, LlmRequest, LlmResponse, LlmUsage } from "../contracts/llm-client.js";
import { addUsage } from "../loop/usage.js";
import {
  DeepSeekClientError,
  DeepSeekHttpError,
  DeepSeekInsufficientResourceError,
  DeepSeekNetworkError,
  DeepSeekResponseFormatError,
  isRetryableDeepSeekError,
  isRetryableStatus,
  usageOfError,
} from "./errors.js";
import { buildChatCompletionsBody } from "./request-mapper.js";
import { mapChatCompletionsResponse } from "./response-mapper.js";
import type { WireChatCompletionsRequest } from "./wire-types.js";

/**
 * 真实 DeepSeek 客户端（原生 fetch，OpenAI 兼容 chat completions，无 SDK——研究笔记结论：
 * POC1 需要精确控制请求字节，自拼 JSON 是唯一干净做法）。
 *
 * 锁定纪律（ADR-0002）：
 * - model 白名单 = deepseek-v4-flash（request-mapper 校验，退役 id 直接拒绝）；
 * - effort 单档锁定：harness effort 标签仅接受 "default"，线上恒为 thinking {type:"enabled"} + reasoning_effort "high"；
 * - API key 仅经 DEEPSEEK_API_KEY 环境变量或显式参数注入，绝不硬编码、绝不出现在错误信息中。
 */

export const DEEPSEEK_API_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_API_KEY_ENV_VAR = "DEEPSEEK_API_KEY";
export const DEFAULT_DEEPSEEK_TIMEOUT_MS = 600_000;
export const DEFAULT_DEEPSEEK_MAX_RETRIES = 3;
export const DEFAULT_DEEPSEEK_RETRY_BASE_DELAY_MS = 1_000;

const CHAT_COMPLETIONS_PATH = "/chat/completions";
const ERROR_MESSAGE_SNIPPET_LENGTH = 300;

export interface DeepSeekClientOptions {
  /** API key；缺省读环境变量 DEEPSEEK_API_KEY（启动即校验，缺失 fail fast） */
  readonly apiKey?: string;
  /** API base URL；缺省 https://api.deepseek.com（测试可注入本地地址） */
  readonly baseUrl?: string;
  /** 单次请求超时（毫秒）；缺省 600_000（thinking 模式长思考，超时给足） */
  readonly timeoutMs?: number;
  /** 可安全重试错误的有界重试次数；缺省 3（总尝试 = 1 + maxRetries） */
  readonly maxRetries?: number;
  /** 指数退避基数（毫秒）；缺省 1_000（第 n 次重试等待 base * 2^n） */
  readonly retryBaseDelayMs?: number;
  /** fetch 注入（单元测试零网络） */
  readonly fetchFn?: typeof fetch;
  /** sleep 注入（单元测试零等待） */
  readonly sleepFn?: (ms: number) => Promise<void>;
}

export class DeepSeekClient implements LlmClient {
  private readonly apiKey: string;
  private readonly endpointUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(options: DeepSeekClientOptions = {}) {
    this.apiKey = resolveApiKey(options.apiKey);
    this.endpointUrl = resolveEndpointUrl(options.baseUrl);
    this.timeoutMs = positiveIntOption(options.timeoutMs, DEFAULT_DEEPSEEK_TIMEOUT_MS, "timeoutMs");
    this.maxRetries = nonNegativeIntOption(options.maxRetries, DEFAULT_DEEPSEEK_MAX_RETRIES, "maxRetries");
    this.retryBaseDelayMs = nonNegativeIntOption(
      options.retryBaseDelayMs,
      DEFAULT_DEEPSEEK_RETRY_BASE_DELAY_MS,
      "retryBaseDelayMs",
    );
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleepFn = options.sleepFn ?? sleepMs;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    // 请求体构造/校验失败：立即抛（本地错误，重试无意义）
    const body = buildChatCompletionsBody(request);
    let consumed: LlmUsage | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        const wire = await this.fetchWire(body);
        const mapped = mapChatCompletionsResponse(wire);
        if (mapped.finishReason === "insufficient_system_resource") {
          throw new DeepSeekInsufficientResourceError(mapped.response.usage);
        }
        return consumed === undefined
          ? mapped.response
          : { ...mapped.response, usage: addUsage(consumed, mapped.response.usage) };
      } catch (error) {
        const wasted = usageOfError(error);
        if (wasted !== undefined) {
          consumed = consumed === undefined ? wasted : addUsage(consumed, wasted);
        }
        if (attempt >= this.maxRetries || !isRetryableDeepSeekError(error)) {
          throw error;
        }
        await this.sleepFn(backoffDelayMs(this.retryBaseDelayMs, attempt));
      }
    }
  }

  private async fetchWire(body: WireChatCompletionsRequest): Promise<unknown> {
    const response = await this.post(body);
    if (!response.ok) {
      throw await this.httpErrorFrom(response);
    }
    return this.parseWire(await this.readBodyText(response));
  }

  private async post(body: WireChatCompletionsRequest): Promise<Response> {
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
      throw new DeepSeekNetworkError({
        message: isTimeoutError(error)
          ? `DeepSeek API request timed out after ${this.timeoutMs}ms`
          : `DeepSeek API network error: ${errorMessage(error)}`,
        timedOut: isTimeoutError(error),
        cause: error,
      });
    }
  }

  private async readBodyText(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch (error) {
      throw new DeepSeekNetworkError({
        message: `DeepSeek API response body could not be read: ${errorMessage(error)}`,
        timedOut: false,
        cause: error,
      });
    }
  }

  private parseWire(text: string): unknown {
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new DeepSeekResponseFormatError(
        `response body is not valid JSON: ${truncate(collapseWhitespace(text), 120)}`,
        { cause: error },
      );
    }
  }

  private async httpErrorFrom(response: Response): Promise<DeepSeekHttpError> {
    const text = await response.text().catch(() => "");
    const serverMessage = extractServerError(text);
    const fallback = response.statusText.length > 0 ? response.statusText : `HTTP ${response.status}`;
    return new DeepSeekHttpError({
      status: response.status,
      message: `DeepSeek API HTTP ${response.status}: ${truncate(serverMessage ?? fallback, ERROR_MESSAGE_SNIPPET_LENGTH)}`,
      errorCode: extractServerErrorCode(text),
      retryable: isRetryableStatus(response.status),
    });
  }
}

function resolveApiKey(explicit: string | undefined): string {
  const fromOptions = explicit?.trim();
  if (fromOptions !== undefined && fromOptions.length > 0) {
    return fromOptions;
  }
  const fromEnv = process.env[DEEPSEEK_API_KEY_ENV_VAR]?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  throw new DeepSeekClientError(
    `DeepSeek API key is missing: set the ${DEEPSEEK_API_KEY_ENV_VAR} environment variable or pass the apiKey option. The key is only read from the environment/options and is never logged or persisted.`,
  );
}

function resolveEndpointUrl(baseUrl: string | undefined): string {
  const base = (baseUrl ?? DEEPSEEK_API_BASE_URL).trim();
  if (!/^https?:\/\//.test(base)) {
    throw new DeepSeekClientError(
      `baseUrl must start with http:// or https:// (got ${JSON.stringify(baseUrl)})`,
    );
  }
  return `${base.replace(/\/+$/, "")}${CHAT_COMPLETIONS_PATH}`;
}

function positiveIntOption(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new DeepSeekClientError(`${name} must be a positive integer (got ${JSON.stringify(value)})`);
  }
  return value;
}

function nonNegativeIntOption(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new DeepSeekClientError(`${name} must be a non-negative integer (got ${JSON.stringify(value)})`);
  }
  return value;
}

function backoffDelayMs(base: number, attempt: number): number {
  return base * 2 ** attempt;
}

function sleepMs(ms: number): Promise<void> {
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
