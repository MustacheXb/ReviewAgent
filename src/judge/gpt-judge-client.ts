/**
 * GPT 系 LLM-as-judge 真实客户端（原生 fetch，OpenAI 兼容 chat completions，无 SDK）。
 *
 * HTTP/重试/脱敏/解析内核共享自 src/shared/openai-http-kernel.ts（与 DeepSeek 主客户端
 * 去重）；本文件只保留 judge 特有语义。
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
import {
  defaultSleep,
  nonNegativeIntOption,
  OpenAiHttpKernel,
  positiveIntOption,
  resolveApiKey,
  resolveEndpointUrl,
  runWithRetries,
  type HttpKernelErrorFactories,
} from "../shared/openai-http-kernel.js";

export const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
export const OPENAI_API_KEY_ENV_VAR = "OPENAI_API_KEY";
export const DEFAULT_GPT_JUDGE_TIMEOUT_MS = 300_000;
export const DEFAULT_GPT_JUDGE_MAX_RETRIES = 3;
export const DEFAULT_GPT_JUDGE_RETRY_BASE_DELAY_MS = 1_000;

/** 服务标签：错误消息前缀（内核参数化） */
const SERVICE_LABEL = "OpenAI API";

/** 内核错误工厂：构造 judge 自有错误类型（instanceof / name 语义不变） */
const KERNEL_ERROR_FACTORIES: HttpKernelErrorFactories = {
  clientError: (message) => new JudgeClientError(message),
  networkError: (args) => new GptJudgeNetworkError(args),
  httpError: (args) => new GptJudgeHttpError(args),
  responseFormatError: (message, options) => new GptJudgeResponseFormatError(message, options),
  isRetryableStatus,
};

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
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly mapperOptions: GptRequestMapperOptions;
  private readonly kernel: OpenAiHttpKernel;

  constructor(options: GptJudgeClientOptions = {}) {
    const clientError = KERNEL_ERROR_FACTORIES.clientError;
    // 校验顺序与重构前一致（key → baseUrl → timeoutMs → maxRetries → retryBaseDelayMs）
    this.kernel = new OpenAiHttpKernel({
      serviceLabel: SERVICE_LABEL,
      apiKey: resolveApiKey(options.apiKey, OPENAI_API_KEY_ENV_VAR, SERVICE_LABEL, clientError),
      endpointUrl: resolveEndpointUrl(options.baseUrl, OPENAI_API_BASE_URL, clientError),
      timeoutMs: positiveIntOption(options.timeoutMs, DEFAULT_GPT_JUDGE_TIMEOUT_MS, "timeoutMs", clientError),
      fetchFn: options.fetchFn ?? fetch,
      errors: KERNEL_ERROR_FACTORIES,
    });
    this.maxRetries = nonNegativeIntOption(
      options.maxRetries,
      DEFAULT_GPT_JUDGE_MAX_RETRIES,
      "maxRetries",
      clientError,
    );
    this.retryBaseDelayMs = nonNegativeIntOption(
      options.retryBaseDelayMs,
      DEFAULT_GPT_JUDGE_RETRY_BASE_DELAY_MS,
      "retryBaseDelayMs",
      clientError,
    );
    this.sleepFn = options.sleepFn ?? defaultSleep;
    this.mapperOptions = {
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.limits !== undefined ? { limits: options.limits } : {}),
    };
  }

  async adjudicate(request: JudgeRequest): Promise<JudgeAdjudication> {
    const body = buildGptJudgeBody(request, this.mapperOptions);
    return await runWithRetries({
      maxRetries: this.maxRetries,
      retryBaseDelayMs: this.retryBaseDelayMs,
      sleepFn: this.sleepFn,
      isRetryable: isRetryableJudgeError,
      // 裁定解析保留在重试操作内（解析失败为不可重试错误，语义与重构前一致）
      operation: async () => parseJudgeAdjudication(await this.fetchContent(body)),
    });
  }

  private async fetchContent(body: WireGptChatCompletionsRequest): Promise<string> {
    const response = await this.kernel.postJson(body);
    if (!response.ok) {
      throw await this.kernel.httpErrorFrom(response);
    }
    const mapped = mapGptChatCompletionsResponse(
      this.kernel.parseJsonBody(await this.kernel.readBodyText(response)),
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
}
