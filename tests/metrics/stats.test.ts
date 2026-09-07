import { describe, expect, it } from "vitest";
import { summarize, summarizeDefined } from "../../src/metrics/stats.js";

/** 统计聚合：均值 ± 样本标准差（n-1）；空集显式报错 */

describe("summarize", () => {
  it("computes the mean and the sample standard deviation (n-1)", () => {
    expect(summarize([2, 4])).toEqual({ count: 2, mean: 3, std: Math.SQRT2 });
    expect(summarize([1, 2, 3])).toEqual({ count: 3, mean: 2, std: 1 });
  });

  it("defines std as 0 for a single sample", () => {
    expect(summarize([5])).toEqual({ count: 1, mean: 5, std: 0 });
  });

  it("throws on an empty sample (division by zero is explicit, never silent)", () => {
    expect(() => summarize([])).toThrow(/at least one value/);
  });
});

describe("summarizeDefined", () => {
  it("skips null and non-finite values", () => {
    expect(summarizeDefined([1, null, 3, Number.NaN])).toEqual({
      count: 2,
      mean: 2,
      std: Math.SQRT2,
    });
  });

  it("returns null when no value is defined", () => {
    expect(summarizeDefined([null, null])).toBeNull();
    expect(summarizeDefined([])).toBeNull();
  });
});
