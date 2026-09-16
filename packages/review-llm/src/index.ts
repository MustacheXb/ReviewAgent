/**
 * review-llm：LLM 接入共享缝（自定义 LLM 接入 #40；本包立缝于 #41）。
 *
 * 收敛 root POC1 与 packages/review-dsh 两包各自为政的 endpoint/key 解析实现，
 * 单源供双包依赖；行为逐字段等价（错误消息文本原样保留——两包既有测试锚定）。
 *
 * 模块构成（#41）：resolver（解析纯函数）+ deepseek（DeepSeek 接入常量）。
 * 后续（#42/#43）：provider 参数画像表、角色命名 env、模型校验。
 */

export {
  DEFAULT_DEEPSEEK_MAX_RETRIES,
  DEFAULT_DEEPSEEK_RETRY_BASE_DELAY_MS,
  DEFAULT_DEEPSEEK_TIMEOUT_MS,
  DEEPSEEK_API_BASE_URL,
  DEEPSEEK_API_KEY_ENV_VAR,
  DEEPSEEK_URL_ENV_VAR,
} from "./deepseek.js";
export {
  nonNegativeIntOption,
  positiveIntOption,
  resolveApiKey,
  resolveEndpointUrl,
} from "./resolver.js";
export type { EnvLookup, ResolveApiKeyInput, ResolveEndpointUrlInput } from "./resolver.js";
