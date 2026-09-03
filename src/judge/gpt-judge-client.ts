/**
 * GPT 系 LLM-as-judge 真实客户端（原生 fetch，OpenAI 兼容 chat completions，无 SDK——
 * 镜像 src/deepseek/deepseek-client.ts 的访问模式）。
 *
 * 纪律：
 * - API key 仅经 OPENAI_API_KEY 环境变量或显式参数注入，绝不硬编码、绝不出现在错误信息中；
 * - 模型异构约束：默认 gpt-5.2-pro（MCR-Bench 论文 LLM-Hit-Judge 的最高人工一致性档，
 *   QWK 0.73），deepseek 系 id 直接拒绝（判定链要求与被测模型不同源）；
 * - judge 参数锁定论文协议值：temperature 0.2 / top_p 0.95 / max_tokens 8192；
 * - 有界重试：仅 429/500/503 与网络/超时错误重试；响应体异常与请求构造错直接抛。
 */

import type { JudgeAdjudication, JudgeClient, JudgeRequest } from "./contracts.js";
import {
  GptJudgeHttpError,
  GptJudgeNetworkError,
  GptJudgeResponseFormatError,
  isRetryableJudgeError,
  isRetryableStatus,
  JudgeClientError,
} from "./errors.js";
import { buildGptJudgeBody } from "./gpt-request-mapper.js";
import type { GptRequestMapperOptions } from "./gpt-request-mapper.js";
import { mapGptChatCompletionsResponse } from "./gpt-response-mapper.js";
import { parseJudgeAdjudication } from "./parse.js";
import type { WireGptChatCompletionsRequest } from "./gpt-wire-types.js";

export const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
export const OPENAI_API_KEY_ENV_VAR = "OPENAI_API_KEY";
export const DEFAULT_GPT_JUDGE_TIMEOUT_MS = 300_000;
export const DEFAULT_GPT_JUDGE_MAX_RETRIES = 3;
export const DEFAULT_GPT_JUDGE_RETRY_BASE_DELAY_MS = 1_000;

const CHAT_COMPLETIONS_PATH = "/chat/completions";
const ERROR_MESSAGE_SNIPPET_LENGTH = 300;

export interface GptJudgeClientOptions extends GptRequestMapperOptions {
  /** API key；缺省读环境变量 OPENAI_API_KEY（启动即校验，缺失 fail fast） */
  readonly apiKey?: string;
  /** API base URL；缺省 https://api.openai.com/v1（测试可注入本地地址） */
  readonly baseUrl?: string;
  /** 单次请求超时（毫秒）；缺省 300_000（推理型 judge 长思考给足） */
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

export class GptJudgeClient implements JudgeClient {
  private readonly apiKey: string;
  private readonly endpointUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly mapperOptions: GptRequestMapperOptions;

  constructor(options: GptJudgeClientOptions = {}) {
    this.apiKey = resolveApiKey(options.apiKey);
    this.endpointUrl = resolveEndpointUrl(options.baseUrl);
    this.timeoutMs = positiveIntOption(options.timeoutMs, DEFAULT_GPT_JUDGE_TIMEOUT_MS, "timeoutMs");
    this.maxRetries = nonNegativeIntOption(
      options.maxRetries,
      DEFAULT_GPT_JUDGE_MAX_RETRIES,
      "maxRetries",
    );
    this.retryBaseDelayMs = nonNegativeIntOption(
      options.retryBaseDelayMs,
      DEFAULT_GPT_JUDGE_RETRY_BASE_DELAY_MS,
      "retryBaseDelayMs",
    );
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleepFn = options.sleepFn ?? sleepMs;
    this.mapperOptions = {
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.limits !== undefined ? { limits: options.limits } : {}),
    };
  }

  async adjudicate(request: JudgeRequest): Promise<JudgeAdjudication> {
    const body = buildGptJudgeBody(request, this.mapperOptions);
    for (let attempt = 0; ; attempt++) {
      try {
        const content = await this.fetchContent(body);
        return parseJudgeAdjudication(content);
      } catch (error) {
        if (attempt >= this.maxRetries || !isRetryableJudgeError(error)) {
          throw error;
        }
        await this.sleepFn(backoffDelayMs(this.retryBaseDelayMs, attempt));
      }
    }
  }

  private async fetchContent(body: WireGptChatCompletionsRequest): Promise<string> {
    const response = await this.post(body);
    if (!response.ok) {
      throw await this.httpErrorFrom(response);
    }
    const mapped = mapGptChatCompletionsResponse(
      this.parseWire(await this.readBodyText(response)),
    );
    if (mapped.finishReason === "length") {
      throw new GptJudgeHttpError({
        status: 200,
        message:
          'OpenAI API returned finish_reason "length": the judge response was truncated by max_tokens; not retried automatically',
        retryable: false,
      });
    }
    return mapped.content;
  }

  private async post(body: WireGptChatCompletionsRequest): Promise<Response> {
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
      throw new GptJudgeNetworkError({
        message: this.redact(
          isTimeoutError(error)
            ? `OpenAI API request timed out after ${this.timeoutMs}ms`
            : `OpenAI API network error: ${errorMessage(error)}`,
        ),
        timedOut: isTimeoutError(error),
        cause: error,
      });
    }
  }

  private async readBodyText(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch (error) {
      throw new GptJudgeNetworkError({
        message: this.redact(`OpenAI API response body could not be read: ${errorMessage(error)}`),
        timedOut: false,
        cause: error,
      });
    }
  }

  private parseWire(text: string): unknown {
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new GptJudgeResponseFormatError(
        this.redact(`response body is not valid JSON: ${truncate(collapseWhitespace(text), 120)}`),
        { cause: error },
      );
    }
  }

  private async httpErrorFrom(response: Response): Promise<GptJudgeHttpError> {
    const text = await response.text().catch(() => "");
    const serverMessage = extractServerError(text);
    const fallback = response.statusText.length > 0 ? response.statusText : `HTTP ${response.status}`;
    return new GptJudgeHttpError({
      status: response.status,
      message: this.redact(
        `OpenAI API HTTP ${response.status}: ${truncate(serverMessage ?? fallback, ERROR_MESSAGE_SNIPPET_LENGTH)}`,
      ),
      errorCode: extractServerErrorCode(text),
      retryable: isRetryableStatus(response.status),
    });
  }

  /** 错误信息脱敏：key 若被服务端/异常文本回显，一律替换为 [REDACTED] */
  private redact(message: string): string {
    return this.apiKey.length > 0 ? message.split(this.apiKey).join("[REDACTED]") : message;
  }
}

function resolveApiKey(explicit: string | undefined): string {
  const fromOptions = explicit?.trim();
  if (fromOptions !== undefined && fromOptions.length > 0) {
    return fromOptions;
  }
  const fromEnv = process.env[OPENAI_API_KEY_ENV_VAR]?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  throw new JudgeClientError(
    `OpenAI API key is missing: set the ${OPENAI_API_KEY_ENV_VAR} environment variable or pass the apiKey option. The key is only read from the environment/options and is never logged or persisted.`,
  );
}

function resolveEndpointUrl(baseUrl: string | undefined): string {
  const base = (baseUrl ?? OPENAI_API_BASE_URL).trim();
  if (!/^https?:\/\//.test(base)) {
    throw new JudgeClientError(
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
    throw new JudgeClientError(`${name} must be a positive integer (got ${JSON.stringify(value)})`);
  }
  return value;
}

function nonNegativeIntOption(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new JudgeClientError(
      `${name} must be a non-negative integer (got ${JSON.stringify(value)})`,
    );
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
