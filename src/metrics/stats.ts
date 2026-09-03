import type { Stat } from "./types.js";

/**
 * 统计聚合纯函数：均值 ± 样本标准差（n-1）。
 * 全部返回新对象，不改写任何入参。
 */

/** 汇总一组数值；空数组显式报错（调用方必须先判空） */
export function summarize(values: readonly number[]): Stat {
  if (values.length === 0) {
    throw new Error("summarize requires at least one value (got an empty array)");
  }
  const total = values.reduce((acc, value) => acc + value, 0);
  const mean = total / values.length;
  return { count: values.length, mean, std: sampleStd(values, mean) };
}

/** 汇总一组可能含 null/非有限值的指标：跳过无效值；全部无效时返回 null */
export function summarizeDefined(values: readonly (number | null)[]): Stat | null {
  const defined = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (defined.length === 0) {
    return null;
  }
  return summarize(defined);
}

/** 样本标准差（n-1 分母）；样本数 ≤ 1 时无变异，定义为 0 */
function sampleStd(values: readonly number[], mean: number): number {
  if (values.length <= 1) {
    return 0;
  }
  const squaredDiff = values.reduce((acc, value) => acc + (value - mean) ** 2, 0);
  return Math.sqrt(squaredDiff / (values.length - 1));
}
