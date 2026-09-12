import { describe, expect, it } from "vitest";
import {
  DEFAULT_ALIGNMENT_GATE_OPTIONS,
  DEFAULT_GATE_METRICS,
  runAlignmentGate,
} from "../../src/metrics/alignment-gate.js";
import type {
  AlignmentGateOptions,
  GateSideInput,
  GateUnitSample,
} from "../../src/metrics/alignment-gate.js";
import type { MetricsConfigId } from "../../src/contracts/config.js";
import { summarizeDefined } from "../../src/metrics/stats.js";
import { METRICS_FIELDS } from "../../src/metrics/types.js";
import type { FlatMetrics, MetricsField } from "../../src/metrics/types.js";

/**
 * 指标对齐门协议 v2（#31）：对称 max σ 带 + 最小样本护栏 + 单元配对符号检验。
 * 夹具锚定：C/cacheHitRate 与 C/linePrecision 采用 #29 已发布数字
 * （0.9312±0.0142 vs 0.8766±0.0803 → 遗留 OUT / 对称 IN；
 *   基线 n=2 → 遗留 OUT / 修订 INSUFFICIENT）。
 */

function flatOf(values: Partial<Record<MetricsField, number | null>>): FlatMetrics {
  const flat = {} as Record<MetricsField, number | null>;
  for (const field of METRICS_FIELDS) {
    const value = values[field];
    flat[field] = value === undefined ? 0 : value;
  }
  return flat;
}

/** 同 config 的单元组：unitKey 形如 `${configId}:${prefix}${i}`（三侧共用即配对键） */
function unitsOf(
  configId: MetricsConfigId,
  metric: MetricsField,
  values: readonly (number | null)[],
  prefix = "u",
): GateUnitSample[] {
  return values.map((value, index) => ({
    unitKey: `${configId}:${prefix}${index + 1}`,
    configId,
    flat: flatOf({ [metric]: value } as Partial<Record<MetricsField, number | null>>),
  }));
}

/** n=9、均值与样本 σ 精确落在目标的取值组（对称偏差 × 定标） */
function spreadNine(mean: number, sigma: number): number[] {
  const deviations = [-1.5, -1, -0.5, -0.5, 0, 0.5, 0.5, 1, 1.5];
  const scale = sigma / Math.sqrt(deviations.reduce((acc, d) => acc + d * d, 0) / (deviations.length - 1));
  return deviations.map((d) => mean + d * scale);
}

/** #29 C/cacheHitRate 已发布数字的两侧夹具（n=9 各侧） */
function cacheHitRateSides(): { baseline: GateSideInput; candidate: GateSideInput } {
  return {
    baseline: {
      name: "poc1-r1",
      units: unitsOf("C", "cacheHitRate", spreadNine(0.9312, 0.0142)),
    },
    candidate: {
      name: "dsh",
      units: unitsOf("C", "cacheHitRate", spreadNine(0.8766, 0.0803)),
    },
  };
}

const ONLY_CACHE_HIT: AlignmentGateOptions = { ...DEFAULT_ALIGNMENT_GATE_OPTIONS, metrics: ["cacheHitRate"] };

describe("runAlignmentGate：对称 max σ 带（修订口径）", () => {
  it("带宽 = 两侧 σ 较大者、中心 = 基线均值——以 #29 C/cacheHitRate 已发布数字夹具复刻门 D", () => {
    const { baseline, candidate } = cacheHitRateSides();
    const report = runAlignmentGate(baseline, candidate, null, ONLY_CACHE_HIT);
    const cell = report.cells.find((c) => c.configId === "C" && c.metric === "cacheHitRate");
    expect(cell).toBeDefined();
    if (cell === undefined) return;

    // 构造断言：band = baseline.mean ± max(σ_base, σ_cand)
    const baseSigma = summarizeDefined(spreadNine(0.9312, 0.0142))?.std ?? Number.NaN;
    const candSigma = summarizeDefined(spreadNine(0.8766, 0.0803))?.std ?? Number.NaN;
    expect(baseSigma).toBeCloseTo(0.0142, 6);
    expect(candSigma).toBeCloseTo(0.0803, 6);
    expect(cell.symmetricBand?.lo).toBeCloseTo(0.9312 - Math.max(baseSigma, candSigma), 9);
    expect(cell.symmetricBand?.hi).toBeCloseTo(0.9312 + Math.max(baseSigma, candSigma), 9);
    // 发布锚定：对称带 ≈ [0.8509, 1.0115]
    expect(cell.symmetricBand?.lo).toBeCloseTo(0.8509, 3);
    expect(cell.symmetricBand?.hi).toBeCloseTo(1.0115, 3);

    expect(cell.status).toBe("IN");
    expect(cell.legacyStatus).toBe("OUT"); // #29 实判：单侧带 [0.9170, 0.9454] 判 OUT
    expect(cell.legacyBand?.lo).toBeCloseTo(0.9312 - 0.0142, 3);
    expect(cell.legacyBand?.hi).toBeCloseTo(0.9312 + 0.0142, 3);
    expect(cell.delta).toBeCloseTo(0.8766 - 0.9312, 6);
    expect(report.verdict).toBe("PASS");
  });

  it("判定方向无关：交换 baseline/candidate，对称判定与总判定不变", () => {
    const { baseline, candidate } = cacheHitRateSides();
    const forward = runAlignmentGate(baseline, candidate, null, ONLY_CACHE_HIT);
    const reverse = runAlignmentGate(candidate, baseline, null, ONLY_CACHE_HIT);
    expect(forward.cells.map((c) => c.status)).toEqual(reverse.cells.map((c) => c.status));
    expect(forward.verdict).toBe(reverse.verdict);
    // 带宽一致（中心随基线侧平移，宽度 = max σ 不变）
    const fw = forward.cells[0]?.symmetricBand;
    const rv = reverse.cells[0]?.symmetricBand;
    if (fw == null || rv == null) {
      throw new Error("symmetric band missing");
    }
    expect(fw.hi - fw.lo).toBeCloseTo(rv.hi - rv.lo, 9);
  });

  it("候选均值超出对称带 → OUT → 总判定 FAIL", () => {
    const report = runAlignmentGate(
      { name: "b", units: unitsOf("A", "cacheHitRate", spreadNine(0.9, 0.01)) },
      { name: "c", units: unitsOf("A", "cacheHitRate", spreadNine(0.5, 0.01)) },
      null,
      ONLY_CACHE_HIT,
    );
    expect(report.cells[0]?.status).toBe("OUT");
    expect(report.verdict).toBe("FAIL");
  });
});

describe("runAlignmentGate：最小样本护栏", () => {
  it("基线 n=2 → INSUFFICIENT_SAMPLE 不判定、不触发 FAIL（#29 C/linePrecision 形态）", () => {
    const report = runAlignmentGate(
      { name: "b", units: unitsOf("C", "linePrecision", [0.5, 0.25]) }, // mean 0.375, σ 0.1768（n−1 口径，#29 发布值）
      {
        name: "c",
        units: unitsOf("C", "linePrecision", [0.0, 0.1, 0.15, 0.175, 0.175, 0.2, 0.25, 0.35]), // mean 0.175
      },
      null,
      { ...DEFAULT_ALIGNMENT_GATE_OPTIONS, metrics: ["linePrecision"] },
    );
    const cell = report.cells[0];
    expect(cell?.status).toBe("INSUFFICIENT_SAMPLE");
    expect(cell?.insufficientSide).toBe("baseline");
    expect(cell?.legacyStatus).toBe("OUT"); // 遗留口径无护栏：0.175 < 0.1982 → OUT（#29 实判）
    // 唯一格样本不足 → 无可判定格 → INCONCLUSIVE（样本不足既非 FAIL 也非 PASS）
    expect(report.verdict).toBe("INCONCLUSIVE");
  });

  it("候选 n=2 同样触发护栏（insufficientSide = candidate）", () => {
    const report = runAlignmentGate(
      { name: "b", units: unitsOf("A", "cacheHitRate", spreadNine(0.9, 0.05)) },
      { name: "c", units: unitsOf("A", "cacheHitRate", [0.88, 0.92]) },
      null,
      ONLY_CACHE_HIT,
    );
    expect(report.cells[0]?.status).toBe("INSUFFICIENT_SAMPLE");
    expect(report.cells[0]?.insufficientSide).toBe("candidate");
  });

  it("护栏阈值可配（minSampleCount 提到 5 → n=4 的格转为不判定）", () => {
    const units = unitsOf("A", "cacheHitRate", [0.88, 0.9, 0.92, 0.94]);
    const strict = runAlignmentGate(
      { name: "b", units },
      { name: "c", units: unitsOf("A", "cacheHitRate", [0.86, 0.88, 0.9, 0.92]) },
      null,
      { ...ONLY_CACHE_HIT, minSampleCount: 5 },
    );
    expect(strict.cells[0]?.status).toBe("INSUFFICIENT_SAMPLE");
  });
});

describe("runAlignmentGate：样本缺失面", () => {
  it("基线全 null（指标无定义）→ NO_BASELINE_SAMPLES；候选全 null → NO_CANDIDATE_SAMPLES；均不 FAIL", () => {
    const report = runAlignmentGate(
      {
        name: "b",
        units: [
          ...unitsOf("A", "linePrecision", [null, null, null]),
          ...unitsOf("B", "linePrecision", [0.3, 0.5, 0.7]),
        ],
      },
      {
        name: "c",
        units: [
          ...unitsOf("A", "linePrecision", [0.2, 0.4, 0.6]),
          ...unitsOf("B", "linePrecision", [null, null, null]),
        ],
      },
      null,
      { ...DEFAULT_ALIGNMENT_GATE_OPTIONS, metrics: ["linePrecision"] },
    );
    const cellA = report.cells.find((c) => c.configId === "A");
    const cellB = report.cells.find((c) => c.configId === "B");
    expect(cellA?.status).toBe("NO_BASELINE_SAMPLES");
    expect(cellB?.status).toBe("NO_CANDIDATE_SAMPLES");
    expect(report.verdict).toBe("INCONCLUSIVE"); // 不 FAIL；且无任何可判定格
    expect(report.advisories.some((a) => a.includes("A/linePrecision"))).toBe(true);
  });

  it("双侧 config 完全不交 → 无可判定格 → INCONCLUSIVE", () => {
    const report = runAlignmentGate(
      { name: "b", units: unitsOf("A", "cacheHitRate", [0.9, 0.91, 0.92]) },
      { name: "c", units: unitsOf("B", "cacheHitRate", [0.9, 0.91, 0.92]) },
      null,
      ONLY_CACHE_HIT,
    );
    expect(report.verdict).toBe("INCONCLUSIVE");
  });
});

describe("runAlignmentGate：单元配对符号检验（噪声对照在场时的主判据）", () => {
  // 基线侧恒 100000（σ=0，带判定面退化为纯配对轴考察）
  const baselineTokens = [100000, 100000, 100000, 100000, 100000, 100000, 100000, 100000];
  const noiseTokens = [105000, 110000, 115000, 120000, 125000, 130000, 135000, 140000]; // |Δ| = 5k..40k
  const candidateWorseTokens = [145000, 144500, 144000, 143500, 143000, 142500, 142000, 141500]; // |Δ| = 41.5k..45k（全部 > 噪声）
  const candidateBetterTokens = [101000, 102000, 103000, 104000, 105000, 106000, 107000, 108000]; // |Δ| = 1k..8k（全部 < 噪声）

  const tokenSides = (
    candidateValues: readonly number[],
  ): { baseline: GateSideInput; candidate: GateSideInput; noise: GateSideInput } => ({
    baseline: { name: "r1", units: unitsOf("A", "totalTokens", baselineTokens, "r") },
    candidate: { name: "cand", units: unitsOf("A", "totalTokens", candidateValues, "r") },
    noise: { name: "r2", units: unitsOf("A", "totalTokens", noiseTokens, "r") },
  });
  const tokenOptions = { ...DEFAULT_ALIGNMENT_GATE_OPTIONS, metrics: ["totalTokens"] as const };

  it("候选 8/8 单元偏差更大 → 精确二项 p = 1/256 → FAIL", () => {
    const { baseline, candidate, noise } = tokenSides(candidateWorseTokens);
    const report = runAlignmentGate(baseline, candidate, noise, tokenOptions);
    const paired = report.paired[0];
    expect(paired?.metric).toBe("totalTokens");
    expect(paired?.pairCount).toBe(8);
    expect(paired?.candidateWorse).toBe(8);
    expect(paired?.candidateBetter).toBe(0);
    expect(paired?.worseDirectionP).toBeCloseTo(1 / 256, 12);
    expect(paired?.verdict).toBe("FAIL");
    expect(report.verdict).toBe("FAIL");
  });

  it("候选 8/8 单元偏差更小 → p = 1 → 配对 PASS", () => {
    const { baseline, candidate, noise } = tokenSides(candidateBetterTokens);
    const report = runAlignmentGate(baseline, candidate, noise, tokenOptions);
    const paired = report.paired[0];
    expect(paired?.pairCount).toBe(8);
    expect(paired?.candidateBetter).toBe(8);
    expect(paired?.worseDirectionP).toBeCloseTo(1, 12);
    expect(paired?.verdict).toBe("PASS");
  });

  it("5 败 3 胜 → p = 93/256 ≈ 0.363 → 不显著 → PASS", () => {
    const mixed = [145000, 144000, 143000, 142000, 141000, 104000, 103000, 102000]; // 5 败 3 胜
    const { baseline, candidate, noise } = tokenSides(mixed);
    const report = runAlignmentGate(baseline, candidate, noise, tokenOptions);
    const paired = report.paired[0];
    expect(paired?.candidateWorse).toBe(5);
    expect(paired?.candidateBetter).toBe(3);
    expect(paired?.worseDirectionP).toBeCloseTo(93 / 256, 12);
    expect(paired?.verdict).toBe("PASS");
  });

  it("α 收紧到 0.01 → n=6 全败（p=1/64≈0.0156）不再拒绝", () => {
    const base = [100000, 100000, 100000, 100000, 100000, 100000];
    const sides = {
      baseline: { name: "r1", units: unitsOf("A", "totalTokens", base, "r") },
      candidate: {
        name: "cand",
        units: unitsOf("A", "totalTokens", [150000, 149000, 148000, 147000, 146000, 145000], "r"),
      },
      noise: { name: "r2", units: unitsOf("A", "totalTokens", [105000, 106000, 107000, 108000, 109000, 110000], "r") },
    };
    const atDefault = runAlignmentGate(sides.baseline, sides.candidate, sides.noise, {
      ...DEFAULT_ALIGNMENT_GATE_OPTIONS,
      metrics: ["totalTokens"],
    });
    const atStrict = runAlignmentGate(sides.baseline, sides.candidate, sides.noise, {
      ...DEFAULT_ALIGNMENT_GATE_OPTIONS,
      metrics: ["totalTokens"],
      significanceLevel: 0.01,
    });
    expect(atDefault.paired[0]?.verdict).toBe("FAIL");
    expect(atStrict.paired[0]?.verdict).toBe("PASS");
  });

  it("|Δ| 完全相等的并列单元剔除检验（pairCount 不含、ties 计数）", () => {
    // 首单元 |Δ| = 5000 与噪声并列；其余 7 单元 |Δ| = 42k..45k 全部大于噪声
    const candidate = [105000, 145000, 144500, 144000, 143500, 143000, 142500, 142000];
    const { baseline, candidate: cand, noise } = tokenSides(candidate);
    const report = runAlignmentGate(baseline, cand, noise, tokenOptions);
    const paired = report.paired[0];
    expect(paired?.pairCount).toBe(7);
    expect(paired?.ties).toBe(1);
    expect(paired?.worseDirectionP).toBeCloseTo(1 / 128, 12);
  });

  it("噪声侧缺席 → 配对轴为空、不影响总判定", () => {
    const { baseline, candidate } = cacheHitRateSides();
    const report = runAlignmentGate(baseline, candidate, null, ONLY_CACHE_HIT);
    expect(report.paired).toEqual([]);
    expect(report.noiseSide).toBeNull();
    expect(report.verdict).toBe("PASS");
  });

  it("指标在任一侧为 null 的单元不参与配对；噪声侧缺单元的单元不参与", () => {
    const baseline = {
      name: "r1",
      units: unitsOf("A", "linePrecision", [0.5, 0.5, 0.5, 0.5]),
    };
    const candidate = {
      name: "cand",
      units: unitsOf("A", "linePrecision", [0.1, 0.2, 0.3, 0.4]),
    };
    const noise = {
      name: "r2",
      units: [
        ...unitsOf("A", "linePrecision", [null, 0.45, 0.05, 0.5]).slice(0, 3), // 单元 4 缺席 + 单元 1 null
      ],
    };
    const report = runAlignmentGate(baseline, candidate, noise, {
      ...DEFAULT_ALIGNMENT_GATE_OPTIONS,
      metrics: ["linePrecision"],
    });
    const paired = report.paired[0];
    // 单元 1（噪声 null）与单元 4（噪声缺席）剔除 → 配对 = 单元 2、3
    expect(paired?.pairCount).toBe(2);
  });
});

describe("runAlignmentGate：配对主判据前置规则（#31 What-to-build 3）", () => {
  // 基线 9 单元恒 100000（σ=0）；候选均值带外（OUT）；噪声 |Δ| 与候选 |Δ| 交错（4 败 5 胜 → p=382/512 不显著）
  const baseNine = Array.from({ length: 9 }, () => 100000);
  const candOut = [144000, 143600, 143200, 142800, 142400, 142000, 141600, 141200, 140800]; // |Δ| = 40.8k..44k
  const noiseMixed = [144300, 143300, 143500, 142500, 142700, 141700, 141900, 140900, 141100]; // |Δ| 交错 ±300
  const tokenNineOptions = { ...DEFAULT_ALIGNMENT_GATE_OPTIONS, metrics: ["totalTokens"] as const };

  it("配对 PASS 否决带外格：格判 OUT 但候选与噪声不可区分 → 总判定 PASS + advisory", () => {
    const report = runAlignmentGate(
      { name: "r1", units: unitsOf("A", "totalTokens", baseNine, "r") },
      { name: "cand", units: unitsOf("A", "totalTokens", candOut, "r") },
      { name: "r2", units: unitsOf("A", "totalTokens", noiseMixed, "r") },
      tokenNineOptions,
    );
    expect(report.cells[0]?.status).toBe("OUT"); // 池化均值确实带外
    const paired = report.paired[0];
    expect(paired?.candidateWorse).toBe(4);
    expect(paired?.candidateBetter).toBe(5);
    expect(paired?.worseDirectionP).toBeCloseTo(382 / 512, 12);
    expect(paired?.verdict).toBe("PASS");
    expect(report.verdict).toBe("PASS"); // 带外被主判据否决，不 FAIL
    expect(report.advisories.some((a) => a.includes("格带外由配对检验否决"))).toBe(true);
    expect(report.basis).toContain("主判据否决带外格 1 个");
  });

  it("配对 NOT_TESTED（无有效三元组）→ 该指标回落格判定：带外格仍触发 FAIL", () => {
    const report = runAlignmentGate(
      { name: "r1", units: unitsOf("A", "totalTokens", baseNine, "r") },
      { name: "cand", units: unitsOf("A", "totalTokens", candOut, "r") },
      { name: "r2", units: unitsOf("A", "totalTokens", noiseMixed, "z") }, // 单元键不匹配 → 零有效三元组
      tokenNineOptions,
    );
    expect(report.paired[0]?.verdict).toBe("NOT_TESTED");
    expect(report.verdict).toBe("FAIL"); // 无配对证据覆盖 → 格判定兜底
    expect(report.advisories.some((a) => a.includes("配对检验未执行"))).toBe(true);
  });
});

describe("runAlignmentGate：advisory 面", () => {
  it("已判定格 n<15 → 样本量建议 advisory", () => {
    const { baseline, candidate } = cacheHitRateSides();
    const report = runAlignmentGate(baseline, candidate, null, ONLY_CACHE_HIT);
    expect(
      report.advisories.some((a) => a.includes("C/cacheHitRate") && a.includes("n=9")),
    ).toBe(true);
  });

  it("样本量建议取最小侧：基线 n=15 / 候选 n=9 仍出；双侧 ≥15 不出", () => {
    const base15 = Array.from({ length: 15 }, (_, i) => 0.9 + i * 0.001); // mean 0.907
    const cand9 = Array.from({ length: 9 }, (_, i) => 0.905 + i * 0.001); // mean 0.909（带内）
    const smallSide = runAlignmentGate(
      { name: "b", units: unitsOf("A", "cacheHitRate", base15) },
      { name: "c", units: unitsOf("A", "cacheHitRate", cand9) },
      null,
      ONLY_CACHE_HIT,
    );
    expect(smallSide.cells[0]?.status).toBe("IN");
    expect(
      smallSide.advisories.some(
        (a) => a.includes("A/cacheHitRate") && a.includes("n=15") && a.includes("n=9") && a.includes("最小侧"),
      ),
    ).toBe(true);

    const cand15 = Array.from({ length: 15 }, (_, i) => 0.905 + i * 0.001);
    const bothSufficient = runAlignmentGate(
      { name: "b", units: unitsOf("A", "cacheHitRate", base15) },
      { name: "c", units: unitsOf("A", "cacheHitRate", cand15) },
      null,
      ONLY_CACHE_HIT,
    );
    expect(bothSufficient.advisories.some((a) => a.includes("样本量建议"))).toBe(false);
  });

  it("时点配对间隔 > 48h → advisory + exceedsThreshold；间隔内 → 无该 advisory", () => {
    const { baseline, candidate } = cacheHitRateSides();
    const far = runAlignmentGate(
      { ...baseline, window: { first: "2026-09-08T22:11:00Z", last: "2026-09-09T02:37:00Z" } },
      { ...candidate, window: { first: "2026-09-11T17:40:00Z", last: "2026-09-11T22:59:00Z" } },
      null,
      ONLY_CACHE_HIT,
    );
    expect(far.temporal?.candidateGapHours).toBeCloseTo(63.05, 1);
    expect(far.temporal?.exceedsThreshold).toBe(true);
    expect(far.advisories.some((a) => a.includes("部署漂移") || a.includes("时点"))).toBe(true);

    const near = runAlignmentGate(
      { ...baseline, window: { first: "2026-09-09T10:00:00Z", last: "2026-09-09T12:00:00Z" } },
      { ...candidate, window: { first: "2026-09-09T14:00:00Z", last: "2026-09-09T16:00:00Z" } },
      null,
      ONLY_CACHE_HIT,
    );
    expect(near.temporal?.candidateGapHours).toBeCloseTo(2, 6);
    expect(near.temporal?.exceedsThreshold).toBe(false);
    expect(near.advisories.some((a) => a.includes("时点"))).toBe(false);
  });

  it("候选窗在基线窗之前（反向时点）→ 区间距离仍为正、超阈值照常预警", () => {
    const { baseline, candidate } = cacheHitRateSides();
    const report = runAlignmentGate(
      { ...baseline, window: { first: "2026-09-10T00:00:00Z", last: "2026-09-10T06:00:00Z" } },
      { ...candidate, window: { first: "2026-09-07T06:00:00Z", last: "2026-09-07T12:00:00Z" } },
      null,
      ONLY_CACHE_HIT,
    );
    // 两窗区间距离 = base.first − cand.last = 60h（不依赖「候选在后」的方向假设）
    expect(report.temporal?.candidateGapHours).toBeCloseTo(60, 6);
    expect(report.temporal?.exceedsThreshold).toBe(true);
    expect(report.advisories.some((a) => a.includes("时点"))).toBe(true);
  });

  it("时间窗不可解析 → gap 为 null + advisory", () => {
    const { baseline, candidate } = cacheHitRateSides();
    const report = runAlignmentGate(
      { ...baseline, window: { first: "not-a-date", last: "2026-09-09T02:37:00Z" } },
      { ...candidate, window: { first: "2026-09-11T17:40:00Z", last: "2026-09-11T22:59:00Z" } },
      null,
      ONLY_CACHE_HIT,
    );
    expect(report.temporal?.candidateGapHours).toBeNull();
    expect(report.advisories.some((a) => a.includes("不可解析"))).toBe(true);
  });

  it("修订口径与遗留口径判定不一致的格在 advisories 中可见（协议变更面）", () => {
    const { baseline, candidate } = cacheHitRateSides();
    const report = runAlignmentGate(baseline, candidate, null, ONLY_CACHE_HIT);
    expect(
      report.advisories.some((a) => a.includes("C/cacheHitRate") && (a.includes("遗留") || a.includes("协议"))),
    ).toBe(true);
  });
});

describe("runAlignmentGate：选项与校验", () => {
  it("metrics 限定判定面（默认四指标 = #29 口径）", () => {
    expect(DEFAULT_GATE_METRICS).toEqual(["lineRecall", "linePrecision", "totalTokens", "cacheHitRate"]);
    const { baseline, candidate } = cacheHitRateSides();
    const report = runAlignmentGate(baseline, candidate, null);
    const metrics = new Set(report.cells.map((c) => c.metric));
    expect(metrics).toEqual(new Set(DEFAULT_GATE_METRICS));
  });

  it("非空单元 / 指标 / 选项域校验 fail fast", () => {
    const { baseline, candidate } = cacheHitRateSides();
    expect(() => runAlignmentGate({ ...baseline, units: [] }, candidate, null)).toThrow(/units/);
    expect(() =>
      runAlignmentGate(baseline, candidate, null, { ...DEFAULT_ALIGNMENT_GATE_OPTIONS, metrics: [] }),
    ).toThrow(/metrics/);
    expect(() =>
      runAlignmentGate(baseline, candidate, null, { ...DEFAULT_ALIGNMENT_GATE_OPTIONS, significanceLevel: 1.5 }),
    ).toThrow(/significanceLevel/);
    expect(() =>
      runAlignmentGate(baseline, candidate, null, { ...DEFAULT_ALIGNMENT_GATE_OPTIONS, minSampleCount: 0 }),
    ).toThrow(/minSampleCount/);
  });

  it("basis 给出人读判定依据", () => {
    const { baseline, candidate } = cacheHitRateSides();
    const report = runAlignmentGate(baseline, candidate, null, ONLY_CACHE_HIT);
    expect(report.basis).toContain("1");
    expect(report.basis.length).toBeGreaterThan(10);
    expect(report.baselineSide).toBe("poc1-r1");
    expect(report.candidateSide).toBe("dsh");
  });
});
