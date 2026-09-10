/**
 * DeepSeekLlmAdapter：POC1 DeepSeek 客户端的 DSH LlmAdapter 形态（#19）。
 *
 * 注册于 ctx.llm 与 FakeLlmAdapter 同 seam 可互换。原生 fetch 直连 OpenAI 兼容
 * chat/completions（非流式，stream:false）——精确控制请求字节是 POC1 的立身之本，
 * 自拼 JSON 是唯一干净做法（研究笔记结论，1:1 保留）。
 *
 * 锁定纪律（ADR-0002，逐项有测试）：
 * - model 白名单 = deepseek-v4-flash（主力）+ deepseek-v4-pro（仅高险子集消融；
 *   退役 id 直接拒绝）；
 * - effort 单档锁定：harness 侧仅接受 "default"，线上恒为
 *   thinking {type:"enabled"} + reasoning_effort "high"；
 * - 请求不携带 temperature/top_p/max_tokens/stop 等采样参数（wire.ts 序列化纪律）；
 * - usage 记账含 cached tokens（miss/hit 不相交，response.ts）；
 * - `review.*` → `review_*` 工具名映射（请求侧 wire.ts / 响应侧反解）。
 *
 * wire 字节捕获：序列化点（JSON.stringify）记录请求原文，一次逻辑调用一条，
 * 重试复用同一字节——POC1「可重放字节」契约只能从持有序列化的一方采集。
 * wireLog 经 profile 组装挂到 review-cache 审计源。
 *
 * 重试语义（POC1 原样保留在适配器内）：429/500/503、网络/超时、
 * insufficient_system_resource 有界重试（默认 3 次，指数退避）；失败尝试
 * 已消耗的 usage 并账。内核侧 providerRetryPolicy 仅供未挂载的 dsh-llm-retry
 * 插件消费，无双重重试。重试耗尽 → 终态 error finish（failureOf 折叠稳定 code）。
 *
 * 凭据纪律：API key 仅经 DEEPSEEK_API_KEY 环境变量或显式参数注入，绝不硬编码、
 * 绝不出现在错误信息中（服务端回显时 redact 兜底）。
 */

import {
  attributionHeaders,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
  type TokenUsage,
} from "@deepseek-ai/dsh-llm";

import {
  DeepSeekClientError,
  DeepSeekHttpError,
  DeepSeekInsufficientResourceError,
  DeepSeekNetworkError,
  DeepSeekResponseFormatError,
  failureOf,
  isRetryableDeepSeekError,
  isRetryableStatus,
  usageOfError,
} from "./errors.js";
import { addUsage, emitResponseChunks, mapWireResponse } from "./response.js";
import { defaultSleep, runWithRetries } from "./retry.js";
import { buildChatCompletionsBody, buildWireToolNameMap, LOCKED_EFFORT_LABEL, SUPPORTED_MODELS } from "./wire.js";
import { WireRequestLog } from "./wire-log.js";

export const DEEPSEEK_API_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_API_KEY_ENV_VAR = "DEEPSEEK_API_KEY";
/** 接入点覆盖环境变量（中转/代理端点；显式 baseUrl 选项优先于它） */
export const DEEPSEEK_URL_ENV_VAR = "DEEPSEEK_URL";
export const DEFAULT_DEEPSEEK_TIMEOUT_MS = 600_000;
export const DEFAULT_DEEPSEEK_MAX_RETRIES = 3;
export const DEFAULT_DEEPSEEK_RETRY_BASE_DELAY_MS = 1_000;

const SERVICE_LABEL = "DeepSeek API";

const ERROR_MESSAGE_SNIPPET_LENGTH = 300;
const INVALID_JSON_SNIPPET_LENGTH = 120;

export interface DeepSeekAdapterOptions {
  /** API key；缺省读环境变量 DEEPSEEK_API_KEY（构造期校验，缺失 fail fast） */
  readonly apiKey?: string;
  /** API base URL；显式选项 > DEEPSEEK_URL 环境变量 > 缺省 https://api.deepseek.com（中转/代理端点用；测试注入本地地址） */
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
  /** wire 请求日志（缺省内部新建；profile 组装读取 adapter.wireLog 挂到审计源） */
  readonly wireLog?: WireRequestLog;
}

export class DeepSeekLlmAdapter extends LlmAdapter {
  /** wire 请求字节捕获（序列化点记录；经 profile 组装接入审计源） */
  readonly wireLog: WireRequestLog;

  private readonly endpointUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly fetchFn: typeof fetch;

  constructor(options: DeepSeekAdapterOptions = {}) {
    super();
    // 校验顺序与 POC1 客户端一致（key → baseUrl → timeoutMs → maxRetries → retryBaseDelayMs）
    this.apiKey = resolveApiKey(options.apiKey);
    this.endpointUrl = resolveEndpointUrl(options.baseUrl);
    this.timeoutMs = positiveIntOption(options.timeoutMs, DEFAULT_DEEPSEEK_TIMEOUT_MS, "timeoutMs");
    this.maxRetries = nonNegativeIntOption(
      options.maxRetries,
      DEFAULT_DEEPSEEK_MAX_RETRIES,
      "maxRetries",
    );
    this.retryBaseDelayMs = positiveIntOption(
      options.retryBaseDelayMs,
      DEFAULT_DEEPSEEK_RETRY_BASE_DELAY_MS,
      "retryBaseDelayMs",
    );
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleepFn = options.sleepFn ?? defaultSleep;
    this.wireLog = options.wireLog ?? new WireRequestLog();
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: "DeepSeek" };
  }

  /** 白名单 advisory 通报（目录成员不约束路由；校验在 stream 入口） */
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(SUPPORTED_MODELS.map((id) => ({ provider, id, name: id })));
  }

  /** ADR-0002 单档 effort 申报：唯一合法标签 default（内核 prepareCall 的校验依据） */
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [{ id: ReasoningEffortId(LOCKED_EFFORT_LABEL), name: "Default" }],
        defaultEffort: ReasoningEffortId(LOCKED_EFFORT_LABEL),
      },
    });
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.signal?.aborted) {
      yield abortedFinish("request aborted before dispatch");
      return;
    }
    // 路由政策校验（本地错误，直接抛、不重试、不消耗脚本）
    validateRoute(options);
    const body = buildChatCompletionsBody(options);
    // 序列化点：请求字节在此确定并捕获（一次逻辑调用一条；重试复用同一字节）
    const text = JSON.stringify(body);
    this.wireLog.record(text);
    const wireToInternal = buildWireToolNameMap(options.tools ?? []);

    // 失败尝试已消耗的 usage 记账（insufficient_system_resource 携带），重试成功后并入
    let consumed: TokenUsage | undefined;
    try {
      const mapped = await runWithRetries({
        maxRetries: this.maxRetries,
        retryBaseDelayMs: this.retryBaseDelayMs,
        sleepFn: this.sleepFn,
        isRetryable: isRetryableDeepSeekError,
        onError: (error) => {
          const wasted = usageOfError(error);
          if (wasted !== undefined) {
            consumed = consumed === undefined ? wasted : addUsage(consumed, wasted);
          }
        },
        operation: async () => {
          const wire = await this.postJson(text, options.signal);
          const mapped = mapWireResponse(wire);
          if (mapped.finishReason === "insufficient_system_resource") {
            throw new DeepSeekInsufficientResourceError(mapped.usage);
          }
          return mapped;
        },
      });
      yield* emitResponseChunks(mapped, wireToInternal, consumed);
    } catch (error) {
      if (options.signal?.aborted) {
        yield abortedFinish("request aborted");
        return;
      }
      yield { type: "finish", reason: { kind: "error", failure: failureOf(error) } };
    }
  }

  /** POST JSON（Bearer 鉴权 + attribution headers + 超时中断；网络/超时统一映射 networkError） */
  private async postJson(text: string, signal: AbortSignal | undefined): Promise<unknown> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal !== undefined ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await this.fetchFn(this.endpointUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
          ...attributionHeaders(),
        },
        body: text,
        signal: requestSignal,
      });
    } catch (error) {
      throw new DeepSeekNetworkError({
        message: this.redact(
          isTimeoutError(error)
            ? `${SERVICE_LABEL} request timed out after ${this.timeoutMs}ms`
            : `${SERVICE_LABEL} network error: ${errorMessage(error)}`,
        ),
        timedOut: isTimeoutError(error),
        cause: error,
      });
    }
    if (!response.ok) {
      throw await this.httpErrorFrom(response);
    }
    const responseText = await this.readBodyText(response);
    try {
      return JSON.parse(responseText) as unknown;
    } catch (error) {
      throw new DeepSeekResponseFormatError(
        this.redact(
          `response body is not valid JSON: ${truncate(collapseWhitespace(responseText), INVALID_JSON_SNIPPET_LENGTH)}`,
        ),
        { cause: error },
      );
    }
  }

  /** 读取响应体文本；读取失败映射为 networkError */
  private async readBodyText(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch (error) {
      throw new DeepSeekNetworkError({
        message: this.redact(`${SERVICE_LABEL} response body could not be read: ${errorMessage(error)}`),
        timedOut: false,
        cause: error,
      });
    }
  }

  /** 非 2xx → httpError（服务端 error.message 优先，含脱敏与可重试标记） */
  private async httpErrorFrom(response: Response): Promise<DeepSeekHttpError> {
    const text = await response.text().catch(() => "");
    const serverMessage = extractServerError(text);
    const fallback = response.statusText.length > 0 ? response.statusText : `HTTP ${response.status}`;
    return new DeepSeekHttpError({
      status: response.status,
      message: this.redact(
        `${SERVICE_LABEL} HTTP ${response.status}: ${truncate(serverMessage ?? fallback, ERROR_MESSAGE_SNIPPET_LENGTH)}`,
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

/** 路由政策校验（ADR-0002）：模型白名单 + effort 单档锁定 */
function validateRoute(options: GenerateOptions): void {
  if (!SUPPORTED_MODELS.includes(options.model)) {
    throw new DeepSeekClientError(
      `unsupported model ${JSON.stringify(options.model)}: the DeepSeek adapter supports ${SUPPORTED_MODELS.map((m) => JSON.stringify(m)).join(", ")} (ADR-0002; deepseek-chat / deepseek-reasoner were retired on 2026-07-24 and must not be used)`,
    );
  }
  if (options.reasoningEffort !== undefined && options.reasoningEffort !== ReasoningEffortId(LOCKED_EFFORT_LABEL)) {
    throw new DeepSeekClientError(
      `effort is locked at the adapter layer (ADR-0002 single effort gear): got ${JSON.stringify(options.reasoningEffort)}, expected ${JSON.stringify(LOCKED_EFFORT_LABEL)}; the locked gear always serializes to thinking {type:"enabled"} + reasoning_effort "high", so the experiment cannot drift`,
    );
  }
}

function abortedFinish(message: string): StreamChunk {
  return {
    type: "finish",
    reason: { kind: "aborted", failure: { message: `${SERVICE_LABEL} ${message}`, code: "ABORTED" } },
  };
}

/** key 解析：显式参数优先，其次环境变量；缺失 fail fast（消息不回显 key 值） */
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
    `${SERVICE_LABEL} key is missing: set the ${DEEPSEEK_API_KEY_ENV_VAR} environment variable or pass the apiKey option. The key is only read from the environment/options and is never logged or persisted.`,
  );
}

/** 端点解析：base URL + /chat/completions；优先级镜像 resolveApiKey，协议校验并注明取值来源 */
function resolveEndpointUrl(baseUrl: string | undefined): string {
  const fromOptions = baseUrl?.trim();
  if (fromOptions !== undefined && fromOptions.length > 0) {
    return endpointOf(fromOptions, "baseUrl option");
  }
  const fromEnv = process.env[DEEPSEEK_URL_ENV_VAR]?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return endpointOf(fromEnv, `${DEEPSEEK_URL_ENV_VAR} environment variable`);
  }
  return endpointOf(DEEPSEEK_API_BASE_URL, "default");
}

function endpointOf(base: string, source: string): string {
  const trimmed = base.trim();
  if (!/^https?:\/\//.test(trimmed)) {
    throw new DeepSeekClientError(
      `baseUrl must start with http:// or https:// (from ${source}: ${JSON.stringify(trimmed)})`,
    );
  }
  return `${trimmed.replace(/\/+$/, "")}/chat/completions`;
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
