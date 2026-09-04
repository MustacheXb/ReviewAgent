import { describe, expect, it } from "vitest";
import { buildMetricsReport } from "../../src/metrics/aggregate.js";
import type { MetricsOptions } from "../../src/metrics/types.js";
import { DEFAULT_METRICS_OPTIONS } from "../../src/metrics/types.js";
import { renderDashboardMarkdown } from "../../src/experiment/dashboard.js";
import type { ExperimentReport } from "../../src/experiment/report.js";
import type { ExperimentPlan } from "../../src/experiment/plan.js";
import type { MRCase } from "../../src/contracts/mr-case.js";
import type { EvaluationInput } from "../../src/metrics/types.js";
import { usage } from "../helpers/llm-script.js";
import { makeFinding, makeMrCase, makeRunResult, makeTruth, makeTruthLocation } from "../metrics/helpers.js";

/**
 * Dashboard 渲染（Ticket 12）：预热曲线段（spec US27）——
 * rep1..repN 逐 repIndex 的跨 case 均值表，rep 数不齐的格子以 "—" 占位。
 */

const TRUTH_FILE = "src/main/java/com/example/Math.java";

function caseWithTruth(caseId: string): MRCase {
  return makeMrCase({
    caseId,
    truth: makeTruth([makeTruthLocation({ file: TRUTH_FILE, lineStart: 10, lineEnd: 10 })]),
  });
}

function buildReport(options: MetricsOptions = DEFAULT_METRICS_OPTIONS): ExperimentReport {
  const case1: EvaluationInput = {
    mrCase: caseWithTruth("case-001"),
    runsByConfig: {
      A: [0, 1, 2].map((rep) =>
        makeRunResult({
          caseId: "case-001",
          configId: "A",
          findings: [makeFinding({ file: TRUTH_FILE, line: 10 })],
          usage: usage(1000, 100 + rep * 100, { cacheReadTokens: rep * 1000 }),
        }),
      ),
    },
  };
  const plan: ExperimentPlan = {
    experimentId: "warmup-dashboard-test",
    sources: ["defects4j"],
    configs: ["A"],
    reps: 3,
    verifier: "off",
    model: "deepseek-v4-flash",
    highRiskOnly: false,
    perSourceLimit: null,
    caseFilter: [],
    judge: false,
    humanReviewRate: 0.1,
    humanReviewSeed: "seed",
  };
  return {
    experimentId: plan.experimentId,
    plan,
    executed: 1,
    resumed: 0,
    failed: 0,
    failures: [],
    corruptRecordFiles: [],
    caseCount: 1,
    negativeControlCaseCount: 0,
    metrics: buildMetricsReport([case1], options),
    verdicts: null,
    negativeControl: null,
    verifierAblation: null,
    dedup: [],
    cacheBreaks: [],
    judge: null,
    humanReview: null,
  };
}

describe("renderDashboardMarkdown — warm-up curve（spec US27）", () => {
  it("渲染 rep1..repN 逐 repIndex 的跨 case 均值表", () => {
    const markdown = renderDashboardMarkdown(buildReport());
    expect(markdown).toContain("## Metrics — warm-up curve (per-rep cross-case mean)");
    // rep 行：rep1 / rep2 / rep3 各一行（case 数恒 1；均值 ± 标准差格式）
    expect(markdown).toContain("| rep1 | 1 | 0% ± 0% | 1100 ± 0 |");
    expect(markdown).toContain("| rep2 | 1 | 50% ± 0% | 2200 ± 0 |");
    expect(markdown).toContain("| rep3 | 1 | 66.7% ± 0% | 3300 ± 0 |");
    // 命中率随 rep 爬升（预热曲线的核心读数）
    const rep1Row = markdown.split("\n").find((line) => line.startsWith("| rep1 |"));
    const rep3Row = markdown.split("\n").find((line) => line.startsWith("| rep3 |"));
    expect(rep1Row).toBeDefined();
    expect(rep3Row).toBeDefined();
  });

  it("无指标（metrics = null）时省略预热曲线段", () => {
    const report = { ...buildReport(), metrics: null };
    const markdown = renderDashboardMarkdown(report);
    expect(markdown).not.toContain("warm-up curve");
  });
});
