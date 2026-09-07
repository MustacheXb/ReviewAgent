import type { PRFMetrics, ScreeningCounts } from "./types.js";

/**
 * Review Quality 指标（file-level 与 line-level 同一套公式）：
 * Recall = tp / (tp + fn)；Precision = tp / (tp + fp)；F1 = 2PR / (P + R)。
 * 分母为零显式处理：
 * - tp + fn = 0（无真值位置，clean MR）→ recall = null（未定义，不参与聚合）
 * - tp + fp = 0（零 finding）→ precision = null
 * - 任一成分 null → f1 = null；P 与 R 均为 0（tp = 0）→ f1 = 0（ML 惯例）
 */
export function computePRF(counts: ScreeningCounts): PRFMetrics {
  const recall = ratio(counts.tp, counts.tp + counts.fn);
  const precision = ratio(counts.tp, counts.tp + counts.fp);
  return { recall, precision, f1: computeF1(recall, precision) };
}

/** 由已算出的 Recall / Precision 求 F1 */
export function computeF1(recall: number | null, precision: number | null): number | null {
  if (recall === null || precision === null) {
    return null;
  }
  if (recall + precision === 0) {
    return 0;
  }
  return (2 * recall * precision) / (recall + precision);
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}
