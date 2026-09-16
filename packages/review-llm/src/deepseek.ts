/**
 * DeepSeek 接入常量（单源；原 root deepseek-client / review-dsh deepseek-adapter 双份收敛）。
 * provider 参数画像（thinking 策略 / completion 信封 / usage 能力）见 ./profile.ts（#42）。
 */

export const DEEPSEEK_API_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_API_KEY_ENV_VAR = "DEEPSEEK_API_KEY";
/** 接入点覆盖环境变量（中转/代理端点；显式 baseUrl 选项优先于它） */
export const DEEPSEEK_URL_ENV_VAR = "DEEPSEEK_URL";
export const DEFAULT_DEEPSEEK_TIMEOUT_MS = 600_000;
export const DEFAULT_DEEPSEEK_MAX_RETRIES = 3;
export const DEFAULT_DEEPSEEK_RETRY_BASE_DELAY_MS = 1_000;
