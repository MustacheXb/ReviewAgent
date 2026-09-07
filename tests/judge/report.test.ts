import { describe, expect, it } from "vitest";
import type { EvaluationInput } from "../../src/metrics/types.js";
import { flattenJudgeRun, judgeEvaluations } from "../../src/judge/report.js";
import { FakeJudgeClient } from "../../src/judge/fake-judge-client.js";
import {
  makeFinding,
  makeMrCase,
  makeRunResult,
  makeTruth,
} from "../metrics/helpers.js";
import { adjudication, match } from "./helpers.js";

function evaluation(overrides: {
  readonly caseId?: string;
  readonly reps?: number;
  readonly configId?: "A" | "B" | "C" | "D" | "E";
} = {}): EvaluationInput {
  const caseId = overrides.caseId ?? "case-001";
  const configId = overrides.configId ?? "C";
  const reps = Array.from({ length: overrides.reps ?? 2 }, () =>
    makeRunResult({
      caseId,
      configId,
      findings: [makeFinding({ id: "F001" })],
    }),
  );
  return { mrCase: makeMrCase({ caseId, truth: makeTruth() }), runsByConfig: { [configId]: reps } };
}

function judgeScript(count: number): FakeJudgeClient {
  return FakeJudgeClient.fromAdjudications(
    Array.from({ length: count }, () => adjudication([match({ finding: 0, truth: 0 })])),
  );
}

describe("judgeEvaluations — 批量双口径报告", () => {
  it("repIndex 回填、runs 平铺、config 汇总含双口径统计", async () => {
    const judge = judgeScript(2);
    const report = await judgeEvaluations([evaluation({ reps: 2 })], judge);

    expect(report.caseCount).toBe(1);
    const caseReport = report.perCase[0];
    expect(caseReport?.caseId).toBe("case-001");
    const configReport = caseReport?.perConfig.C;
    expect(configReport?.reps.map((rep) => rep.repIndex)).toEqual([0, 1]);
    expect(report.runs).toHaveLength(2);
    expect(report.runs[0]?.repIndex).toBe(0);
    expect(report.runs[1]?.repIndex).toBe(1);
    expect(report.runs.map((run) => run.status)).toEqual(["judged", "judged"]);

    const summary = report.perConfig.C;
    expect(summary?.runCount).toBe(2);
    expect(summary?.rule.sampleCount).toBe(2);
    expect(summary?.judge.sampleCount).toBe(2);
    expect(summary?.rule.values.lineTp?.mean).toBe(1);
    expect(summary?.judge.values.lineTp?.mean).toBe(1);
  });

  it("双口径均值可以不同（judge 推翻规则 TP 的场景）", async () => {
    // 规则：F001 line 10 命中真值 → TP；judge：显式拒绝 → FP
    const judge = FakeJudgeClient.fromAdjudications([
      adjudication([match({ finding: 0, truth: null, confidence: "none" })]),
      adjudication([match({ finding: 0, truth: null, confidence: "none" })]),
    ]);
    const report = await judgeEvaluations([evaluation({ reps: 2 })], judge);
    const summary = report.perConfig.C;
    expect(summary?.rule.values.lineTp?.mean).toBe(1);
    expect(summary?.judge.values.lineTp?.mean).toBe(0);
    expect(summary?.judge.values.lineFp?.mean).toBe(1);
    expect(summary?.judge.values.lineFn?.mean).toBe(1);
  });

  it("仅聚合实际运行过的 config；未运行的不出现", async () => {
    const judge = judgeScript(1);
    const report = await judgeEvaluations([evaluation({ configId: "A", reps: 1 })], judge);
    expect(report.perConfig.A).toBeDefined();
    expect(report.perConfig.C).toBeUndefined();
    expect(report.perCase[0]?.perConfig.A?.reps).toHaveLength(1);
  });

  it("多 case 顺序执行（脚本按序消费，不并行）", async () => {
    const judge = judgeScript(4);
    const report = await judgeEvaluations(
      [evaluation({ caseId: "case-001", reps: 2 }), evaluation({ caseId: "case-002", reps: 2 })],
      judge,
    );
    expect(report.caseCount).toBe(2);
    expect(report.runs.map((run) => run.caseId)).toEqual([
      "case-001",
      "case-001",
      "case-002",
      "case-002",
    ]);
    expect(judge.capturedRequests.map((request) => request.caseId)).toEqual([
      "case-001",
      "case-001",
      "case-002",
      "case-002",
    ]);
  });

  it("空评估列表 fail fast", async () => {
    await expect(judgeEvaluations([], judgeScript(0))).rejects.toThrowError(
      /non-empty array/,
    );
  });

  it("clean MR 的 run 不消耗 judge 脚本（跳过分支）", async () => {
    const judge = judgeScript(1);
    const cleanEvaluation: EvaluationInput = {
      mrCase: makeMrCase({ caseId: "case-clean", truth: null }),
      runsByConfig: { C: [makeRunResult({ caseId: "case-clean", findings: [makeFinding()] })] },
    };
    const report = await judgeEvaluations([cleanEvaluation], judge);
    expect(report.runs[0]?.status).toBe("skipped-clean-mr");
    expect(judge.callCount).toBe(0);
  });
});

describe("flattenJudgeRun — T10 FlatMetrics 投影", () => {
  it("rule 模式投影规则口径计数；file* 镜像 line 计数（judge 单一语义层级）", async () => {
    const judge = judgeScript(1);
    const report = await judgeEvaluations([evaluation({ reps: 1 })], judge);
    const run = report.runs[0];
    if (run === undefined) {
      throw new Error("run missing");
    }
    const flat = flattenJudgeRun(run, "rule");
    expect(flat.lineTp).toBe(run.ruleCounts.tp);
    expect(flat.lineFp).toBe(run.ruleCounts.fp);
    expect(flat.lineFn).toBe(run.ruleCounts.fn);
    expect(flat.fileTp).toBe(run.ruleCounts.tp);
    expect(flat.fileFp).toBe(run.ruleCounts.fp);
    expect(flat.lineF1).toBe(run.rulePrf.f1);
    // token / 工具 / 轮次字段与口径无关（同一次 Run）
    expect(flat.totalTokens).toBe(run.tokens.totalTokens);
    expect(flat.toolCalls).toBe(run.toolCalls);
    expect(flat.rounds).toBe(run.rounds);
  });

  it("judge 模式投影 judge 口径计数", async () => {
    const judge = FakeJudgeClient.fromAdjudications([
      adjudication([match({ finding: 0, truth: null, confidence: "none" })]),
    ]);
    const report = await judgeEvaluations([evaluation({ reps: 1 })], judge);
    const run = report.runs[0];
    if (run === undefined) {
      throw new Error("run missing");
    }
    const flat = flattenJudgeRun(run, "judge");
    expect(flat.lineTp).toBe(0);
    expect(flat.lineFp).toBe(1);
    expect(flat.lineFn).toBe(1);
    expect(flat.linePrecision).toBe(0);
    expect(flat.rie).toBe(run.judgeEfficiency.rie);
    expect(flat.carc).toBe(run.judgeEfficiency.carc);
  });
});
