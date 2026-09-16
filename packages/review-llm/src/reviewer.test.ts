import { describe, expect, it } from "vitest";

import { DEEPSEEK_API_KEY_ENV_VAR, DEEPSEEK_URL_ENV_VAR } from "./deepseek.js";
import { hasReviewerApiKey, REVIEWER_API_KEY_ENV_VAR, REVIEWER_API_KEY_ENV_VARS, REVIEWER_URL_ENV_VAR, REVIEWER_URL_ENV_VARS } from "./reviewer.js";

/**
 * reviewer 角色接入常量（#43）：角色命名 env + 旧 provider 命名兼容别名。
 * 单测锚定：变量名字面值、别名探测序（推荐名在前）、存在性探测的 trim 语义
 * （与 resolveApiKey 同语义——实验预检与 e2e 冒烟门共用口径）。
 */

describe("reviewer 角色环境变量常量", () => {
  it("角色命名变量字面值：REVIEWER_API_KEY / REVIEWER_URL", () => {
    expect(REVIEWER_API_KEY_ENV_VAR).toBe("REVIEWER_API_KEY");
    expect(REVIEWER_URL_ENV_VAR).toBe("REVIEWER_URL");
  });

  it("别名探测序：推荐名在前，旧 DEEPSEEK_* 名殿后（新名 > 旧名 > 默认）", () => {
    expect(REVIEWER_API_KEY_ENV_VARS).toEqual([REVIEWER_API_KEY_ENV_VAR, DEEPSEEK_API_KEY_ENV_VAR]);
    expect(REVIEWER_URL_ENV_VARS).toEqual([REVIEWER_URL_ENV_VAR, DEEPSEEK_URL_ENV_VAR]);
    expect(REVIEWER_API_KEY_ENV_VARS[0]).toBe("REVIEWER_API_KEY");
    expect(REVIEWER_URL_ENV_VARS[0]).toBe("REVIEWER_URL");
  });
});

describe("hasReviewerApiKey — 双名存在性探测", () => {
  it("任一名非空即已配置（推荐名 REVIEWER_API_KEY）", () => {
    expect(hasReviewerApiKey({ REVIEWER_API_KEY: "sk-reviewer" })).toBe(true);
    expect(hasReviewerApiKey({ DEEPSEEK_API_KEY: "sk-legacy" })).toBe(true);
    expect(hasReviewerApiKey({ REVIEWER_API_KEY: "sk-reviewer", DEEPSEEK_API_KEY: "sk-legacy" })).toBe(true);
  });

  it("两名的值均为未设/空白时视为未配置（trim 语义与 resolveApiKey 一致）", () => {
    expect(hasReviewerApiKey({})).toBe(false);
    expect(hasReviewerApiKey({ REVIEWER_API_KEY: "   " })).toBe(false);
    expect(hasReviewerApiKey({ REVIEWER_API_KEY: "", DEEPSEEK_API_KEY: "  " })).toBe(false);
  });

  it("推荐名空白 → 回落旧名（单名空白不算配置，任一名非空即整体已配置）", () => {
    const env = { REVIEWER_API_KEY: "  ", DEEPSEEK_API_KEY: "sk-legacy" };
    expect(hasReviewerApiKey(env)).toBe(true);
  });
});
