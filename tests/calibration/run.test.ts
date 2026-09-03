import { describe, expect, it } from "vitest";
import type { JudgeAdjudication, JudgeMatch } from "../../src/judge/contracts.js";
import { FakeJudgeClient } from "../../src/judge/fake-judge-client.js";
import { runCalibration } from "../../src/calibration/run.js";
import type { CalibrationSample, McrOfficialJudgment } from "../../src/calibration/mcr-bench.js";

function findingCard(id: string): { readonly id: string; readonly title: string; readonly description: string; readonly file: null; readonly line: null; readonly category: null; readonly evidence: readonly [] } {
  return { id, title: `title-${id}`, description: `description-${id}`, file: null, line: null, category: null, evidence: [] };
}

function truthCard(id: string): { readonly id: string; readonly title: string; readonly description: string; readonly file: null; readonly lineStart: null; readonly lineEnd: null; readonly category: null; readonly severity: null } {
  return { id, title: `title-${id}`, description: `description-${id}`, file: null, lineStart: null, lineEnd: null, category: null, severity: null };
}

function makeSample(args: {
  readonly taskId: string;
  readonly modelName?: string;
  readonly findingCount?: number;
  readonly truthCount?: number;
  readonly officialMatches?: readonly { readonly model: number; readonly truth: number | null }[];
  readonly officialCounts?: { readonly tp: number; readonly fp: number; readonly fn: number };
}): CalibrationSample {
  const findingCount = args.findingCount ?? 2;
  const truthCount = args.truthCount ?? 2;
  const official: McrOfficialJudgment = {
    taskId: args.taskId,
    tp: args.officialCounts?.tp ?? null,
    fp: args.officialCounts?.fp ?? null,
    fn: args.officialCounts?.fn ?? null,
    matches: (args.officialMatches ?? []).map((entry) => ({
      modelDefectIndex: entry.model,
      groundTruthDefectIndex: entry.truth,
      matchConfidence: "high",
      matchReason: "official reason",
    })),
    unmatchedModel: [],
    unmatchedGroundTruth: [],
  };
  return {
    taskId: args.taskId,
    modelName: args.modelName ?? "gpt-5.2",
    request: {
      caseId: args.taskId,
      findings: Array.from({ length: findingCount }, (_, i) => findingCard(`m${i + 1}`)),
      truths: Array.from({ length: truthCount }, (_, i) => truthCard(`d${i + 1}`)),
      context: null,
    },
    official,
  };
}

function reply(matches: readonly { readonly finding: number; readonly truth: number | null; readonly confidence?: JudgeMatch["matchConfidence"] }[]): JudgeAdjudication {
  return {
    matches: matches.map((entry) => ({
      findingIndex: entry.finding,
      truthIndex: entry.truth,
      matchConfidence: entry.confidence ?? "high",
      matchReason: "judge reason",
    })),
    summary: null,
  };
}

describe("runCalibration — 完全一致场景", () => {
  it("judge 裁定与官方判定逐对一致 → kappa 1、一致率 1、集合完全一致率 100%", async () => {
    const samples = [
      makeSample({ taskId: "A_round1", officialMatches: [{ model: 1, truth: 1 }] }),
      makeSample({ taskId: "B_round1", officialMatches: [{ model: 1, truth: 2 }, { model: 2, truth: 1 }] }),
    ];
    const judge = FakeJudgeClient.fromAdjudications([
      reply([{ finding: 0, truth: 0 }]),
      reply([{ finding: 0, truth: 1 }, { finding: 1, truth: 0 }]),
    ]);
    const report = await runCalibration(samples, judge);
    expect(report.sampleCount).toBe(2);
    expect(report.comparedCount).toBe(2);
    expect(report.errorCount).toBe(0);
    expect(report.agreementRate).toBe(1);
    expect(report.kappa).toBe(1);
    expect(report.exactPairMatchCount).toBe(2);
    expect(report.perSample.every((result) => result.exactPairMatch)).toBe(true);
  });

  it("judge 计数与官方计数逐样本对照（tp/fp/fn）", async () => {
    const samples = [
      makeSample({
        taskId: "A_round1",
        officialMatches: [{ model: 1, truth: 1 }],
        officialCounts: { tp: 1, fp: 1, fn: 1 },
      }),
    ];
    const judge = FakeJudgeClient.fromAdjudications([reply([{ finding: 0, truth: 0 }])]);
    const report = await runCalibration(samples, judge);
    const result = report.perSample[0];
    expect(result).toMatchObject({
      status: "compared",
      judgeTp: 1,
      judgeFp: 1,
      judgeFn: 1,
      officialTp: 1,
      officialFp: 1,
      officialFn: 1,
    });
  });
});

describe("runCalibration — 部分分歧场景", () => {
  it("官方 (0,0)、judge (0,1)：混淆矩阵按 2×2 宇宙累计，kappa 正确计算", async () => {
    const samples = [makeSample({ taskId: "A_round1", officialMatches: [{ model: 1, truth: 1 }] })];
    const judge = FakeJudgeClient.fromAdjudications([reply([{ finding: 0, truth: 1 }])]);
    const report = await runCalibration(samples, judge);
    // 宇宙 4 对：both 0、officialOnly 1、judgeOnly 1、neither 2 → po 0.5、kappa −1/3
    expect(report.confusion).toEqual({ both: 0, officialOnly: 1, judgeOnly: 1, neither: 2 });
    expect(report.agreementRate).toBeCloseTo(0.5, 12);
    expect(report.kappa).toBeCloseTo(-1 / 3, 12);
    expect(report.exactPairMatchCount).toBe(0);
  });

  it("多样本累计 + 阈值默认官方宽松口径（confidence none 仍计命中）", async () => {
    const samples = [
      makeSample({ taskId: "A_round1", findingCount: 1, truthCount: 1, officialMatches: [{ model: 1, truth: 1 }] }),
      makeSample({ taskId: "B_round1", findingCount: 1, truthCount: 2, officialMatches: [{ model: 1, truth: 1 }] }),
    ];
    const judge = FakeJudgeClient.fromAdjudications([
      reply([{ finding: 0, truth: 0 }]),
      // calibration 默认 threshold "none"：官方宽松口径，confidence none 也计命中
      reply([{ finding: 0, truth: 0, confidence: "none" }]),
    ]);
    const report = await runCalibration(samples, judge);
    expect(report.comparedCount).toBe(2);
    expect(report.exactPairMatchCount).toBe(2);
    // 3 个候选对全部一致（po=1、pe=5/9）→ kappa = 1
    expect(report.confusion).toEqual({ both: 2, officialOnly: 0, judgeOnly: 0, neither: 1 });
    expect(report.kappa).toBe(1);
  });
});

describe("runCalibration — 有界失败", () => {
  it("单样本 judge 失败：不中断、官方兜底计数、不计入一致性统计", async () => {
    const samples = [
      makeSample({ taskId: "A_round1", officialMatches: [{ model: 1, truth: 1 }] }),
      makeSample({ taskId: "B_round1", findingCount: 3, truthCount: 2, officialMatches: [] }),
    ];
    const judge = new FakeJudgeClient([
      { kind: "reply", adjudication: reply([{ finding: 0, truth: 0 }]) },
      { kind: "fail", error: new Error("judge exploded") },
    ]);
    const report = await runCalibration(samples, judge);
    expect(report.sampleCount).toBe(2);
    expect(report.comparedCount).toBe(1);
    expect(report.errorCount).toBe(1);
    expect(report.errors).toEqual([
      { taskId: "B_round1", modelName: "gpt-5.2", message: "judge exploded" },
    ]);
    // 兜底口径：tp=0 / fp=全部模型缺陷 / fn=全部真值
    const failed = report.perSample[1];
    expect(failed).toMatchObject({ status: "error", judgeTp: 0, judgeFp: 3, judgeFn: 2, exactPairMatch: false });
    expect(failed?.confusion).toEqual({ both: 0, officialOnly: 0, judgeOnly: 0, neither: 0 });
    // 一致性只来自成功样本（2×2 宇宙：both 1、neither 3 → kappa 1）
    expect(report.confusion).toEqual({ both: 1, officialOnly: 0, judgeOnly: 0, neither: 3 });
    expect(report.kappa).toBe(1);
  });

  it("错误明细截留有界（maxErrorEntries），总数仍完整", async () => {
    const samples = [
      makeSample({ taskId: "A_round1" }),
      makeSample({ taskId: "B_round1" }),
      makeSample({ taskId: "C_round1" }),
    ];
    const judge = new FakeJudgeClient([
      { kind: "fail", error: new Error("boom-1") },
      { kind: "fail", error: new Error("boom-2") },
      { kind: "fail", error: new Error("boom-3") },
    ]);
    const report = await runCalibration(samples, judge, { maxErrorEntries: 2 });
    expect(report.errorCount).toBe(3);
    expect(report.errors).toHaveLength(2);
    expect(report.comparedCount).toBe(0);
  });
});

describe("runCalibration — 分模型聚合", () => {
  it("按 modelName 分组给出各自 kappa / 一致率 / 样本数", async () => {
    const samples = [
      makeSample({ taskId: "A_round1", modelName: "gpt-5.2", officialMatches: [{ model: 1, truth: 1 }] }),
      makeSample({ taskId: "B_round1", modelName: "glm-4.7", officialMatches: [{ model: 1, truth: 1 }] }),
      makeSample({ taskId: "C_round1", modelName: "glm-4.7", officialMatches: [] }),
    ];
    const judge = FakeJudgeClient.fromAdjudications([
      reply([{ finding: 0, truth: 0 }]), // gpt-5.2 与官方一致
      reply([{ finding: 0, truth: 0 }]), // glm-4.7 第一条一致
      reply([]), // glm-4.7 第二条 judge 全拒（官方无命中 → 仍一致）
    ]);
    const report = await runCalibration(samples, judge);
    expect(report.perModel).toHaveLength(2);
    const glm = report.perModel.find((entry) => entry.modelName === "glm-4.7");
    expect(glm).toMatchObject({ sampleCount: 2, errorCount: 0, exactPairMatchCount: 2, kappa: 1 });
    const gpt = report.perModel.find((entry) => entry.modelName === "gpt-5.2");
    expect(gpt).toMatchObject({ sampleCount: 1, kappa: 1 });
  });

  it("非法入参 fail fast", async () => {
    await expect(
      runCalibration(null as unknown as readonly CalibrationSample[], FakeJudgeClient.fromAdjudications([])),
    ).rejects.toThrowError(/samples must be an array/);
  });
});
