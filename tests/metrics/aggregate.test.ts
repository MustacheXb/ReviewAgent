import { describe, expect, it } from "vitest";
import { buildMetricsReport, evaluateCase, meanFlatMetrics } from "../../src/metrics/aggregate.js";
import { DEFAULT_METRICS_OPTIONS } from "../../src/metrics/types.js";
import type { EvaluationInput, MetricsOptions } from "../../src/metrics/types.js";
import { usage } from "../helpers/llm-script.js";
import { makeFinding, makeMrCase, makeRunResult, makeTruth, makeTruthLocation } from "./helpers.js";

/**
 * 分层缓存报告与重复聚合（issue #11 / spec #1 user story 26-27）：
 * rep1（冷启动）单列，rep2+（热稳定）为主口径；≥3 重复报均值 ± 标准差；
 * 跨 case 聚合每 case 等权（先 case 内热均值、再跨 case 均值 ± 标准差）。
 */

const TRUTH_FILE = "src/main/java/com/example/Math.java";

function caseWithTruth(caseId: string): ReturnType<typeof makeMrCase> {
  return makeMrCase({
    caseId,
    truth: makeTruth([makeTruthLocation({ file: TRUTH_FILE, lineStart: 10, lineEnd: 10 })]),
  });
}

function repRuns(caseId: string, configId: "A" | "C" | "E", usages: ReturnType<typeof usage>[]) {
  return usages.map((usageValue) =>
    makeRunResult({
      caseId,
      configId,
      findings: [makeFinding({ file: TRUTH_FILE, line: 10 })],
      usage: usageValue,
    }),
  );
}

describe("evaluateCase — rep stratification (rep1 cold, rep2+ hot)", () => {
  it("reports rep1 separately and aggregates rep2+ as the primary measure", () => {
    const mrCase = caseWithTruth("case-001");
    const runs = repRuns("case-001", "E", [
      usage(1000, 100),
      usage(1000, 500, { cacheReadTokens: 1000 }),
      usage(1000, 0, { cacheReadTokens: 3000 }),
    ]);
    const report = evaluateCase({ mrCase, runsByConfig: { E: runs } });

    const configE = report.perConfig.E;
    expect(report.caseId).toBe("case-001");
    expect(configE?.repCount).toBe(3);
    expect(configE?.reps).toHaveLength(3);

    // rep1（冷）单列：不参与统计
    expect(configE?.cold?.tokens.totalTokens).toBe(1100);
    expect(configE?.cold?.tokens.cacheHitRate).toBe(0);

    // rep2+（热）主口径：mean ± sample std
    expect(configE?.hot?.sampleCount).toBe(2);
    expect(configE?.hot?.values.totalTokens?.count).toBe(2);
    expect(configE?.hot?.values.totalTokens?.mean).toBe(3250);
    expect(configE?.hot?.values.totalTokens?.std).toBeCloseTo(750 * Math.SQRT2, 9);
    expect(configE?.hot?.values.cacheHitRate?.mean).toBe(0.625);
    expect(configE?.hot?.values.cacheHitRate?.std).toBeCloseTo(Math.sqrt(0.03125), 12);
    expect(configE?.hot?.values.lineRecall).toEqual({ count: 2, mean: 1, std: 0 });
    expect(configE?.hot?.values.linePrecision?.mean).toBe(1);
  });

  it("returns a null hot measure when a config ran only once", () => {
    const mrCase = caseWithTruth("case-001");
    const report = evaluateCase({
      mrCase,
      runsByConfig: { A: repRuns("case-001", "A", [usage(100, 10)]) },
    });
    expect(report.perConfig.A?.repCount).toBe(1);
    expect(report.perConfig.A?.cold).not.toBeNull();
    expect(report.perConfig.A?.hot).toBeNull();
  });

  it("only lists configs that actually ran", () => {
    const mrCase = caseWithTruth("case-001");
    const report = evaluateCase({
      mrCase,
      runsByConfig: { C: repRuns("case-001", "C", [usage(1, 1), usage(1, 1)]) },
    });
    expect(report.perConfig.C).toBeDefined();
    expect(report.perConfig.A).toBeUndefined();
    expect(report.perConfig.E).toBeUndefined();
  });

  it("threads screening options through to every rep", () => {
    const mrCase = caseWithTruth("case-001");
    const runs = [
      makeRunResult({ caseId: "case-001", configId: "A", findings: [makeFinding({ file: TRUTH_FILE, line: 11 })], usage: usage(10, 10) }),
      makeRunResult({ caseId: "case-001", configId: "A", findings: [makeFinding({ file: TRUTH_FILE, line: 11 })], usage: usage(10, 10) }),
    ];
    const strict = evaluateCase({ mrCase, runsByConfig: { A: runs } });
    expect(strict.perConfig.A?.hot?.values.lineRecall?.mean).toBe(0);

    const tolerant: MetricsOptions = {
      ...DEFAULT_METRICS_OPTIONS,
      screening: { ...DEFAULT_METRICS_OPTIONS.screening, lineTolerance: 1 },
    };
    const loose = evaluateCase({ mrCase, runsByConfig: { A: runs } }, tolerant);
    expect(loose.perConfig.A?.hot?.values.lineRecall?.mean).toBe(1);
  });
});

describe("buildMetricsReport — cross-case aggregation (equal weight per case)", () => {
  it("aggregates hot case means across cases with mean ± std", () => {
    const case1: EvaluationInput = {
      mrCase: caseWithTruth("case-001"),
      runsByConfig: {
        E: repRuns("case-001", "E", [
          usage(1000, 100),
          usage(1000, 500, { cacheReadTokens: 1000 }),
          usage(1000, 0, { cacheReadTokens: 3000 }),
        ]),
      },
    };
    const case2: EvaluationInput = {
      mrCase: caseWithTruth("case-002"),
      runsByConfig: {
        E: repRuns("case-002", "E", [usage(500, 500), usage(2000, 0), usage(4000, 0)]),
      },
    };
    const report = buildMetricsReport([case1, case2]);

    expect(report.caseCount).toBe(2);
    const configE = report.perConfig.E;
    expect(configE?.caseCount).toBe(2);
    expect(configE?.hotCaseCount).toBe(2);

    // 热主口径：case 热均值 [3250, 3000] → 均值 3125、标准差 125√2
    expect(configE?.hot?.sampleCount).toBe(2);
    expect(configE?.hot?.values.totalTokens?.count).toBe(2);
    expect(configE?.hot?.values.totalTokens?.mean).toBe(3125);
    expect(configE?.hot?.values.totalTokens?.std).toBeCloseTo(125 * Math.SQRT2, 9);
    // 冷单列：跨 case 均值 [1100, 1000] → 1050、标准差 50√2
    expect(configE?.cold?.values.totalTokens?.count).toBe(2);
    expect(configE?.cold?.values.totalTokens?.mean).toBe(1050);
    expect(configE?.cold?.values.totalTokens?.std).toBeCloseTo(50 * Math.SQRT2, 9);
    // 命中率：case 热均值 [0.625, 0] → 0.3125
    expect(configE?.hot?.values.cacheHitRate?.mean).toBe(0.3125);

    // perCase 摘要
    expect(configE?.perCase).toHaveLength(2);
    expect(configE?.perCase[0]).toMatchObject({ caseId: "case-001", repCount: 3 });
    expect(configE?.perCase[0]?.hot?.totalTokens).toBe(3250);
    expect(configE?.perCase[1]?.hot?.totalTokens).toBe(3000);
  });

  it("skips undefined metrics (clean MR) instead of counting them as zero", () => {
    const cleanCase: EvaluationInput = {
      mrCase: makeMrCase({ caseId: "case-clean", truth: null }),
      runsByConfig: {
        A: [
          makeRunResult({ caseId: "case-clean", configId: "A", findings: [makeFinding(), makeFinding({ id: "F002" })], usage: usage(100, 10) }),
          makeRunResult({ caseId: "case-clean", configId: "A", findings: [makeFinding()], usage: usage(100, 10) }),
        ],
      },
    };
    const defectCase: EvaluationInput = {
      mrCase: caseWithTruth("case-defect"),
      runsByConfig: {
        A: repRuns("case-defect", "A", [usage(100, 10), usage(100, 10)]),
      },
    };
    const report = buildMetricsReport([cleanCase, defectCase]);
    const configA = report.perConfig.A;

    // clean MR 无真值：recall 未定义，不进入统计；precision 进统计（FP 对照）
    expect(configA?.hot?.values.lineRecall).toEqual({ count: 1, mean: 1, std: 0 });
    expect(configA?.hot?.values.linePrecision?.count).toBe(2);
    expect(configA?.hot?.values.linePrecision?.mean).toBe(0.5);
    expect(configA?.hot?.values.linePrecision?.std).toBeCloseTo(Math.SQRT1_2, 12);
    expect(configA?.hot?.values.lineFp?.count).toBe(2);
    expect(configA?.hot?.values.lineFp?.mean).toBe(0.5);
    expect(configA?.hot?.values.lineFp?.std).toBeCloseTo(Math.SQRT1_2, 12);
  });
});

describe("buildMetricsReport / evaluateCase — input validation", () => {
  it("rejects an empty evaluations array", () => {
    expect(() => buildMetricsReport([])).toThrow(/evaluations must be a non-empty array/);
  });

  it("rejects runsByConfig without any config", () => {
    const mrCase = caseWithTruth("case-001");
    expect(() => evaluateCase({ mrCase, runsByConfig: {} })).toThrow(
      /runsByConfig must list at least one config/,
    );
  });

  it("rejects an empty runs array for a config", () => {
    const mrCase = caseWithTruth("case-001");
    expect(() => evaluateCase({ mrCase, runsByConfig: { A: [] } })).toThrow(
      /runsByConfig\["A"\] must be a non-empty array/,
    );
  });

  it("rejects runs whose caseId does not match the MR case", () => {
    const mrCase = caseWithTruth("case-001");
    const runs = [makeRunResult({ caseId: "case-other", configId: "A" })];
    expect(() => evaluateCase({ mrCase, runsByConfig: { A: runs } })).toThrow(
      /does not match mrCase\.caseId/,
    );
  });

  it("rejects runs whose configId does not match the grouping key", () => {
    const mrCase = caseWithTruth("case-001");
    const runs = [makeRunResult({ caseId: "case-001", configId: "C" })];
    expect(() => evaluateCase({ mrCase, runsByConfig: { A: runs } })).toThrow(
      /configId "C" does not match its key "A"/,
    );
  });

  it("rejects unknown config keys", () => {
    const mrCase = caseWithTruth("case-001");
    const runs = [makeRunResult({ caseId: "case-001", configId: "C" })];
    expect(() =>
      evaluateCase({ mrCase, runsByConfig: { Z: runs } as unknown as EvaluationInput["runsByConfig"] }),
    ).toThrow(/unknown config key "Z"/);
  });
});

describe("meanFlatMetrics", () => {
  it("projects stats onto their means (null fields stay null)", () => {
    const mrCase = caseWithTruth("case-001");
    const report = evaluateCase({
      mrCase,
      runsByConfig: { A: repRuns("case-001", "A", [usage(10, 10), usage(20, 20), usage(30, 30)]) },
    });
    const hot = report.perConfig.A?.hot;
    expect(hot).not.toBeNull();
    const means = meanFlatMetrics(hot as NonNullable<typeof hot>);
    // 热 = rep2/rep3 的均值：totalTokens [(20+20), (30+30)] → 50
    expect(means.totalTokens).toBe(50);
    expect(means.lineRecall).toBe(1);
    expect(means.cacheHitRate).toBe(0);
  });
});
