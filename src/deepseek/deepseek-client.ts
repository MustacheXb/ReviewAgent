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
import { buildChatCompletionsBody, buildWireToolNameMap } from "./request-mapper.js";
import { mapChatCompletionsResponse } from "./response-mapper.js";
import type { WireChatCompletionsRequest } from "./wire-types.js";
import {
  nonNegativeIntOption,
  OpenAiHttpKernel,
  positiveIntOption,
  resolveApiKey,
  resolveEndpointUrl,
  runWithRetries,
  type HttpKernelErrorFactories,
} from "../shared/openai-http-kernel.js";
import { defaultSleep } from "../shared/openai-http-kernel.js";

/**
 * 真实 DeepSeek 客户端（原生 fetch，OpenAI 兼容 chat completions，无 SDK——研究笔记结论：
 * POC1 需要精确控制请求字节，自拼 JSON 是唯一干净做法）。
 *
 * HTTP/重试/脱敏/解析内核共享自 src/shared/openai-http-kernel.ts（与 GPT judge 客户端
 * 去重）；本文件只保留 DeepSeek 特有语义。
 *
 * 锁定纪律（ADR-0002）：
 * - model 白名单 = deepseek-v4-flash（主力）+ deepseek-v4-pro（仅高险子集消融，
 *   spec #1 user story 15；request-mapper 校验，退役 id 直接拒绝）；
 * - effort 单档锁定：harness effort 标签仅接受 "default"，线上恒为 thinking {type:"enabled"} + reasoning_effort "high"；
 * - API key 仅经 DEEPSEEK_API_KEY 环境变量或显式参数注入，绝不硬编码、绝不出现在错误信息中。
 *
 * 工具名 wire 适配：线上 function name 校验 ^[a-zA-Z0-9_-]+$，内部点分命名空间
 * （review.get_symbol 等）在请求序列化时转下划线（request-mapper.toWireToolName），
 * 响应 toolCalls 名反解回内部名——harness 契约层零感知。
 */

export const DEEPSEEK_API_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_API_KEY_ENV_VAR = "DEEPSEEK_API_KEY";
/** 接入点覆盖环境变量（中转/代理端点；显式 baseUrl 选项优先于它） */
export const DEEPSEEK_URL_ENV_VAR = "DEEPSEEK_URL";
export const DEFAULT_DEEPSEEK_TIMEOUT_MS = 600_000;
export const DEFAULT_DEEPSEEK_MAX_RETRIES = 3;
export const DEFAULT_DEEPSEEK_RETRY_BASE_DELAY_MS = 1_000;

/** 服务标签：错误消息前缀（内核参数化） */
const SERVICE_LABEL = "DeepSeek API";

/** 内核错误工厂：构造 DeepSeek 自有错误类型（instanceof / name 语义不变） */
const KERNEL_ERROR_FACTORIES: HttpKernelErrorFactories = {
  clientError: (message) => new DeepSeekClientError(message),
  networkError: (args) => new DeepSeekNetworkError(args),
  httpError: (args) => new DeepSeekHttpError(args),
  responseFormatError: (message, options) => new DeepSeekResponseFormatError(message, options),
  isRetryableStatus,
};

export interface DeepSeekClientOptions {
  /** API key；缺省读环境变量 DEEPSEEK_API_KEY（启动即校验，缺失 fail fast） */
  readonly apiKey?: string;
  /** API base URL；显式选项 > DEEPSEEK_URL 环境变量 > 缺省 https://api.deepseek.com（中转/代理端点用；测试可注入本地地址） */
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
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly kernel: OpenAiHttpKernel;

  constructor(options: DeepSeekClientOptions = {}) {
    const clientError = KERNEL_ERROR_FACTORIES.clientError;
    // 校验顺序与重构前一致（key → baseUrl → timeoutMs → maxRetries → retryBaseDelayMs）
    this.kernel = new OpenAiHttpKernel({
      serviceLabel: SERVICE_LABEL,
      apiKey: resolveApiKey(options.apiKey, DEEPSEEK_API_KEY_ENV_VAR, SERVICE_LABEL, clientError),
      endpointUrl: resolveEndpointUrl(options.baseUrl, DEEPSEEK_API_BASE_URL, clientError, DEEPSEEK_URL_ENV_VAR),
      timeoutMs: positiveIntOption(options.timeoutMs, DEFAULT_DEEPSEEK_TIMEOUT_MS, "timeoutMs", clientError),
      fetchFn: options.fetchFn ?? fetch,
      errors: KERNEL_ERROR_FACTORIES,
    });
    this.maxRetries = nonNegativeIntOption(options.maxRetries, DEFAULT_DEEPSEEK_MAX_RETRIES, "maxRetries", clientError);
    this.retryBaseDelayMs = nonNegativeIntOption(
      options.retryBaseDelayMs,
      DEFAULT_DEEPSEEK_RETRY_BASE_DELAY_MS,
      "retryBaseDelayMs",
      clientError,
    );
    this.sleepFn = options.sleepFn ?? defaultSleep;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    // 请求体构造/校验失败：立即抛（本地错误，重试无意义）
    const body = buildChatCompletionsBody(request);
    // wire 名 → 内部名映射（响应 toolCalls 反解用）；tools 已随 body 构造校验过，此处幂等重建
    const internalToolNames = buildWireToolNameMap(request.tools);
    // 失败尝试已消耗的 usage 记账（insufficient_system_resource 携带），重试成功后并入
    let consumed: LlmUsage | undefined;
    return await runWithRetries({
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
        const wire = await this.fetchWire(body);
        const mapped = mapChatCompletionsResponse(wire);
        const response = restoreInternalToolNames(mapped.response, internalToolNames);
        if (mapped.finishReason === "insufficient_system_resource") {
          throw new DeepSeekInsufficientResourceError(response.usage);
        }
        return consumed === undefined
          ? response
          : { ...response, usage: addUsage(consumed, response.usage) };
      },
    });
  }

  private async fetchWire(body: WireChatCompletionsRequest): Promise<unknown> {
    const response = await this.kernel.postJson(body);
    if (!response.ok) {
      throw await this.kernel.httpErrorFrom(response);
    }
    return this.kernel.parseJsonBody(await this.kernel.readBodyText(response));
  }
}

/**
 * 响应 toolCalls 的 wire 名反解回内部点分名（review_get_symbol → review.get_symbol）。
 * 未注册名原样透传——幻觉名交由 executor 的 unknown-tool 语义处理，与无适配时行为一致。
 */
function restoreInternalToolNames(
  response: LlmResponse,
  wireToInternal: Map<string, string>,
): LlmResponse {
  if (response.toolCalls.length === 0 || wireToInternal.size === 0) {
    return response;
  }
  return {
    ...response,
    toolCalls: response.toolCalls.map((call) => ({
      ...call,
      name: wireToInternal.get(call.name) ?? call.name,
    })),
  };
}
