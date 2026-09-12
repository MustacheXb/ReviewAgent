import { describe, expect, it } from "vitest";
import type { JudgeRequest } from "../../src/judge/contracts.js";
import {
  buildGptJudgeBody,
  JUDGE_MAX_TOKENS,
  JUDGE_TEMPERATURE,
  JUDGE_TOP_P,
  judgeCompletionCapOf,
  REASONING_JUDGE_MAX_TOKENS,
} from "../../src/judge/gpt-request-mapper.js";

/**
 * 请求体构造（#39）：模型族感知 completion 预算。
 * 语义界定——max_tokens 是防截断的容量上界，不是校准参数：
 * temperature / top_p 对所有模型恒论文锁值；8192 锚按 gpt-5.2-pro
 * 纯内容剖面所定，glm-5.3 等推理模型 completion 含 reasoning tokens
 * （#34 探针实测 3-finding 裁定 reasoning≈6k，8192 被 reasoning 吃满后
 * content=0 直接截断），需更大信封。
 */

function minimalRequest(): JudgeRequest {
  return {
    caseId: "case-001",
    findings: [
      { id: "F001", title: "t", description: "d", file: "f", line: 1, category: null, evidence: [] },
    ],
    truths: [
      { id: "TRUTH-1", title: "t", description: "d", file: null, lineStart: null, lineEnd: null, category: null, severity: null },
    ],
    context: null,
  };
}

describe("judgeCompletionCapOf — 模型族感知 completion 预算（#39）", () => {
  it("缺省 gpt-5.2-pro = 论文协议锚 8192（容量回归锁定，不随本票漂移）", () => {
    expect(judgeCompletionCapOf("gpt-5.2-pro")).toBe(JUDGE_MAX_TOKENS);
    expect(JUDGE_MAX_TOKENS).toBe(8_192);
  });

  it("glm 系推理模型 = 32768（实测需求 6447 的 5 倍余量）", () => {
    expect(judgeCompletionCapOf("glm-5-3-260814")).toBe(REASONING_JUDGE_MAX_TOKENS);
    expect(REASONING_JUDGE_MAX_TOKENS).toBe(32_768);
  });
});

describe("buildGptJudgeBody — max_tokens 随模型族、协议参数不漂移（#39）", () => {
  it("缺省（gpt-5.2-pro）max_tokens = 8192 论文锚", () => {
    const body = buildGptJudgeBody(minimalRequest());
    expect(body.model).toBe("gpt-5.2-pro");
    expect(body.max_tokens).toBe(8_192);
  });

  it("glm-5.3 max_tokens = 32768；temperature / top_p 仍论文锁值", () => {
    const body = buildGptJudgeBody(minimalRequest(), { model: "glm-5-3-260814" });
    expect(body.model).toBe("glm-5-3-260814");
    expect(body.max_tokens).toBe(32_768);
    // 校准参数不随模型漂移（#39 票面语义界定：容量 ≠ 协议）
    expect(body.temperature).toBe(JUDGE_TEMPERATURE);
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(JUDGE_TOP_P);
    expect(body.top_p).toBe(0.95);
  });
});
