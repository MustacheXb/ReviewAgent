import { describe, expect, it } from "vitest";
import { usage } from "../helpers/llm-script.js";
import { computeEfficiencyMetrics } from "../../src/metrics/efficiency.js";
import { computePRF } from "../../src/metrics/quality.js";
import { computeTokenMetrics, computeToolCostTokens } from "../../src/metrics/tokens.js";
import { evaluateRun } from "../../src/metrics/aggregate.js";
import { DEFAULT_METRICS_OPTIONS, DEFAULT_TOOL_COST_PRICING } from "../../src/metrics/types.js";
import type { TokenMetrics } from "../../src/metrics/types.js";
import { makeFinding, makeMrCase, makeRunResult, makeToolCall, makeTruth, makeTruthLocation } from "./helpers.js";

/** 指标计算口径：token 记账 / 工具成本 / PRF / RIE / CARC（issue #11 验收标准 2） */

describe("computeTokenMetrics", () => {
  it("accounts uncached input, cached input and output separately", () => {
    const metrics = computeTokenMetrics(usage(100, 50, { cacheReadTokens: 300 }));
    expect(metrics).toEqual({
      uncachedInputTokens: 100,
      cachedInputTokens: 300,
      cacheWriteTokens: 0,
      outputTokens: 50,
      totalInputTokens: 400,
      totalTokens: 450,
      cacheHitRate: 0.75,
    } satisfies TokenMetrics);
  });

  it("treats missing cache fields as zero (cache hit rate 0, not null)", () => {
    const metrics = computeTokenMetrics(usage(100, 50));
    expect(metrics.cachedInputTokens).toBe(0);
    expect(metrics.cacheWriteTokens).toBe(0);
    expect(metrics.totalInputTokens).toBe(100);
    expect(metrics.cacheHitRate).toBe(0);
  });

  it("includes cache-write tokens in total input and counts them as non-hit input", () => {
    const metrics = computeTokenMetrics(usage(100, 0, { cacheReadTokens: 100, cacheWriteTokens: 50 }));
    expect(metrics.totalInputTokens).toBe(250);
    expect(metrics.cacheHitRate).toBeCloseTo(0.4, 12);
  });

  it("returns a null cache hit rate when there are no input tokens at all", () => {
    const metrics = computeTokenMetrics(usage(0, 0));
    expect(metrics.totalInputTokens).toBe(0);
    expect(metrics.cacheHitRate).toBeNull();
  });

  it("rejects negative or non-integer usage", () => {
    expect(() => computeTokenMetrics(usage(-1, 10))).toThrow(/usage\.inputTokens must be a non-negative integer/);
    expect(() => computeTokenMetrics({ ...usage(10, 10), cacheReadTokens: -5 })).toThrow(
      /usage\.cacheReadTokens must be a non-negative integer/,
    );
  });
});

describe("computeToolCostTokens", () => {
  it("defaults to zero cost when no pricing is configured", () => {
    const run = makeRunResult({ toolCallLog: [makeToolCall("x".repeat(100))] });
    expect(computeToolCostTokens(run)).toBe(0);
    expect(computeToolCostTokens(run, DEFAULT_TOOL_COST_PRICING)).toBe(0);
  });

  it("prices tool cost by call count and result length (configurable)", () => {
    const run = makeRunResult({
      toolCallLog: [makeToolCall("x".repeat(100)), makeToolCall("y".repeat(50))],
    });
    const cost = computeToolCostTokens(run, { fixedCostPerCall: 10, costPerResultChar: 0.01 });
    expect(cost).toBe(10 * 2 + 0.01 * 150);
  });

  it("rejects negative pricing", () => {
    const run = makeRunResult({});
    expect(() => computeToolCostTokens(run, { fixedCostPerCall: -1, costPerResultChar: 0 })).toThrow(
      /pricing\.fixedCostPerCall must be a non-negative/,
    );
  });
});

describe("computePRF", () => {
  it("computes recall, precision and F1", () => {
    expect(computePRF({ tp: 2, fp: 1, fn: 1 })).toEqual({
      recall: 2 / 3,
      precision: 2 / 3,
      f1: 2 / 3,
    });
  });

  it("returns null recall when there is no truth (clean MR) and null precision with zero findings", () => {
    expect(computePRF({ tp: 0, fp: 3, fn: 0 })).toEqual({ recall: null, precision: 0, f1: null });
    expect(computePRF({ tp: 0, fp: 0, fn: 2 })).toEqual({ recall: 0, precision: null, f1: null });
    expect(computePRF({ tp: 0, fp: 0, fn: 0 })).toEqual({ recall: null, precision: null, f1: null });
  });

  it("defines F1 as 0 when both recall and precision are 0", () => {
    expect(computePRF({ tp: 0, fp: 2, fn: 3 }).f1).toBe(0);
  });
});

describe("computeEfficiencyMetrics — RIE and CARC", () => {
  it("computes RIE = Recall × Precision / (Total Tokens / 1K) on the line-level reading", () => {
    const metrics = computeEfficiencyMetrics({
      lineLevel: { recall: 0.8, precision: 0.5, f1: null },
      tokens: computeTokenMetrics(usage(800, 200)),
      toolCostTokens: 0,
    });
    expect(metrics.rie).toBeCloseTo((0.8 * 0.5) / 1, 12);
    expect(metrics.carc).toBe(1000);
  });

  it("returns a null RIE on division by zero or missing quality components", () => {
    const zeroTokens = computeEfficiencyMetrics({
      lineLevel: { recall: 1, precision: 1, f1: 1 },
      tokens: computeTokenMetrics(usage(0, 0)),
      toolCostTokens: 0,
    });
    expect(zeroTokens.rie).toBeNull();
    const noRecall = computeEfficiencyMetrics({
      lineLevel: { recall: null, precision: 1, f1: null },
      tokens: computeTokenMetrics(usage(100, 0)),
      toolCostTokens: 0,
    });
    expect(noRecall.rie).toBeNull();
  });

  it("computes CARC = uncached input + cache write + output + tool cost (cache hits excluded)", () => {
    const metrics = computeEfficiencyMetrics({
      lineLevel: { recall: 1, precision: 1, f1: 1 },
      tokens: computeTokenMetrics(usage(100, 200, { cacheReadTokens: 5000, cacheWriteTokens: 50 })),
      toolCostTokens: 30,
    });
    expect(metrics.carc).toBe(100 + 50 + 200 + 30);
  });
});

describe("evaluateRun", () => {
  const mrCase = makeMrCase({
    truth: makeTruth([makeTruthLocation({ lineStart: 10, lineEnd: 10 })]),
  });

  it("produces the full per-run metric record from a RunResult", () => {
    const run = makeRunResult({
      findings: [makeFinding({ line: 10 }), makeFinding({ id: "F2", line: 90 })],
      usage: usage(750, 210, { cacheReadTokens: 350, cacheWriteTokens: 40 }),
      toolCallLog: [makeToolCall("result")],
      toolCalls: 1,
      rounds: 3,
    });
    const metrics = evaluateRun(run, mrCase, {
      ...DEFAULT_METRICS_OPTIONS,
      toolCost: { fixedCostPerCall: 5, costPerResultChar: 0 },
    });
    expect(metrics.lineCounts).toEqual({ tp: 1, fp: 1, fn: 0 });
    expect(metrics.fileCounts).toEqual({ tp: 1, fp: 1, fn: 0 });
    expect(metrics.lineLevel).toEqual({ recall: 1, precision: 0.5, f1: 2 / 3 });
    expect(metrics.tokens.totalTokens).toBe(1350);
    expect(metrics.tokens.cacheHitRate).toBeCloseTo(350 / 1140, 12);
    expect(metrics.toolCostTokens).toBe(5);
    expect(metrics.efficiency.carc).toBe(750 + 40 + 210 + 5);
    expect(metrics.efficiency.rie).toBeCloseTo((1 * 0.5) / 1.35, 12);
    expect(metrics.toolCalls).toBe(1);
    expect(metrics.rounds).toBe(3);
    expect(metrics.screening.verdicts).toHaveLength(2);
  });

  it("exposes the coarse-screening detail for the judge stage", () => {
    const run = makeRunResult({ findings: [makeFinding({ line: 42 })] });
    const metrics = evaluateRun(run, mrCase);
    expect(metrics.screening.cleanMr).toBe(false);
    expect(metrics.screening.verdicts[0]).toMatchObject({ outcome: "FP", fpReason: "NO_LINE_MATCH" });
    expect(metrics.screening.misses[0]).toMatchObject({ truthIndex: 0 });
  });

  it("rejects a run whose caseId does not match the MR case", () => {
    expect(() => evaluateRun(makeRunResult({ caseId: "other" }), mrCase)).toThrow(/does not match/);
  });

  it("rejects malformed run results", () => {
    expect(() => evaluateRun({ ...makeRunResult(), rounds: -1 }, mrCase)).toThrow(
      /run\.rounds must be a non-negative integer/,
    );
  });
});
