import { describe, expect, it } from "vitest";
import type { EvaluationInput } from "../../src/metrics/types.js";
import type { JudgeRunResult } from "../../src/judge/orchestrate.js";
import { judgeEvaluations } from "../../src/judge/report.js";
import { FakeJudgeClient } from "../../src/judge/fake-judge-client.js";
import {
  buildHumanReviewForms,
  buildReviewUnits,
  buildSamplingPlan,
  validateHumanVerdictSubmission,
  HUMAN_REVIEW_PROTOCOL_VERSION,
  DEFAULT_HUMAN_REVIEW_RATE,
} from "../../src/sampling/review-plan.js";
import {
  makeFinding,
  makeMrCase,
  makeRunResult,
  makeTruth,
} from "../metrics/helpers.js";
import { adjudication, match } from "../judge/helpers.js";

function evaluation(caseId = "case-001", reps = 2): EvaluationInput {
  return {
    mrCase: makeMrCase({ caseId, truth: makeTruth() }),
    runsByConfig: {
      C: Array.from({ length: reps }, () =>
        makeRunResult({ caseId, configId: "C", findings: [makeFinding({ id: "F001" })] }),
      ),
    },
  };
}

/** rep1：judge 维持 TP（一致层）；rep2：judge 显式拒绝（分歧层 + 一条漏检条目） */
async function chainFixture(): Promise<{
  readonly evaluations: EvaluationInput[];
  readonly judgeResults: readonly JudgeRunResult[];
}> {
  const judge = FakeJudgeClient.fromAdjudications([
    adjudication([match({ finding: 0, truth: 0, confidence: "high" })]),
    adjudication([match({ finding: 0, truth: null, confidence: "none", reason: "not the same problem" })]),
  ]);
  const evaluations = [evaluation()];
  const report = await judgeEvaluations(evaluations, judge);
  return { evaluations, judgeResults: report.runs };
}

describe("buildReviewUnits — 抽样单元构建与 judge 结果对齐", () => {
  it("键格式 `${caseId}:${configId}:rep${n}`，judge 结果按键精确对齐", async () => {
    const { evaluations, judgeResults } = await chainFixture();
    const units = buildReviewUnits(evaluations, judgeResults);
    expect(units.map((unit) => unit.key)).toEqual(["case-001:C:rep1", "case-001:C:rep2"]);
    expect(units[0]?.judgeResult?.status).toBe("judged");
    expect(units[1]?.judgeResult?.disagreements).toHaveLength(1);
  });

  it("分层：judge 推翻规则的运行落 disagreement 层，其余落 agreement 层", async () => {
    const { evaluations, judgeResults } = await chainFixture();
    const units = buildReviewUnits(evaluations, judgeResults);
    expect(units[0]?.stratum).toBe("agreement");
    expect(units[1]?.stratum).toBe("disagreement");
  });

  it("无 judge 结果的运行落 no-judge 层", () => {
    const units = buildReviewUnits([evaluation()], []);
    expect(units).toHaveLength(2);
    expect(units.every((unit) => unit.stratum === "no-judge")).toBe(true);
    expect(units.every((unit) => unit.judgeResult === null)).toBe(true);
  });

  it("覆盖全部实际运行的 config", () => {
    const twoConfigs: EvaluationInput = {
      mrCase: makeMrCase({ caseId: "case-002", truth: makeTruth() }),
      runsByConfig: {
        A: [makeRunResult({ caseId: "case-002", configId: "A", findings: [] })],
        E: [makeRunResult({ caseId: "case-002", configId: "E", findings: [] })],
      },
    };
    const units = buildReviewUnits([twoConfigs], []);
    expect(units.map((unit) => unit.key).sort()).toEqual(["case-002:A:rep1", "case-002:E:rep1"]);
  });
});

describe("buildSamplingPlan — 10% 抽检计划", () => {
  it("缺省 rate 0.1，种子决定性可复现", async () => {
    const { evaluations, judgeResults } = await chainFixture();
    const units = buildReviewUnits(evaluations, judgeResults);
    const first = buildSamplingPlan(units, { seed: "poc1-review-2026" });
    const second = buildSamplingPlan(units, { seed: "poc1-review-2026" });
    expect(first.rate).toBe(DEFAULT_HUMAN_REVIEW_RATE);
    expect(first.selected.map((unit) => unit.key)).toEqual(second.selected.map((unit) => unit.key));
    // 分歧层保底：2 单元 × 0.1 → 每层 1 个
    expect(first.sampleSize).toBe(2);
  });
});

describe("buildHumanReviewForms — 抽检表单", () => {
  it("入选单元各一份表单：MR 材料 + 全量裁定条目（FINDING + MISSED_TRUTH）", async () => {
    const { evaluations, judgeResults } = await chainFixture();
    const units = buildReviewUnits(evaluations, judgeResults);
    const plan = buildSamplingPlan(units, { seed: "poc1-review-2026", rate: 1 });
    const forms = buildHumanReviewForms(plan);
    expect(forms).toHaveLength(2);

    const disagreeForm = forms.find((form) => form.unitKey === "case-001:C:rep2");
    if (disagreeForm === undefined) {
      throw new Error("rep2 form missing");
    }
    expect(disagreeForm.protocolVersion).toBe(HUMAN_REVIEW_PROTOCOL_VERSION);
    expect(disagreeForm.mr.diff).toBe(evaluations[0]?.mrCase.diff);
    expect(disagreeForm.mr.issueDescription).toBe(evaluations[0]?.mrCase.issueDescription);
    expect(disagreeForm.mr.truthLocations).toEqual(evaluations[0]?.mrCase.truth?.locations);
    expect(disagreeForm.mr.fixPatch).toBe(evaluations[0]?.mrCase.truth?.fixPatch);

    const findingItem = disagreeForm.items.find((item) => item.kind === "FINDING");
    expect(findingItem).toMatchObject({
      findingId: "F001",
      ruleOutcome: "TP",
      judgeOutcome: "FP",
      disagreement: true,
      judgeReason: "not the same problem",
    });
    const missItem = disagreeForm.items.find((item) => item.kind === "MISSED_TRUTH");
    expect(missItem).toMatchObject({ truthIndex: 0, findingId: null });
    expect(missItem?.truth).toMatchObject({ file: "src/main/java/com/example/Math.java" });
  });

  it("一致运行的表单无漏检条目、disagreement 标记为 false", async () => {
    const { evaluations, judgeResults } = await chainFixture();
    const units = buildReviewUnits(evaluations, judgeResults);
    const forms = buildHumanReviewForms(buildSamplingPlan(units, { seed: "s", rate: 1 }));
    const agreeForm = forms.find((form) => form.unitKey === "case-001:C:rep1");
    expect(agreeForm?.items).toHaveLength(1);
    expect(agreeForm?.items[0]?.disagreement).toBe(false);
    expect(agreeForm?.items[0]?.judgeOutcome).toBe("TP");
  });
});

describe("validateHumanVerdictSubmission — 边界校验", () => {
  async function formFixture(): Promise<ReturnType<typeof buildHumanReviewForms>[number]> {
    const { evaluations, judgeResults } = await chainFixture();
    const units = buildReviewUnits(evaluations, judgeResults);
    const forms = buildHumanReviewForms(buildSamplingPlan(units, { seed: "s", rate: 1 }));
    const disagreeForm = forms.find((form) => form.unitKey === "case-001:C:rep2");
    if (disagreeForm === undefined) {
      throw new Error("rep2 form missing");
    }
    return disagreeForm;
  }

  it("完整合法提交（FINDING: TP/FP；MISSED_TRUTH: FN/TP）→ 无错误", async () => {
    const form = await formFixture();
    const errors = validateHumanVerdictSubmission(form, {
      unitKey: form.unitKey,
      verdicts: [
        { itemId: "F001", verdict: "FP", comment: "judge 拒绝正确" },
        { itemId: "miss:0", verdict: "FN", comment: null },
      ],
    });
    expect(errors).toEqual([]);
  });

  it("unitKey 不匹配 → 错误", async () => {
    const form = await formFixture();
    const errors = validateHumanVerdictSubmission(form, {
      unitKey: "other-case:C:rep1",
      verdicts: [],
    });
    expect(errors.some((message) => message.includes("does not match"))).toBe(true);
  });

  it("未知 itemId / 重复 itemId → 错误", async () => {
    const form = await formFixture();
    const errors = validateHumanVerdictSubmission(form, {
      unitKey: form.unitKey,
      verdicts: [
        { itemId: "F999", verdict: "TP", comment: null },
        { itemId: "F001", verdict: "TP", comment: null },
        { itemId: "F001", verdict: "FP", comment: null },
      ],
    });
    expect(errors.some((message) => message.includes("F999"))).toBe(true);
    expect(errors.some((message) => message.includes("duplicated"))).toBe(true);
  });

  it("verdict 词表按条目类型校验（FINDING 拒 FN；MISSED_TRUTH 拒 FP）", async () => {
    const form = await formFixture();
    const errors = validateHumanVerdictSubmission(form, {
      unitKey: form.unitKey,
      verdicts: [
        { itemId: "F001", verdict: "FN", comment: null },
        { itemId: "miss:0", verdict: "FP", comment: null },
      ],
    });
    expect(errors.some((message) => message.includes("invalid for FINDING"))).toBe(true);
    expect(errors.some((message) => message.includes("invalid for MISSED_TRUTH"))).toBe(true);
  });

  it("覆盖不全（缺漏检条目裁定）→ 错误", async () => {
    const form = await formFixture();
    const errors = validateHumanVerdictSubmission(form, {
      unitKey: form.unitKey,
      verdicts: [{ itemId: "F001", verdict: "TP", comment: null }],
    });
    expect(errors.some((message) => message.includes("miss:0"))).toBe(true);
    expect(errors.some((message) => message.includes("complete coverage"))).toBe(true);
  });

  it("comment 非字符串 → 错误；非对象提交 → 顶层错误", async () => {
    const form = await formFixture();
    const errors = validateHumanVerdictSubmission(form, {
      unitKey: form.unitKey,
      verdicts: [{ itemId: "F001", verdict: "TP", comment: 42 as unknown as string }],
    });
    expect(errors.some((message) => message.includes("comment must be"))).toBe(true);
    expect(
      validateHumanVerdictSubmission(form, null as unknown as Parameters<typeof validateHumanVerdictSubmission>[1]),
    ).toEqual(["submission must be a HumanVerdictSubmission object"]);
  });
});
