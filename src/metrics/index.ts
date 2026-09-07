/**
 * 指标计算 + 规则粗筛 + S/A/B 判定（Ticket 10 / issue #11）——纯函数旁路 ②。
 *
 * 判定链：原生真值 → 【规则粗筛】→ GPT 系 LLM-as-judge（Ticket 11）→ 人工抽检。
 * 复用接口：
 * - Ticket 11（judge 校准）：screenFindings / evaluateRun 产出的 FindingVerdict、TruthMiss 与
 *   计数，judge 在其上做异构复核；computePRF / computeEfficiencyMetrics 可用 judge 复核后的计数重算。
 * - Ticket 12（运行器）：EvaluationInput → buildMetricsReport → judgeAllVerdicts 一条链，
 *   DEFAULT_METRICS_OPTIONS / DEFAULT_VERDICT_THRESHOLDS 可按实验配置覆盖。
 */
export {
  buildAliasLookup,
  canonicalNature,
  normalizeFilePath,
  screenFindings,
  validateFindings,
  validateScreeningOptions,
  validateTruth,
} from "./screening.js";
export { computeTokenMetrics, computeToolCostTokens } from "./tokens.js";
export { computeF1, computePRF } from "./quality.js";
export { computeEfficiencyMetrics } from "./efficiency.js";
export { summarize, summarizeDefined } from "./stats.js";
export {
  buildMetricsReport,
  evaluateCase,
  evaluateRun,
  flattenRunMetrics,
  meanFlatMetrics,
  summarizeFlatMetrics,
} from "./aggregate.js";
export {
  judgeAllVerdicts,
  judgeVerdict,
  verdictMetricsFrom,
  VERDICT_EPSILON,
} from "./verdict.js";
export {
  DEFAULT_METRICS_OPTIONS,
  DEFAULT_SCREENING_OPTIONS,
  DEFAULT_TOOL_COST_PRICING,
  DEFAULT_VERDICT_THRESHOLDS,
  METRICS_FIELDS,
} from "./types.js";
export { DEFECT_NATURES, isDefectNature } from "../dataset/defect-nature.js";
export type {
  CriterionResult,
  EfficiencyMetrics,
  EvaluationInput,
  CaseMetricsReport,
  CaseSummaryEntry,
  ConfigCaseReport,
  ConfigSummary,
  FindingVerdict,
  FlatMetrics,
  FpReason,
  MetricsField,
  MetricsOptions,
  MetricsReport,
  MetricsStats,
  PRFMetrics,
  RunMetrics,
  ScreeningCounts,
  ScreeningOptions,
  ScreeningResult,
  Stat,
  TokenMetrics,
  ToolCostPricing,
  TruthMiss,
  VerdictGrade,
  VerdictMetrics,
  VerdictOptions,
  VerdictOutcome,
  VerdictReport,
  VerdictReports,
  VerdictThresholds,
} from "./types.js";
