import { describe, expect, it } from "vitest";

import {
  checkExperimentEnv,
  envErrorMessage,
  hasCustomLlmEndpoint,
  reviewerBaseUrlOf,
} from "../../src/experiment/env.js";
import {
  JUDGE_API_KEY_ENV_VAR,
  JUDGE_URL_ENV_VAR,
  OPENAI_API_KEY_ENV_VAR,
  OPENAI_URL_ENV_VAR,
} from "../../src/judge/gpt-judge-client.js";
import {
  DEEPSEEK_API_BASE_URL,
  DEEPSEEK_API_KEY_ENV_VAR,
  DEEPSEEK_URL_ENV_VAR,
  resolveEndpointUrl,
  REVIEWER_API_KEY_ENV_VAR,
  REVIEWER_URL_ENV_VAR,
  REVIEWER_URL_ENV_VARS,
} from "review-llm";

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

describe("checkExperimentEnv — 检视 key 双名（#43：REVIEWER_API_KEY > DEEPSEEK_API_KEY，任一即满足）", () => {
  it("仅设 REVIEWER_API_KEY 即满足（推荐名）", () => {
    const result = checkExperimentEnv({ judge: false }, { [REVIEWER_API_KEY_ENV_VAR]: "role-key" });
    expect(result.satisfied).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("仅设旧名 DEEPSEEK_API_KEY 亦满足（别名兼容，零破坏升级）", () => {
    const result = checkExperimentEnv({ judge: false }, { [DEEPSEEK_API_KEY_ENV_VAR]: "legacy-key" });
    expect(result.satisfied).toBe(true);
  });

  it("两名为空/空白视为未设置 → 不满足，missing 报告双名形态（推荐名在前）", () => {
    const result = checkExperimentEnv(
      { judge: false },
      { [REVIEWER_API_KEY_ENV_VAR]: "   ", [DEEPSEEK_API_KEY_ENV_VAR]: "" },
    );
    expect(result.satisfied).toBe(false);
    expect(result.missing).toEqual(["REVIEWER_API_KEY (or DEEPSEEK_API_KEY)"]);
  });

  it("错误消息双名可见并注明用途，不回显任何 key 值", () => {
    const message = envErrorMessage(["REVIEWER_API_KEY (or DEEPSEEK_API_KEY)"]);
    expect(message).toContain("experiment startup blocked");
    expect(message).toContain(
      "REVIEWER_API_KEY (or DEEPSEEK_API_KEY): required for the review model (reviewer LLM API)",
    );
    expect(message).not.toContain("role-key");
    expect(message).not.toContain("legacy-key");
  });

  it("reviewRuns = false（--report-only）：检视 key 不再必需，judge 仍校验", () => {
    const result = checkExperimentEnv(
      { judge: true, reviewRuns: false },
      { [JUDGE_API_KEY_ENV_VAR]: "role-key" },
    );
    expect(result.satisfied).toBe(true);
  });

  it("全部满足（检视 + judge 双名任一）", () => {
    const result = checkExperimentEnv(
      { judge: true },
      { [REVIEWER_API_KEY_ENV_VAR]: "role-key", [OPENAI_API_KEY_ENV_VAR]: "legacy-key" },
    );
    expect(result.satisfied).toBe(true);
    expect(result.missing).toEqual([]);
  });
});

describe("reviewerBaseUrlOf — 检视链接入点解析（#43 manifest 留痕）", () => {
  it("仅设 REVIEWER_URL：直接取值（尾斜杠归一化）", () => {
    expect(reviewerBaseUrlOf({ [REVIEWER_URL_ENV_VAR]: "https://gateway.example.com/" })).toBe(
      "https://gateway.example.com",
    );
  });

  it("REVIEWER_URL 与旧名 DEEPSEEK_URL 同设：新名优先（与客户端探测序一致）", () => {
    expect(
      reviewerBaseUrlOf({
        [REVIEWER_URL_ENV_VAR]: "https://new.example.com",
        [DEEPSEEK_URL_ENV_VAR]: "https://legacy.example.com",
      }),
    ).toBe("https://new.example.com");
  });

  it("仅设旧名 DEEPSEEK_URL：兼容别名生效", () => {
    expect(reviewerBaseUrlOf({ [DEEPSEEK_URL_ENV_VAR]: "https://relay.example.com" })).toBe(
      "https://relay.example.com",
    );
  });

  it("两名均未设/空白：回落官方缺省端点", () => {
    expect(reviewerBaseUrlOf({})).toBe("https://api.deepseek.com");
    expect(reviewerBaseUrlOf({ [REVIEWER_URL_ENV_VAR]: "   ", [DEEPSEEK_URL_ENV_VAR]: "" })).toBe(
      "https://api.deepseek.com",
    );
  });
});

describe("hasCustomLlmEndpoint — 异构降级触发判定（#43：新旧变量名全覆盖）", () => {
  it("四名均未设/空白 → false（官方缺省端点：同源判定可信，异构校验保持报错）", () => {
    expect(hasCustomLlmEndpoint({})).toBe(false);
    expect(
      hasCustomLlmEndpoint({
        [REVIEWER_URL_ENV_VAR]: "   ",
        [DEEPSEEK_URL_ENV_VAR]: "",
        [JUDGE_URL_ENV_VAR]: "  ",
        [OPENAI_URL_ENV_VAR]: "",
      }),
    ).toBe(false);
  });

  it("检视侧任一名（REVIEWER_URL / 旧名 DEEPSEEK_URL）→ true", () => {
    expect(hasCustomLlmEndpoint({ [REVIEWER_URL_ENV_VAR]: "https://gw.example.com" })).toBe(true);
    expect(hasCustomLlmEndpoint({ [DEEPSEEK_URL_ENV_VAR]: "https://relay.example.com" })).toBe(true);
  });

  it("判定侧任一名（JUDGE_URL / 旧名 OPENAI_URL）→ true", () => {
    expect(hasCustomLlmEndpoint({ [JUDGE_URL_ENV_VAR]: "https://judge-gw.example.com" })).toBe(true);
    expect(hasCustomLlmEndpoint({ [OPENAI_URL_ENV_VAR]: "https://legacy-judge.example.com" })).toBe(
      true,
    );
  });
});

describe("reviewerBaseUrlOf ≡ 客户端构造期 resolveEndpointUrl（#43 manifest 留痕 = 实际接入点的同步契约锚）", () => {
  const clientError = (message: string): Error => new Error(message);

  /**
   * manifest 记录的 base 必须就是客户端实际连的 base（CLI 从不传 baseUrl
   * 选项，故两边只差 /chat/completions 后缀）。此锚防止两处归一化逻辑
   * （探测序 / trim / 尾斜杠）各自漂移——同步契约从注释升格为断言。
   */
  it("同一 env 下：recorded base + /chat/completions = 客户端解析端点（含缺省回落）", () => {
    const envShapes: readonly Record<string, string>[] = [
      { REVIEWER_URL: "https://gw.example.com" },
      { REVIEWER_URL: "https://gw.example.com/" },
      { REVIEWER_URL: "https://gw.example.com///" },
      { REVIEWER_URL: "  https://spaced.example.com  " },
      { DEEPSEEK_URL: "https://relay.example.com" },
      { REVIEWER_URL: "  ", DEEPSEEK_URL: "https://relay.example.com" },
      { REVIEWER_URL: "https://a.example.com", DEEPSEEK_URL: "https://b.example.com" },
      {},
    ];
    for (const env of envShapes) {
      const recorded = reviewerBaseUrlOf(env);
      const endpoint = resolveEndpointUrl({
        defaultBaseUrl: DEEPSEEK_API_BASE_URL,
        envVarNames: REVIEWER_URL_ENV_VARS,
        env,
        clientError,
      });
      expect(endpoint).toBe(`${recorded}/chat/completions`);
    }
  });

  it("协议校验分界如实锚定：resolveEndpointUrl 拒非法协议，reviewerBaseUrlOf 只留痕不校验（客户端构造期 fail fast）", () => {
    const env = { REVIEWER_URL: "ftp://not-http.example.com" };
    expect(reviewerBaseUrlOf(env)).toBe("ftp://not-http.example.com");
    expect(() =>
      resolveEndpointUrl({
        defaultBaseUrl: DEEPSEEK_API_BASE_URL,
        envVarNames: REVIEWER_URL_ENV_VARS,
        env,
        clientError,
      }),
    ).toThrowError(/must start with http/);
  });
});
