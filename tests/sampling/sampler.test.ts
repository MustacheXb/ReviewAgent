import { describe, expect, it } from "vitest";
import { fnv1a32, sampleUnits, type SamplingUnit } from "../../src/sampling/sampler.js";

function units(keys: readonly string[], stratumOf?: (key: string) => string | null): SamplingUnit[] {
  return keys.map((key) => ({
    key,
    ...(stratumOf === undefined ? {} : { stratum: stratumOf(key) }),
  }));
}

function keyStrings(selected: readonly SamplingUnit[]): string[] {
  return selected.map((unit) => unit.key);
}

describe("fnv1a32 — 确定性整数哈希", () => {
  it("匹配 FNV-1a 32 位参考向量", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
  });

  it("种子参与哈希且经 NUL 分隔（无拼接歧义）", () => {
    // hash(key, seed) = fnv(seed + NUL + key)
    expect(fnv1a32("a", "s")).toBe(fnv1a32(`s${String.fromCharCode(0)}a`));
    // 不同种子 → 不同哈希
    expect(fnv1a32("a", "seed-1")).not.toBe(fnv1a32("a", "seed-2"));
    // NUL 分隔消除歧义：("ab","c") ≠ ("b","ca")
    expect(fnv1a32("ab", "c")).not.toBe(fnv1a32("b", "ca"));
  });
});

describe("sampleUnits — 确定性（同 seed 同样本）", () => {
  const population = units(Array.from({ length: 100 }, (_, i) => `case-${i}:C:rep1`));

  it("同 seed 两次调用结果完全一致", () => {
    const first = sampleUnits(population, { rate: 0.1, seed: "poc1-2026" });
    const second = sampleUnits(population, { rate: 0.1, seed: "poc1-2026" });
    expect(keyStrings(second.selected)).toEqual(keyStrings(first.selected));
  });

  it("与输入顺序无关（打乱输入 → 同一入选集合）", () => {
    const plan = sampleUnits(population, { rate: 0.1, seed: "poc1-2026" });
    const shuffled = [...population].reverse();
    const shuffledPlan = sampleUnits(shuffled, { rate: 0.1, seed: "poc1-2026" });
    expect(new Set(keyStrings(shuffledPlan.selected))).toEqual(new Set(keyStrings(plan.selected)));
  });

  it("不同 seed → 不同样本（100 单元 10% 抽样下）", () => {
    const first = sampleUnits(population, { rate: 0.1, seed: "seed-alpha" });
    const second = sampleUnits(population, { rate: 0.1, seed: "seed-beta" });
    expect(new Set(keyStrings(second.selected))).not.toEqual(new Set(keyStrings(first.selected)));
  });
});

describe("sampleUnits — 样本量与分层", () => {
  it("单一分层 rate 0.1 × 100 单元 → 10 个", () => {
    const plan = sampleUnits(units(Array.from({ length: 100 }, (_, i) => `k${i}`)), {
      rate: 0.1,
      seed: "s",
    });
    expect(plan.sampleSize).toBe(10);
    expect(plan.populationSize).toBe(100);
    expect(plan.selected.length + plan.remaining.length).toBe(100);
    expect(new Set(keyStrings(plan.selected)).size).toBe(10);
  });

  it("ceil 向上取整：小种群保底覆盖", () => {
    const plan = sampleUnits(units(["a", "b", "c"]), { rate: 0.1, seed: "s" });
    expect(plan.sampleSize).toBe(1);
    const half = sampleUnits(units(["a", "b", "c"]), { rate: 0.5, seed: "s" });
    expect(half.sampleSize).toBe(2);
  });

  it("分层各自独立抽取，稀有层不被稀释", () => {
    const population = units(
      Array.from({ length: 90 }, (_, i) => `agree-${i}`),
      () => "agreement",
    ).concat(units(Array.from({ length: 4 }, (_, i) => `disagree-${i}`), () => "disagreement"));
    const plan = sampleUnits(population, { rate: 0.1, seed: "s" });
    const strata = new Map(plan.strata.map((entry) => [entry.stratum, entry]));
    expect(strata.get("agreement")?.sampleSize).toBe(9);
    // 4 × 0.1 = 0.4 → ceil = 1：分歧层保底 1 个
    expect(strata.get("disagreement")?.sampleSize).toBe(1);
    expect(plan.sampleSize).toBe(10);
  });

  it("无 stratum 字段的单元落 default 层", () => {
    const plan = sampleUnits(units(["a", "b"]), { rate: 0.5, seed: "s" });
    expect(plan.strata[0]?.stratum).toBe("default");
  });

  it("入选/未入选按输入顺序返回（展示稳定）", () => {
    const ordered = units(["a", "b", "c", "d", "e"]);
    const plan = sampleUnits(ordered, { rate: 0.4, seed: "s" });
    const inputOrder = ["a", "b", "c", "d", "e"];
    const rank = (key: string): number => inputOrder.indexOf(key);
    const isAscending = (keys: string[]): boolean =>
      keys.every((key, index) => index === 0 || rank(keys[index - 1]!) < rank(key));
    expect(isAscending(keyStrings(plan.selected))).toBe(true);
    expect(isAscending(keyStrings(plan.remaining))).toBe(true);
  });
});

describe("sampleUnits — 入参校验（fail fast）", () => {
  it("rate 越界 / 非数值拒绝", () => {
    for (const rate of [0, -0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => sampleUnits(units(["a"]), { rate, seed: "s" })).toThrowError(/rate must be/);
    }
  });

  it("空 seed / 空 key / 重复 key 拒绝", () => {
    expect(() => sampleUnits(units(["a"]), { rate: 0.5, seed: "" })).toThrowError(/seed must be/);
    expect(() => sampleUnits(units([""]), { rate: 0.5, seed: "s" })).toThrowError(/key must be/);
    expect(() => sampleUnits(units(["a", "a"]), { rate: 0.5, seed: "s" })).toThrowError(
      /is duplicated/,
    );
  });

  it("非对象单元 / 非法 stratum 类型拒绝", () => {
    expect(() =>
      sampleUnits([undefined as unknown as SamplingUnit], { rate: 0.5, seed: "s" }),
    ).toThrowError(/must be a SamplingUnit object/);
    expect(() =>
      sampleUnits([{ key: "a", stratum: 7 } as unknown as SamplingUnit], { rate: 0.5, seed: "s" }),
    ).toThrowError(/stratum must be/);
  });

  it("空种群 → 空计划（合法）", () => {
    const plan = sampleUnits([], { rate: 0.1, seed: "s" });
    expect(plan.sampleSize).toBe(0);
    expect(plan.selected).toEqual([]);
    expect(plan.strata).toEqual([]);
  });
});
