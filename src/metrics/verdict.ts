import type { ConfigId } from "../contracts/config.js";
import { CONFIGS } from "../contracts/config.js";
import type {
  CriterionResult,
  MetricsReport,
  MetricsStats,
  VerdictGrade,
  VerdictMetrics,
  VerdictOptions,
  VerdictOutcome,
  VerdictReport,
  VerdictReports,
  VerdictThresholds,
} from "./types.js";
import { DEFAULT_VERDICT_THRESHOLDS } from "./types.js";

/**
 * S/A/B 自动判定（质量主锚 = 配置 C，spec #1 user story 29，主文档第 7 章 POC 成功标准）。
 * 判据输入取 rep2+（热稳定）主口径；Cache Hit 阈值为绝对值，Recall/Token 为相对锚 C 的倍乘：
 * - S：Recall ≥ C×90% ∧ Token ≤ C×30% ∧ Cache Hit ≥ 85%
 * - A：Recall ≥ C×80% ∧ Token ≤ C×30% ∧ Cache Hit ≥ 80%
 * - B：Recall ≥ C×70% ∧ Token ≤ C×50%（无缓存判据）
 * 档位取全部判据通过的最高档；无档通过 → BELOW_B；锚不可用 → NOT_EVALUABLE。
 * 比较带 ε（1e-9）容差，消除比率乘法的浮点噪声（如 0.8×0.9 = 0.7200000000000001）。
 */

/** 比较容差：value ≥ threshold - ε / value ≤ threshold + ε */
export const VERDICT_EPSILON = 1e-9;

const GRADE_ORDER: readonly VerdictGrade[] = ["S", "A", "B"];
const CONFIG_IDS: readonly ConfigId[] = Object.keys(CONFIGS) as ConfigId[];

/** 从热口径统计中提取判定输入（三判据指标取均值） */
export function verdictMetricsFrom(stats: MetricsStats): VerdictMetrics {
  const recall = stats.values.lineRecall;
  const totalTokens = stats.values.totalTokens;
  const cacheHitRate = stats.values.cacheHitRate;
  return {
    recall: recall === null || recall === undefined ? null : recall.mean,
    totalTokens: totalTokens === null || totalTokens === undefined ? null : totalTokens.mean,
    cacheHitRate: cacheHitRate === null || cacheHitRate === undefined ? null : cacheHitRate.mean,
  };
}

/** 单个 config 的 S/A/B 判定（纯函数） */
export function judgeVerdict(
  configId: ConfigId,
  target: VerdictMetrics,
  anchor: VerdictMetrics,
  options?: VerdictOptions,
): VerdictReport {
  validateVerdictMetrics(target, "target");
  validateVerdictMetrics(anchor, "anchor");
  const thresholds = options?.thresholds ?? DEFAULT_VERDICT_THRESHOLDS;
  validateThresholds(thresholds);
  const anchorInfo = { configId: "C" as const, ...anchor };
  if (anchor.recall === null || anchor.totalTokens === null) {
    return notEvaluable(configId, target, anchorInfo, describeMissingAnchor(anchor));
  }
  const perGrade = GRADE_ORDER.map((grade) => ({
    grade,
    criteria: criteriaForGrade(grade, target, anchor, thresholds[grade]),
  }));
  const criteria = perGrade.flatMap((entry) => entry.criteria);
  const achieved = perGrade.find((entry) => entry.criteria.every((criterion) => criterion.pass));
  const outcome: VerdictOutcome = achieved === undefined ? "BELOW_B" : achieved.grade;
  return {
    configId,
    outcome,
    grade: achieved === undefined ? null : achieved.grade,
    target,
    anchor: anchorInfo,
    criteria,
    basis: buildBasis(outcome, target, anchor, achieved?.grade ?? null, criteria),
  };
}

/** 对报告中全部 config 判定（锚 = config C 的 rep2+ 热口径；配置 C 自身同样按公式机械判定） */
export function judgeAllVerdicts(
  report: MetricsReport,
  options?: VerdictOptions,
): VerdictReports {
  if (
    typeof report !== "object" ||
    report === null ||
    typeof report.perConfig !== "object" ||
    report.perConfig === null
  ) {
    throw new Error("report must be a MetricsReport object with a perConfig record");
  }
  const anchorSummary = report.perConfig.C;
  const anchorHot = anchorSummary?.hot ?? null;
  const anchor: VerdictMetrics =
    anchorHot === null ? NULL_VERDICT_METRICS : verdictMetricsFrom(anchorHot);
  const anchorAvailable = anchorHot !== null && anchor.recall !== null && anchor.totalTokens !== null;
  const configIds = CONFIG_IDS.filter((configId) => report.perConfig[configId] !== undefined);
  const verdicts = configIds.map((configId) => {
    const summary = report.perConfig[configId];
    const hot = summary?.hot ?? null;
    if (hot === null) {
      return notEvaluable(
        configId,
        NULL_VERDICT_METRICS,
        { configId: "C", ...anchor },
        `config ${configId} has no rep2+ hot metrics (at least 2 reps are required for the primary measure)`,
      );
    }
    return judgeVerdict(configId, verdictMetricsFrom(hot), anchor, options);
  });
  return { anchorConfigId: "C", anchorAvailable, verdicts };
}

const NULL_VERDICT_METRICS: VerdictMetrics = {
  recall: null,
  totalTokens: null,
  cacheHitRate: null,
};

function criteriaForGrade(
  grade: VerdictGrade,
  target: VerdictMetrics,
  anchor: VerdictMetrics,
  threshold: VerdictThresholds,
): readonly CriterionResult[] {
  const recallThreshold = anchor.recall === null ? null : anchor.recall * threshold.recallRatio;
  const tokenThreshold =
    anchor.totalTokens === null ? null : anchor.totalTokens * threshold.tokenRatio;
  const criteria: CriterionResult[] = [
    {
      grade,
      metric: "RECALL",
      comparison: "AT_LEAST",
      pass:
        target.recall !== null &&
        recallThreshold !== null &&
        target.recall >= recallThreshold - VERDICT_EPSILON,
      value: target.recall,
      threshold: recallThreshold,
      note: nullValueNote(target.recall),
    },
    {
      grade,
      metric: "TOTAL_TOKENS",
      comparison: "AT_MOST",
      pass:
        target.totalTokens !== null &&
        tokenThreshold !== null &&
        target.totalTokens <= tokenThreshold + VERDICT_EPSILON,
      value: target.totalTokens,
      threshold: tokenThreshold,
      note: nullValueNote(target.totalTokens),
    },
  ];
  criteria.push(cacheCriterion(grade, target, threshold.cacheHitRate));
  return criteria;
}

function cacheCriterion(
  grade: VerdictGrade,
  target: VerdictMetrics,
  cacheThreshold: number | null,
): CriterionResult {
  if (cacheThreshold === null) {
    return {
      grade,
      metric: "CACHE_HIT_RATE",
      comparison: "AT_LEAST_ABSOLUTE",
      pass: true,
      value: target.cacheHitRate,
      threshold: null,
      note: "no cache-hit criterion for this grade (spec #1 user story 29)",
    };
  }
  return {
    grade,
    metric: "CACHE_HIT_RATE",
    comparison: "AT_LEAST_ABSOLUTE",
    pass: target.cacheHitRate !== null && target.cacheHitRate >= cacheThreshold - VERDICT_EPSILON,
    value: target.cacheHitRate,
    threshold: cacheThreshold,
    note: nullValueNote(target.cacheHitRate),
  };
}

function nullValueNote(value: number | null): string | null {
  return value === null ? "metric unavailable (null); criterion counted as failed" : null;
}

function notEvaluable(
  configId: ConfigId,
  target: VerdictMetrics,
  anchor: VerdictReport["anchor"],
  reason: string,
): VerdictReport {
  return {
    configId,
    outcome: "NOT_EVALUABLE",
    grade: null,
    target,
    anchor,
    criteria: [],
    basis: `Not evaluable: ${reason}.`,
  };
}

function describeMissingAnchor(anchor: VerdictMetrics): string {
  const missing: string[] = [];
  if (anchor.recall === null) {
    missing.push("line-level Recall");
  }
  if (anchor.totalTokens === null) {
    missing.push("Total Tokens");
  }
  return `anchor config C ${missing.join(" and ")} unavailable (rep2+ hot metrics required)`;
}

function buildBasis(
  outcome: VerdictOutcome,
  target: VerdictMetrics,
  anchor: VerdictMetrics,
  grade: VerdictGrade | null,
  criteria: readonly CriterionResult[],
): string {
  if (outcome === "NOT_EVALUABLE") {
    return "Not evaluable: anchor config C metrics are unavailable.";
  }
  const summary = `line Recall ${formatMetric(target.recall)} vs anchor ${formatMetric(anchor.recall)}; Total Tokens ${formatMetric(target.totalTokens)} vs anchor ${formatMetric(anchor.totalTokens)}; Cache Hit ${formatMetric(target.cacheHitRate)}`;
  if (grade !== null) {
    return `Grade ${grade} achieved: all ${grade}-level criteria passed (${summary}).`;
  }
  const failed = criteria
    .filter((criterion) => criterion.grade === "B" && !criterion.pass)
    .map((criterion) => `${criterion.grade}-${criterion.metric}`)
    .join(", ");
  return `Below B: failed B-level criteria${failed.length > 0 ? ` (${failed})` : ""} (${summary}).`;
}

function formatMetric(value: number | null): string {
  if (value === null) {
    return "unavailable";
  }
  return String(Number(value.toFixed(6)));
}

function validateVerdictMetrics(metrics: VerdictMetrics, name: string): void {
  if (typeof metrics !== "object" || metrics === null) {
    throw new Error(`${name} must be a VerdictMetrics object`);
  }
  requireRatio(metrics.recall, `${name}.recall`);
  requireRatio(metrics.cacheHitRate, `${name}.cacheHitRate`);
  requireNonNegative(metrics.totalTokens, `${name}.totalTokens`);
}

function validateThresholds(thresholds: Readonly<Record<VerdictGrade, VerdictThresholds>>): void {
  for (const grade of GRADE_ORDER) {
    const threshold = thresholds[grade];
    if (typeof threshold !== "object" || threshold === null) {
      throw new Error(`thresholds.${grade} must be a VerdictThresholds object`);
    }
    requireNonNegative(threshold.recallRatio, `thresholds.${grade}.recallRatio`);
    requireNonNegative(threshold.tokenRatio, `thresholds.${grade}.tokenRatio`);
    if (threshold.cacheHitRate !== null) {
      requireRatio(threshold.cacheHitRate, `thresholds.${grade}.cacheHitRate`);
    }
  }
}

function requireRatio(value: number | null, field: string): void {
  if (value === null) {
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be null or a number in [0, 1] (got ${JSON.stringify(value)})`);
  }
}

function requireNonNegative(value: number | null, field: string): void {
  if (value === null) {
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be null or a non-negative number (got ${JSON.stringify(value)})`);
  }
}
