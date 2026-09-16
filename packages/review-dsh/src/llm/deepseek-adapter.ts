/**
 * DeepSeekLlmAdapter：POC1 DeepSeek 客户端的 DSH LlmAdapter 形态（#19）。
 *
 * 注册于 ctx.llm 与 FakeLlmAdapter 同 seam 可互换。原生 fetch 直连 OpenAI 兼容
 * chat/completions（非流式，stream:false）——精确控制请求字节是 POC1 的立身之本，
 * 自拼 JSON 是唯一干净做法（研究笔记结论，1:1 保留）。
 *
 * 锁定纪律（ADR-0002，逐项有测试）：
 * - effort 单档锁定：harness 侧仅接受 "default"，线上恒为
 *   thinking {type:"enabled"} + reasoning_effort "high"；
 * - 请求不携带 temperature/top_p/stop 等采样参数（max_tokens 仅由画像信封
 *   分派，wire.ts 序列化纪律）；
 * - usage 记账含 cached tokens（miss/hit 不相交，response.ts）；
 * - `review.*` → `review_*` 工具名映射（请求侧 wire.ts / 响应侧反解）。
 *
 * 模型准入（#45）：自由 id 接受——序列化策略由 provider 画像表分派
 * （review-llm profileOf，wire.ts 消费）；退役 id（RETIRED_MODEL_IDS 单源）
 * 本地拒绝。SUPPORTED_MODELS 降为 listModels 的 advisory 通报。
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
 * 凭据纪律：API key 仅经 reviewer 角色环境变量（REVIEWER_API_KEY，别名
 * DEEPSEEK_API_KEY，#45 起与 root POC1 客户端同名单源）或显式参数注入，
 * 绝不硬编码、绝不出现在错误信息中（服务端回显时 redact 兜底）。
 *
 * endpoint/key 解析与 DeepSeek 接入常量单源自 review-llm 共享包（#41，
 * 与 root POC1 客户端同源；错误消息文本原样保留，既有测试锚定）。
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
import {
  DEFAULT_DEEPSEEK_MAX_RETRIES,
  DEFAULT_DEEPSEEK_RETRY_BASE_DELAY_MS,
  DEFAULT_DEEPSEEK_TIMEOUT_MS,
  DEEPSEEK_API_BASE_URL,
  nonNegativeIntOption,
  positiveIntOption,
  resolveApiKey,
  resolveEndpointUrl,
  RETIRED_MODEL_IDS,
  REVIEWER_API_KEY_ENV_VARS,
  REVIEWER_URL_ENV_VARS,
} from "review-llm";

/** DeepSeek 接入常量单源在 review-llm（#41 起双包共享）；此处 re-export 维持既有导入面 */
export {
  DEFAULT_DEEPSEEK_MAX_RETRIES,
  DEFAULT_DEEPSEEK_RETRY_BASE_DELAY_MS,
  DEFAULT_DEEPSEEK_TIMEOUT_MS,
  DEEPSEEK_API_BASE_URL,
  RETIRED_MODEL_IDS,
  REVIEWER_API_KEY_ENV_VARS,
  REVIEWER_URL_ENV_VARS,
};

const SERVICE_LABEL = "DeepSeek API";

/** 解析/校验错误工厂（共享 resolver 注入；构造 DeepSeekClientError 保持 name/instanceof 语义） */
const deepSeekClientError = (message: string): Error => new DeepSeekClientError(message);

const ERROR_MESSAGE_SNIPPET_LENGTH = 300;
const INVALID_JSON_SNIPPET_LENGTH = 120;

export interface DeepSeekAdapterOptions {
  /** API key；缺省读 reviewer 角色环境变量 REVIEWER_API_KEY（别名 DEEPSEEK_API_KEY；构造期校验，缺失 fail fast） */
  readonly apiKey?: string;
  /** API base URL；显式选项 > REVIEWER_URL 环境变量（别名 DEEPSEEK_URL）> 缺省 https://api.deepseek.com（中转/代理端点用；测试注入本地地址） */
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

  /** 解析后的完整请求端点（base + /chat/completions；#46 冒烟诊断报告消费，非秘密） */
  readonly endpointUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly fetchFn: typeof fetch;

  constructor(options: DeepSeekAdapterOptions = {}) {
    super();
    // 校验顺序与 POC1 客户端一致（key → baseUrl → timeoutMs → maxRetries → retryBaseDelayMs）
    this.apiKey = resolveApiKey({
      explicit: options.apiKey,
      envVarNames: REVIEWER_API_KEY_ENV_VARS,
      serviceLabel: SERVICE_LABEL,
      clientError: deepSeekClientError,
    });
    this.endpointUrl = resolveEndpointUrl({
      baseUrl: options.baseUrl,
      defaultBaseUrl: DEEPSEEK_API_BASE_URL,
      envVarNames: REVIEWER_URL_ENV_VARS,
      clientError: deepSeekClientError,
    });
    this.timeoutMs = positiveIntOption(
      options.timeoutMs,
      DEFAULT_DEEPSEEK_TIMEOUT_MS,
      "timeoutMs",
      deepSeekClientError,
    );
    this.maxRetries = nonNegativeIntOption(
      options.maxRetries,
      DEFAULT_DEEPSEEK_MAX_RETRIES,
      "maxRetries",
      deepSeekClientError,
    );
    this.retryBaseDelayMs = positiveIntOption(
      options.retryBaseDelayMs,
      DEFAULT_DEEPSEEK_RETRY_BASE_DELAY_MS,
      "retryBaseDelayMs",
      deepSeekClientError,
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

/** 路由政策校验（#45）：自由 id 准入（画像表接管序列化）+ 退役 id 拒绝 + effort 单档锁定 */
function validateRoute(options: GenerateOptions): void {
  const model = options.model;
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new DeepSeekClientError(
      `model must be a non-empty string (got ${JSON.stringify(model)}): free model ids are accepted and serialized per the provider profile table (review-llm profileOf)`,
    );
  }
  if (RETIRED_MODEL_IDS.includes(model)) {
    throw new DeepSeekClientError(
      `model ${JSON.stringify(model)} is retired (deepseek-chat / deepseek-reasoner were retired on 2026-07-24 and must not be used; ADR-0002)`,
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
