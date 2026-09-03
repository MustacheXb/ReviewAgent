import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OPENAI_API_KEY_ENV_VAR } from "../../src/judge/gpt-judge-client.js";
import { judgeRun } from "../../src/judge/orchestrate.js";
import { FakeJudgeClient } from "../../src/judge/fake-judge-client.js";
import {
  makeFinding,
  makeMrCase,
  makeRunResult,
  makeTruth,
  makeTruthLocation,
} from "../metrics/helpers.js";
import { adjudication, match } from "./helpers.js";

const TRUTH_FILE = "src/main/java/com/example/Math.java";
const OTHER_FILE = "src/main/java/com/example/Util.java";
const PARSER_FILE = "src/main/java/com/example/Parser.java";

function threeTruthCase() {
  return makeMrCase({
    caseId: "case-001",
    truth: makeTruth([
      makeTruthLocation({ file: TRUTH_FILE, lineStart: 10, lineEnd: 10 }),
      makeTruthLocation({ file: OTHER_FILE, lineStart: 50, lineEnd: 60 }),
      makeTruthLocation({ file: PARSER_FILE, lineStart: 5, lineEnd: 5 }),
    ]),
  });
}

/** F001 规则 TP(t0)；F002 规则 FP（无文件匹配）；F003 规则 TP(t2) */
function threeFindings() {
  return [
    makeFinding({ id: "F001", file: TRUTH_FILE, line: 10, title: "null deref" }),
    makeFinding({ id: "F002", file: "src/unknown/Wrong.java", line: 999, title: "unrelated" }),
    makeFinding({ id: "F003", file: PARSER_FILE, line: 5, title: "parser bug" }),
  ];
}

describe("judgeRun — 跳过分支（judge 零调用）", () => {
  it("clean MR（truth = null）：FP 为定义性结论，judge 口径 = 规则口径", async () => {
    const judge = FakeJudgeClient.fromAdjudications([]);
    const run = makeRunResult({
      findings: [makeFinding({ id: "F001" })],
    });
    const result = await judgeRun(run, makeMrCase({ truth: null }), judge);
    expect(result.status).toBe("skipped-clean-mr");
    expect(judge.callCount).toBe(0);
    expect(result.judgeCounts).toEqual(result.ruleCounts);
    expect(result.judgeCounts.fp).toBe(1);
    expect(result.judgeVerdicts[0]?.fpReason).toBe("CLEAN_MR");
    expect(result.disagreements).toHaveLength(0);
  });

  it("零 finding：FN 全量，judge 口径计数 {tp:0, fp:0, fn:n}", async () => {
    const judge = FakeJudgeClient.fromAdjudications([]);
    const run = makeRunResult({ findings: [] });
    const result = await judgeRun(run, threeTruthCase(), judge);
    expect(result.status).toBe("skipped-no-findings");
    expect(judge.callCount).toBe(0);
    expect(result.judgeCounts).toEqual({ tp: 0, fp: 0, fn: 3 });
    expect(result.judgeMisses.map((miss) => miss.truthIndex)).toEqual([0, 1, 2]);
    expect(result.judgePrf.recall).toBe(0);
  });
});

describe("judgeRun — judged 双口径合并", () => {
  it("judge 裁定覆盖规则口径：逐 Finding 判定、双口径计数、分歧清单", async () => {
    // judge：F001↔t0（维持 TP）；F002↔t1（FP_RESCUED）；F003 显式拒绝（TP_OVERTURNED）
    const judge = FakeJudgeClient.fromAdjudications([
      adjudication([
        match({ finding: 0, truth: 0, confidence: "high", reason: "same null deref" }),
        match({ finding: 1, truth: 1, confidence: "medium", reason: "same util issue" }),
        match({ finding: 2, truth: null, confidence: "none", reason: "different problem" }),
      ]),
    ]);
    const run = makeRunResult({ findings: threeFindings() });
    const result = await judgeRun(run, threeTruthCase(), judge);

    expect(result.status).toBe("judged");
    expect(judge.callCount).toBe(1);
    // 规则口径：F001 TP、F002 FP、F003 TP
    expect(result.ruleCounts).toEqual({ tp: 2, fp: 1, fn: 1 });
    // judge 口径：F001/F002 TP、F003 FP
    expect(result.judgeCounts).toEqual({ tp: 2, fp: 1, fn: 1 });

    const byId = new Map(result.judgeVerdicts.map((verdict) => [verdict.findingId, verdict]));
    expect(byId.get("F001")).toMatchObject({
      outcome: "TP",
      ruleOutcome: "TP",
      matchedTruthIndex: 0,
      matchConfidence: "high",
      judgeReason: "same null deref",
      lineOffset: 0,
      fpReason: null,
    });
    expect(byId.get("F002")).toMatchObject({
      outcome: "TP",
      ruleOutcome: "FP",
      matchedTruthIndex: 1,
      matchConfidence: "medium",
      fpReason: null,
    });
    expect(byId.get("F003")).toMatchObject({
      outcome: "FP",
      ruleOutcome: "TP",
      matchedTruthIndex: null,
      matchConfidence: "none",
      judgeReason: "different problem",
      fpReason: "JUDGE_REJECTED",
    });

    expect(result.disagreements).toEqual([
      { findingId: "F002", truthIndex: 1, ruleOutcome: "FP", judgeOutcome: "TP", kind: "FP_RESCUED" },
      { findingId: "F003", truthIndex: null, ruleOutcome: "TP", judgeOutcome: "FP", kind: "TP_OVERTURNED" },
    ]);
    // judge FN：t2（被 F003 放弃的真值）
    expect(result.judgeMisses.map((miss) => miss.truthIndex)).toEqual([2]);
  });

  it("judge 未提及的 finding：规则 FP → JUDGE_NO_MATCH；规则 TP（被静默推翻）→ JUDGE_REJECTED", async () => {
    const judge = FakeJudgeClient.fromAdjudications([
      adjudication([match({ finding: 0, truth: 0 })]),
    ]);
    const run = makeRunResult({ findings: threeFindings() });
    const result = await judgeRun(run, threeTruthCase(), judge);
    const f002 = result.judgeVerdicts.find((verdict) => verdict.findingId === "F002");
    const f003 = result.judgeVerdicts.find((verdict) => verdict.findingId === "F003");
    // F002：规则 FP 且 judge 无任何条目 → 无匹配
    expect(f002?.fpReason).toBe("JUDGE_NO_MATCH");
    expect(f002?.matchConfidence).toBeNull();
    // F003：规则 TP 被 judge 忽略 = 隐式推翻
    expect(f003?.fpReason).toBe("JUDGE_REJECTED");
    // F003 的推翻同时构成 TP_OVERTURNED 分歧
    expect(result.disagreements.map((entry) => entry.findingId)).toContain("F003");
  });

  it("judge 裁定的指标经 T10 纯函数重算（PRF / 效率与规则口径分立）", async () => {
    const judge = FakeJudgeClient.fromAdjudications([
      adjudication([match({ finding: 0, truth: 0, confidence: "high" })]),
    ]);
    const run = makeRunResult({ findings: threeFindings() });
    const result = await judgeRun(run, threeTruthCase(), judge);
    // judge 口径：tp1 fp2 fn2 → precision 1/3、recall 1/3、F1 1/3
    expect(result.judgePrf.precision).toBeCloseTo(1 / 3, 10);
    expect(result.judgePrf.recall).toBeCloseTo(1 / 3, 10);
    expect(result.judgePrf.f1).toBeCloseTo(1 / 3, 10);
    // 规则口径独立计算（tp2 fp1 fn1）
    expect(result.rulePrf.precision).toBeCloseTo(2 / 3, 10);
    // 效率指标：RIE 随质量口径变化；CARC 只依赖同一次 Run 的 token/工具成本 → 双口径相同
    expect(result.judgeEfficiency.rie).not.toBe(result.ruleEfficiency.rie);
    expect(result.judgeEfficiency.carc).toBe(result.ruleEfficiency.carc);
  });

  it("judge 请求携带完整卡片与 MR 上下文（含逆补丁法 fixPatch）", async () => {
    const judge = FakeJudgeClient.fromAdjudications([
      adjudication([match({ finding: 0, truth: 0 })]),
    ]);
    const run = makeRunResult({ findings: [makeFinding({ id: "F001" })] });
    const mrCase = makeMrCase({ caseId: "case-001" });
    await judgeRun(run, mrCase, judge);

    const captured = judge.capturedRequests[0];
    expect(captured?.caseId).toBe("case-001");
    expect(captured?.findings[0]).toMatchObject({
      id: "F001",
      file: TRUTH_FILE,
      line: 10,
      category: "CORRECTNESS",
    });
    expect(captured?.truths[0]).toMatchObject({
      id: "TRUTH-1",
      file: TRUTH_FILE,
      lineStart: 10,
      lineEnd: 10,
    });
    expect(captured?.context).toMatchObject({
      issueDescription: mrCase.issueDescription,
      diff: mrCase.diff,
      fixPatch: mrCase.truth?.fixPatch,
    });
  });

  it("judge 输出越界条目 → anomaly 留痕，不整单报废", async () => {
    const judge = FakeJudgeClient.fromAdjudications([
      adjudication([
        match({ finding: 0, truth: 0 }),
        match({ finding: 9, truth: 0 }),
      ]),
    ]);
    const run = makeRunResult({ findings: [makeFinding({ id: "F001" })] });
    const result = await judgeRun(run, makeMrCase(), judge);
    expect(result.status).toBe("judged");
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toContain("out-of-range finding index");
    expect(result.judgeCounts.tp).toBe(1);
  });
});

describe("judgeRun — 有界失败（judge 异常回退规则口径）", () => {
  it("judge 调用失败 → status error、judge 指标回退、无分歧", async () => {
    const judge = new FakeJudgeClient([
      { kind: "fail", error: new Error("connection reset") },
    ]);
    const run = makeRunResult({ findings: [makeFinding({ id: "F001" })] });
    const result = await judgeRun(run, makeMrCase(), judge);
    expect(result.status).toBe("error");
    expect(result.errorMessage).toContain("fell back to the rule screening verdicts");
    expect(result.errorMessage).toContain("connection reset");
    expect(result.judgeCounts).toEqual(result.ruleCounts);
    expect(result.judgePrf).toEqual(result.rulePrf);
    expect(result.judgeVerdicts.map((verdict) => verdict.matchConfidence)).toEqual([null]);
    expect(result.disagreements).toHaveLength(0);
  });

  it("错误信息脱敏：环境变量中的 API key 替换为 [REDACTED]", async () => {
    const original = process.env[OPENAI_API_KEY_ENV_VAR];
    process.env[OPENAI_API_KEY_ENV_VAR] = "sk-secret-leak-check";
    try {
      const judge = new FakeJudgeClient([
        { kind: "fail", error: new Error("auth failed for key sk-secret-leak-check") },
      ]);
      const run = makeRunResult({ findings: [makeFinding({ id: "F001" })] });
      const result = await judgeRun(run, makeMrCase(), judge);
      expect(result.errorMessage).toContain("[REDACTED]");
      expect(result.errorMessage).not.toContain("sk-secret-leak-check");
    } finally {
      if (original === undefined) {
        delete process.env[OPENAI_API_KEY_ENV_VAR];
      } else {
        process.env[OPENAI_API_KEY_ENV_VAR] = original;
      }
    }
  });
});

describe("judgeRun — 入参校验（fail fast）", () => {
  const judge = FakeJudgeClient.fromAdjudications([]);

  it("run.caseId 与 mrCase.caseId 不一致 → 拒绝", async () => {
    const run = makeRunResult({ caseId: "case-A" });
    await expect(judgeRun(run, makeMrCase({ caseId: "case-B" }), judge)).rejects.toThrowError(
      /does not match/,
    );
  });

  it("非法 configId → 拒绝", async () => {
    const run = makeRunResult({});
    (run as { configId: string }).configId = "Z";
    await expect(judgeRun(run, makeMrCase(), judge)).rejects.toThrowError(
      /configId must be one of/,
    );
  });

  it("repIndex 初始为 null（由 judgeEvaluations 回填）", async () => {
    const result = await judgeRun(
      makeRunResult({ findings: [makeFinding({ id: "F001" })] }),
      makeMrCase(),
      FakeJudgeClient.fromAdjudications([adjudication([match({ finding: 0, truth: 0 })])]),
    );
    expect(result.repIndex).toBeNull();
  });
});
