import { describe, expect, it } from "vitest";
import {
  addConfusion,
  agreementMetrics,
  EMPTY_PAIR_CONFUSION,
  judgeMatchedPairs,
  officialMatchedPairs,
  pairConfusionForSample,
  pairKey,
  pairsExactlyMatch,
} from "../../src/calibration/agreement.js";

describe("officialMatchedPairs — 官方判定 → 命中对键集（1 起 → 0 起）", () => {
  it("truth 索引非 null 的条目构成命中对", () => {
    const pairs = officialMatchedPairs(3, 3, [
      { modelDefectIndex: 1, groundTruthDefectIndex: 2 },
      { modelDefectIndex: 3, groundTruthDefectIndex: 1 },
    ]);
    expect([...pairs].sort()).toEqual(["0:1", "2:0"]);
  });

  it("拒绝条目（gt null）与越界索引条目不计入", () => {
    const pairs = officialMatchedPairs(2, 2, [
      { modelDefectIndex: 1, groundTruthDefectIndex: null },
      { modelDefectIndex: 5, groundTruthDefectIndex: 1 },
      { modelDefectIndex: 2, groundTruthDefectIndex: 9 },
      { modelDefectIndex: 2, groundTruthDefectIndex: 2 },
    ]);
    expect([...pairs]).toEqual(["1:1"]);
  });
});

describe("judgeMatchedPairs / pairKey", () => {
  it("占用解析后的命中对直接映射为键（0 起）", () => {
    expect(pairKey(3, 7)).toBe("3:7");
    const pairs = judgeMatchedPairs([
      { findingIndex: 0, truthIndex: 1 },
      { findingIndex: 1, truthIndex: 0 },
    ]);
    expect([...pairs].sort()).toEqual(["0:1", "1:0"]);
  });
});

describe("pairConfusionForSample — 候选对混淆矩阵", () => {
  it("2×2 宇宙上逐对分类", () => {
    const confusion = pairConfusionForSample({
      findingCount: 2,
      truthCount: 2,
      officialPairs: new Set([pairKey(0, 0)]),
      judgePairs: new Set([pairKey(0, 0), pairKey(1, 0)]),
    });
    expect(confusion).toEqual({ both: 1, officialOnly: 0, judgeOnly: 1, neither: 2 });
  });

  it("完全一致 → 双侧计数相等、无分歧单元", () => {
    const confusion = pairConfusionForSample({
      findingCount: 1,
      truthCount: 1,
      officialPairs: new Set([pairKey(0, 0)]),
      judgePairs: new Set([pairKey(0, 0)]),
    });
    expect(confusion).toEqual({ both: 1, officialOnly: 0, judgeOnly: 0, neither: 0 });
  });

  it("非法计数 fail fast", () => {
    expect(() =>
      pairConfusionForSample({ findingCount: -1, truthCount: 1, officialPairs: new Set(), judgePairs: new Set() }),
    ).toThrowError(/findingCount/);
  });
});

describe("addConfusion — 不可变累加", () => {
  it("返回新对象，原矩阵不变", () => {
    const left = { both: 1, officialOnly: 2, judgeOnly: 3, neither: 4 };
    const right = { both: 10, officialOnly: 20, judgeOnly: 30, neither: 40 };
    const sum = addConfusion(left, right);
    expect(sum).toEqual({ both: 11, officialOnly: 22, judgeOnly: 33, neither: 44 });
    expect(left).toEqual({ both: 1, officialOnly: 2, judgeOnly: 3, neither: 4 });
    expect(addConfusion(EMPTY_PAIR_CONFUSION, left)).toEqual(left);
  });
});

describe("agreementMetrics — 一致率与 Cohen's kappa", () => {
  it("已知例：po = 0.85、kappa = 0.625", () => {
    const metrics = agreementMetrics({ both: 20, officialOnly: 5, judgeOnly: 10, neither: 65 });
    expect(metrics.totalPairs).toBe(100);
    expect(metrics.agreementRate).toBeCloseTo(0.85, 12);
    expect(metrics.kappa).toBeCloseTo(0.625, 12);
  });

  it("完全一致且存在两侧分歧空间 → kappa = 1", () => {
    const metrics = agreementMetrics({ both: 8, officialOnly: 0, judgeOnly: 0, neither: 2 });
    expect(metrics.agreementRate).toBe(1);
    expect(metrics.kappa).toBe(1);
  });

  it("空宇宙（N=0）→ 双 null", () => {
    expect(agreementMetrics(EMPTY_PAIR_CONFUSION)).toEqual({
      agreementRate: null,
      kappa: null,
      totalPairs: 0,
    });
  });

  it("退化（pe = 1，如全宇宙均判 no-match）→ kappa null、一致率仍有定义", () => {
    const metrics = agreementMetrics({ both: 0, officialOnly: 0, judgeOnly: 0, neither: 10 });
    expect(metrics.agreementRate).toBe(1);
    expect(metrics.kappa).toBeNull();
  });
});

describe("pairsExactlyMatch — 集合级完全一致（最严口径）", () => {
  it("集合相同 → true；元素不同 / 大小不同 → false", () => {
    expect(pairsExactlyMatch(new Set(["0:0"]), new Set(["0:0"]))).toBe(true);
    expect(pairsExactlyMatch(new Set(["0:0", "1:1"]), new Set(["1:1", "0:0"]))).toBe(true);
    expect(pairsExactlyMatch(new Set(["0:0"]), new Set(["0:1"]))).toBe(false);
    expect(pairsExactlyMatch(new Set(["0:0"]), new Set(["0:0", "1:1"]))).toBe(false);
    expect(pairsExactlyMatch(new Set<string>(), new Set<string>())).toBe(true);
  });
});
