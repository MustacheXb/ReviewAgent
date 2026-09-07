import { describe, expect, it } from "vitest";
import { buildMetricsReport } from "../../src/metrics/aggregate.js";
import {
  judgeAllVerdicts,
  judgeVerdict,
  verdictMetricsFrom,
  VERDICT_EPSILON,
} from "../../src/metrics/verdict.js";
import {
  DEFAULT_VERDICT_THRESHOLDS,
  type MetricsReport,
  type VerdictMetrics,
  type VerdictThresholds,
} from "../../src/metrics/types.js";
import { usage } from "../helpers/llm-script.js";
import { makeFinding, makeMrCase, makeRunResult, makeTruth, makeTruthLocation } from "./helpers.js";

/**
 * S/A/B 自动判定（issue #11 验收标准 3；spec #1 user story 29，主锚 = 配置 C）：
 * S：Recall ≥ C×90% ∧ Token ≤ C×30% ∧ Cache Hit ≥ 85%
 * A：Recall ≥ C×80% ∧ Token ≤ C×30% ∧ Cache Hit ≥ 80%
 * B：Recall ≥ C×70% ∧ Token ≤ C×50%（无缓存判据）
 */

const TRUTH_FILE = "src/main/java/com/example/Math.java";

const ANCHOR: VerdictMetrics = { recall: 0.9, totalTokens: 20000, cacheHitRate: 0.6 };

describe("judgeVerdict — grade boundaries (anchor = config C)", () => {
  it("awards S exactly at the S boundaries (equality passes via epsilon)", () => {
    const target: VerdictMetrics = { recall: 0.81, totalTokens: 6000, cacheHitRate: 0.85 };
    const report = judgeVerdict("E", target, ANCHOR);
    expect(report.outcome).toBe("S");
    expect(report.grade).toBe("S");
    expect(report.basis).toContain("Grade S achieved");
  });

  it("awards A when recall misses the S ratio but hits the A ratio", () => {
    const target: VerdictMetrics = { recall: 0.72, totalTokens: 6000, cacheHitRate: 0.8 };
    const report = judgeVerdict("E", target, ANCHOR);
    expect(report.outcome).toBe("A");
    const sRecall = report.criteria.find((c) => c.grade === "S" && c.metric === "RECALL");
    expect(sRecall?.pass).toBe(false);
    expect(sRecall?.threshold).toBeCloseTo(0.81, 12);
  });

  it("awards B when only the B ratios hold (no cache criterion at B)", () => {
    const target: VerdictMetrics = { recall: 0.63, totalTokens: 9500, cacheHitRate: 0.5 };
    const report = judgeVerdict("D", target, ANCHOR);
    expect(report.outcome).toBe("B");
    const bCache = report.criteria.find((c) => c.grade === "B" && c.metric === "CACHE_HIT_RATE");
    expect(bCache?.pass).toBe(true);
    expect(bCache?.threshold).toBeNull();
    expect(bCache?.note).toContain("no cache-hit criterion for this grade");
  });

  it("caps a low cache hit rate at B even with S-level recall and tokens", () => {
    const target: VerdictMetrics = { recall: 0.9, totalTokens: 5000, cacheHitRate: 0.7 };
    const report = judgeVerdict("E", target, ANCHOR);
    expect(report.outcome).toBe("B");
  });

  it("caps an oversized token budget at B even with S-level recall and cache", () => {
    const target: VerdictMetrics = { recall: 0.9, totalTokens: 7000, cacheHitRate: 0.9 };
    const report = judgeVerdict("E", target, ANCHOR);
    expect(report.outcome).toBe("B");
  });

  it("reports BELOW_B when even the B ratios fail", () => {
    const target: VerdictMetrics = { recall: 0.5, totalTokens: 11000, cacheHitRate: 0.9 };
    const report = judgeVerdict("E", target, ANCHOR);
    expect(report.outcome).toBe("BELOW_B");
    expect(report.grade).toBeNull();
    expect(report.basis).toContain("Below B");
  });

  it("documents every criterion with value, threshold and comparison", () => {
    const report = judgeVerdict("E", { recall: 0.75, totalTokens: 5500, cacheHitRate: 0.82 }, ANCHOR);
    expect(report.criteria).toHaveLength(9);
    const aRecall = report.criteria.find((c) => c.grade === "A" && c.metric === "RECALL");
    expect(aRecall).toMatchObject({
      comparison: "AT_LEAST",
      value: 0.75,
      pass: true,
    });
    expect(aRecall?.threshold).toBeCloseTo(0.72, 12);
    const aTokens = report.criteria.find((c) => c.grade === "A" && c.metric === "TOTAL_TOKENS");
    expect(aTokens).toMatchObject({ comparison: "AT_MOST", value: 5500, pass: true });
    expect(aTokens?.threshold).toBeCloseTo(6000, 9);
    const aCache = report.criteria.find((c) => c.grade === "A" && c.metric === "CACHE_HIT_RATE");
    expect(aCache).toMatchObject({ comparison: "AT_LEAST_ABSOLUTE", threshold: 0.8, pass: true });
    expect(report.anchor).toEqual({ configId: "C", ...ANCHOR });
  });
});

describe("judgeVerdict — edge cases", () => {
  it("treats floating-point noise at the boundary as a pass (0.8 × 0.9 case)", () => {
    // 0.9 × 0.8 = 0.7200000000000001 in IEEE754；ε 容差保证 0.72 恰好达标
    expect(0.9 * 0.8).not.toBe(0.72);
    const report = judgeVerdict("E", { recall: 0.72, totalTokens: 6000, cacheHitRate: 0.8 }, ANCHOR);
    const aRecall = report.criteria.find((c) => c.grade === "A" && c.metric === "RECALL");
    expect(aRecall?.pass).toBe(true);
  });

  it("is NOT_EVALUABLE when the anchor has no recall or token metrics", () => {
    const report = judgeVerdict(
      "E",
      { recall: 0.9, totalTokens: 5000, cacheHitRate: 0.9 },
      { recall: null, totalTokens: null, cacheHitRate: null },
    );
    expect(report.outcome).toBe("NOT_EVALUABLE");
    expect(report.criteria).toEqual([]);
    expect(report.basis).toContain("Not evaluable");
  });

  it("counts null target metrics as failed criteria (BELOW_B), never as a pass", () => {
    const report = judgeVerdict(
      "E",
      { recall: null, totalTokens: 5000, cacheHitRate: null },
      ANCHOR,
    );
    expect(report.outcome).toBe("BELOW_B");
    const bRecall = report.criteria.find((c) => c.grade === "B" && c.metric === "RECALL");
    expect(bRecall?.pass).toBe(false);
    expect(bRecall?.note).toContain("metric unavailable");
  });

  it("handles a degenerate anchor with zero recall (threshold 0 trivially passes)", () => {
    const zeroAnchor: VerdictMetrics = { recall: 0, totalTokens: 10000, cacheHitRate: 1 };
    const report = judgeVerdict("E", { recall: 0, totalTokens: 3000, cacheHitRate: 0.9 }, zeroAnchor);
    expect(report.outcome).toBe("S");
    expect(report.basis).toContain("Grade S achieved");
  });

  it("requires exactly zero tokens when the anchor spent zero tokens", () => {
    const zeroTokenAnchor: VerdictMetrics = { recall: 0.9, totalTokens: 0, cacheHitRate: 1 };
    const passing = judgeVerdict("E", { recall: 0.9, totalTokens: 0, cacheHitRate: 0.9 }, zeroTokenAnchor);
    expect(passing.outcome).toBe("S");
    const failing = judgeVerdict("E", { recall: 0.9, totalTokens: 1, cacheHitRate: 0.9 }, zeroTokenAnchor);
    expect(failing.outcome).toBe("BELOW_B");
  });

  it("supports custom thresholds (e.g. strictened S recall ratio)", () => {
    const thresholds: Readonly<Record<"S" | "A" | "B", VerdictThresholds>> = {
      ...DEFAULT_VERDICT_THRESHOLDS,
      S: { recallRatio: 1, tokenRatio: 0.3, cacheHitRate: 0.85 },
    };
    const report = judgeVerdict("E", { recall: 0.85, totalTokens: 5000, cacheHitRate: 0.9 }, ANCHOR, {
      thresholds,
    });
    expect(report.outcome).toBe("A");
  });

  it("rejects invalid metric ranges and thresholds", () => {
    expect(() =>
      judgeVerdict("E", { recall: 1.5, totalTokens: 100, cacheHitRate: 0.5 }, ANCHOR),
    ).toThrow(/target\.recall must be null or a number in \[0, 1\]/);
    expect(() =>
      judgeVerdict("E", { recall: 1, totalTokens: 100, cacheHitRate: 0.5 }, ANCHOR, {
        thresholds: { ...DEFAULT_VERDICT_THRESHOLDS, S: { recallRatio: -1, tokenRatio: 0.3, cacheHitRate: 0.85 } },
      }),
    ).toThrow(/thresholds\.S\.recallRatio must be null or a non-negative/);
  });

  it("exposes the epsilon used for boundary comparisons", () => {
    expect(VERDICT_EPSILON).toBe(1e-9);
  });
});

describe("judgeAllVerdicts — report-level judgment", () => {
  function metricsReport(withAnchorC: boolean): MetricsReport {
    const mrCase = makeMrCase({
      caseId: "case-001",
      truth: makeTruth([makeTruthLocation({ file: TRUTH_FILE, lineStart: 10, lineEnd: 10 })]),
    });
    const tp = () => makeFinding({ file: TRUTH_FILE, line: 10 });
    const runsFor = (configId: "C" | "E") => [
      makeRunResult({ caseId: "case-001", configId, findings: [tp()], usage: usage(1000, 100) }),
      makeRunResult({ caseId: "case-001", configId, findings: [tp()], usage: usage(1000, 100) }),
      makeRunResult({ caseId: "case-001", configId, findings: [tp()], usage: usage(1000, 100) }),
    ];
    const runsByConfig = withAnchorC
      ? { C: runsFor("C"), E: runsFor("E") }
      : { E: runsFor("E") };
    return buildMetricsReport([{ mrCase, runsByConfig }]);
  }

  it("judges every config against the config C anchor from the hot measure", () => {
    const report = judgeAllVerdicts(metricsReport(true));
    expect(report.anchorConfigId).toBe("C");
    expect(report.anchorAvailable).toBe(true);
    expect(report.verdicts.map((v) => v.configId)).toEqual(["C", "E"]);
    // 配置 C 自身按公式机械判定：Token 比率 1.0 > 0.3 → BELOW_B（锚不豁免）
    const anchorVerdict = report.verdicts[0];
    expect(anchorVerdict?.outcome).toBe("BELOW_B");
    // 配置 E 与 C 完全同值：Recall 比率 1.0 达标，Token 比率 1.0 不达标 → BELOW_B
    expect(report.verdicts[1]?.outcome).toBe("BELOW_B");
  });

  it("is NOT_EVALUABLE for all configs when the anchor config C is absent", () => {
    const report = judgeAllVerdicts(metricsReport(false));
    expect(report.anchorAvailable).toBe(false);
    expect(report.verdicts).toHaveLength(1);
    expect(report.verdicts[0]?.outcome).toBe("NOT_EVALUABLE");
    expect(report.verdicts[0]?.basis).toContain("anchor config C");
  });

  it("rejects a malformed report", () => {
    expect(() => judgeAllVerdicts({} as MetricsReport)).toThrow(
      /report must be a MetricsReport object/,
    );
  });

  it("is NOT_EVALUABLE for configs without rep2+ hot metrics (single rep)", () => {
    const mrCase = makeMrCase({
      caseId: "case-001",
      truth: makeTruth([makeTruthLocation({ file: TRUTH_FILE, lineStart: 10, lineEnd: 10 })]),
    });
    const singleRepReport = buildMetricsReport([
      {
        mrCase,
        runsByConfig: {
          C: [makeRunResult({ caseId: "case-001", configId: "C", findings: [makeFinding({ file: TRUTH_FILE, line: 10 })], usage: usage(1000, 100) })],
        },
      },
    ]);
    const report = judgeAllVerdicts(singleRepReport);
    expect(report.anchorAvailable).toBe(false);
    expect(report.verdicts[0]?.outcome).toBe("NOT_EVALUABLE");
    expect(report.verdicts[0]?.basis).toContain("no rep2+ hot metrics");
  });
});

describe("verdictMetricsFrom", () => {
  it("extracts the three verdict inputs from a hot summary (nulls preserved)", () => {
    const mrCase = makeMrCase({ caseId: "case-001", truth: null });
    const report = buildMetricsReport([
      {
        mrCase,
        runsByConfig: {
          A: [
            makeRunResult({ caseId: "case-001", configId: "A", findings: [makeFinding()], usage: usage(100, 10) }),
            makeRunResult({ caseId: "case-001", configId: "A", findings: [makeFinding()], usage: usage(300, 10, { cacheReadTokens: 100 }) }),
          ],
        },
      },
    ]);
    const hot = report.perConfig.A?.hot;
    expect(hot).not.toBeNull();
    const metrics = verdictMetricsFrom(hot as NonNullable<typeof hot>);
    // clean MR：recall 未定义 → null；热口径仅 rep2：token / 命中率取该 rep 值
    expect(metrics.recall).toBeNull();
    expect(metrics.totalTokens).toBe(300 + 100 + 10);
    expect(metrics.cacheHitRate).toBe(0.25);
  });
});
