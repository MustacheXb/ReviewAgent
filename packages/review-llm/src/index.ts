/**
 * review-llm：LLM 接入共享缝（自定义 LLM 接入 #40；本包立缝于 #41）。
 *
 * 收敛 root POC1 与 packages/review-dsh 两包各自为政的 LLM 接入实现，
 * 单源供双包依赖；resolver 行为逐字段等价（错误消息文本原样保留——
 * 两包既有测试锚定）。
 *
 * 模块构成：
 * - resolver（#41）：endpoint/key 解析纯函数（显式参数 > 环境变量 > 默认）
 * - deepseek（#41）：DeepSeek 接入常量
 * - profile（#42）：provider 参数画像表（thinking 策略 / completion 信封 /
 *   usage 能力声明），judge 链为首个消费者，#43 reviewer 侧跟进
 */

export {
  DEFAULT_DEEPSEEK_MAX_RETRIES,
  DEFAULT_DEEPSEEK_RETRY_BASE_DELAY_MS,
  DEFAULT_DEEPSEEK_TIMEOUT_MS,
  DEEPSEEK_API_BASE_URL,
  DEEPSEEK_API_KEY_ENV_VAR,
  DEEPSEEK_URL_ENV_VAR,
} from "./deepseek.js";
export { profileOf } from "./profile.js";
export type {
  ProviderProfile,
  ThinkingSerialization,
  UsageCapabilities,
} from "./profile.js";
export {
  nonNegativeIntOption,
  positiveIntOption,
  resolveApiKey,
  resolveEndpointUrl,
} from "./resolver.js";
export type { EnvLookup, ResolveApiKeyInput, ResolveEndpointUrlInput } from "./resolver.js";
