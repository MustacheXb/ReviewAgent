import { describe, expect, it } from "vitest";

import { checkExperimentEnv, envErrorMessage } from "../../src/experiment/env.js";
import { JUDGE_API_KEY_ENV_VAR, OPENAI_API_KEY_ENV_VAR } from "../../src/judge/gpt-judge-client.js";

/**
 * 实验启动环境预检（#42 起 judge key 接受角色名/旧名任一）：
 * JUDGE_API_KEY（推荐）与 OPENAI_API_KEY（兼容别名）任一非空即满足；
 * 缺失时报告形态 "JUDGE_API_KEY (or OPENAI_API_KEY)"，两个名字都可见。
 */

describe("checkExperimentEnv — judge key 双名（#42：新名 > 旧名，任一即满足）", () => {
  it("仅设 JUDGE_API_KEY 即满足 judge 阶段要求", () => {
    const result = checkExperimentEnv(
      { judge: true, reviewRuns: false },
      { [JUDGE_API_KEY_ENV_VAR]: "role-key" },
    );
    expect(result.satisfied).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("仅设旧名 OPENAI_API_KEY 亦满足（别名兼容，零破坏升级）", () => {
    const result = checkExperimentEnv(
      { judge: true, reviewRuns: false },
      { [OPENAI_API_KEY_ENV_VAR]: "legacy-key" },
    );
    expect(result.satisfied).toBe(true);
  });

  it("两名同设不冲突（client 层新名优先，预检只看存在性）", () => {
    const result = checkExperimentEnv(
      { judge: true, reviewRuns: false },
      { [JUDGE_API_KEY_ENV_VAR]: "role-key", [OPENAI_API_KEY_ENV_VAR]: "legacy-key" },
    );
    expect(result.satisfied).toBe(true);
  });

  it("两名为空/空白视为未设置 → 不满足，missing 报告双名形态", () => {
    const result = checkExperimentEnv(
      { judge: true, reviewRuns: false },
      { [JUDGE_API_KEY_ENV_VAR]: "   ", [OPENAI_API_KEY_ENV_VAR]: "" },
    );
    expect(result.satisfied).toBe(false);
    expect(result.missing).toEqual(["JUDGE_API_KEY (or OPENAI_API_KEY)"]);
  });

  it("错误消息双名可见并注明用途，不回显任何 key 值", () => {
    const message = envErrorMessage(["JUDGE_API_KEY (or OPENAI_API_KEY)"]);
    expect(message).toContain("experiment startup blocked");
    expect(message).toContain("JUDGE_API_KEY (or OPENAI_API_KEY): required for LLM-as-judge stage");
    expect(message).not.toContain("role-key");
    expect(message).not.toContain("legacy-key");
  });
});

describe("checkExperimentEnv — 检视主模型 key（单名，REVIEWER_* 别名属 #43）", () => {
  it("缺省 reviewRuns = true：DEEPSEEK_API_KEY 必需，缺失列入清单", () => {
    const result = checkExperimentEnv({ judge: false }, { DEEPSEEK_API_KEY: "  " });
    expect(result.satisfied).toBe(false);
    expect(result.missing).toEqual(["DEEPSEEK_API_KEY"]);
    expect(envErrorMessage(["DEEPSEEK_API_KEY"])).toContain(
      "DEEPSEEK_API_KEY: required for review model deepseek-v4-flash (DeepSeek API)",
    );
  });

  it("reviewRuns = false（--report-only）：DEEPSEEK_API_KEY 不再必需，judge 仍校验", () => {
    const result = checkExperimentEnv(
      { judge: true, reviewRuns: false },
      { [JUDGE_API_KEY_ENV_VAR]: "role-key" },
    );
    expect(result.satisfied).toBe(true);
  });

  it("全部满足（DEEPSEEK + JUDGE 双名任一）", () => {
    const result = checkExperimentEnv(
      { judge: true },
      { DEEPSEEK_API_KEY: "ds-key", [OPENAI_API_KEY_ENV_VAR]: "legacy-key" },
    );
    expect(result.satisfied).toBe(true);
    expect(result.missing).toEqual([]);
  });
});
