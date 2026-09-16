import { describe, expect, it } from "vitest";

import {
  DEFAULT_DEEPSEEK_MAX_RETRIES,
  DEFAULT_DEEPSEEK_RETRY_BASE_DELAY_MS,
  DEFAULT_DEEPSEEK_TIMEOUT_MS,
  DEEPSEEK_API_BASE_URL,
  DEEPSEEK_API_KEY_ENV_VAR,
  DEEPSEEK_URL_ENV_VAR,
} from "./deepseek.js";

/**
 * 值锚定：常量自两包既有实现收敛而来（root deepseek-client / review-dsh deepseek-adapter），
 * 期望值取自 DeepSeek API 契约与既有行为，防收敛搬移时漂移。
 */
describe("DeepSeek 接入常量", () => {
  it("base URL 与环境变量名锚定", () => {
    expect(DEEPSEEK_API_BASE_URL).toBe("https://api.deepseek.com");
    expect(DEEPSEEK_API_KEY_ENV_VAR).toBe("DEEPSEEK_API_KEY");
    expect(DEEPSEEK_URL_ENV_VAR).toBe("DEEPSEEK_URL");
  });

  it("超时/重试缺省值锚定", () => {
    expect(DEFAULT_DEEPSEEK_TIMEOUT_MS).toBe(600_000);
    expect(DEFAULT_DEEPSEEK_MAX_RETRIES).toBe(3);
    expect(DEFAULT_DEEPSEEK_RETRY_BASE_DELAY_MS).toBe(1_000);
  });
});
