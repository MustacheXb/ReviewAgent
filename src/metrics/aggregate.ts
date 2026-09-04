import type { ConfigId, MetricsConfigId } from "../contracts/config.js";
import { CONFIGS, REFERENCE_CONFIG_ID } from "../contracts/config.js";
import type { MRCase } from "../contracts/mr-case.js";
import type { RunResult } from "../contracts/run.js";
import { computeEfficiencyMetrics } from "./efficiency.js";
import { computePRF } from "./quality.js";
import { screenFindings } from "./screening.js";
import { summarizeDefined } from "./stats.js";
import { computeTokenMetrics, computeToolCostTokens } from "./tokens.js";
import type {
  CaseMetricsReport,
  CaseSummaryEntry,
  ConfigCaseReport,
  ConfigSummary,
  EvaluationInput,
  FlatMetrics,
  MetricsField,
  MetricsOptions,
  MetricsReport,
  MetricsStats,
  RunMetrics,
  Stat,
} from "./types.js";
import { DEFAULT_METRICS_OPTIONS, METRICS_FIELDS } from "./types.js";

/**
 * 评估聚合（纯函数旁路 ②：runResults + truth → Metrics）。
 * 分层缓存报告协议：每 config 的运行按输入顺序排列，首个为 rep1（冷启动）单列，
 * 其余 rep2+（热稳定）为主口径；≥3 次重复时由调用方保证（本模块不强制，rep 数如实上报）。
 * 跨 case 聚合为每 case 等权（先 case 内热均值、再跨 case 均值 ± 标准差）。
 *
 * 配置键口径（T13）：分组与校验接受 MetricsConfigId（A–E + "claude-code"
 * 外部参照单列）。主实验报告只含 A–E 键；参照列由 src/reference 装配，
 * 与 A–E 走同一 evaluateRun / buildMetricsReport 路径但不进 S/A/B 判定。
 */

const CONFIG_IDS: readonly MetricsConfigId[] = [
  ...(Object.keys(CONFIGS) as ConfigId[]),
  REFERENCE_CONFIG_ID,
];
const VALID_CONFIG_IDS = new Set<string>(CONFIG_IDS);
/** 配置键的校验错误说明（列出全部合法键） */
const VALID_CONFIG_IDS_NOTE = `${[...VALID_CONFIG_IDS].map((id) => JSON.stringify(id)).join(", ")}`;

/** 单次 Run（一个 config 的一次重复运行）的完整指标 */
export function evaluateRun(
  run: RunResult,
  mrCase: MRCase,
  options: MetricsOptions = DEFAULT_METRICS_OPTIONS,
): RunMetrics {
  validateRunResult(run);
  if (run.caseId !== mrCase.caseId) {
    throw new Error(
      `run.caseId "${run.caseId}" does not match mrCase.caseId "${mrCase.caseId}"`,
    );
  }
  const screening = screenFindings(run.findings, mrCase.truth, options.screening);
  const tokens = computeTokenMetrics(run.usage);
  const toolCostTokens = computeToolCostTokens(run, options.toolCost);
  const lineLevel = computePRF(screening.lineLevel);
  const fileLevel = computePRF(screening.fileLevel);
  const efficiency = computeEfficiencyMetrics({ lineLevel, tokens, toolCostTokens });
  return {
    caseId: run.caseId,
    configId: run.configId,
    screening,
    lineCounts: screening.lineLevel,
    fileCounts: screening.fileLevel,
    lineLevel,
    fileLevel,
    tokens,
    efficiency,
    toolCostTokens,
    toolCalls: run.toolCalls,
    rounds: run.rounds,
  };
}

/** 单个 MR × 全部 config 的分层缓存报告 */
export function evaluateCase(
  input: EvaluationInput,
  options: MetricsOptions = DEFAULT_METRICS_OPTIONS,
): CaseMetricsReport {
  validateEvaluationInput(input);
  const perConfig = {} as Partial<Record<MetricsConfigId, ConfigCaseReport>>;
  for (const configId of CONFIG_IDS) {
    const runs = input.runsByConfig[configId];
    if (runs === undefined) {
      continue;
    }
    perConfig[configId] = evaluateConfigCase(input.mrCase, configId, runs, options);
  }
  return { caseId: input.mrCase.caseId, perConfig };
}

function evaluateConfigCase(
  mrCase: MRCase,
  configId: MetricsConfigId,
  runs: readonly RunResult[],
  options: MetricsOptions,
): ConfigCaseReport {
  const reps = runs.map((run) => evaluateRun(run, mrCase, options));
  const cold = reps[0] ?? null;
  const hotReps = reps.slice(1);
  return {
    configId,
    repCount: reps.length,
    cold,
    hot: hotReps.length > 0 ? summarizeFlatMetrics(hotReps.map(flattenRunMetrics)) : null,
    reps,
  };
}

/** Benchmark 级指标报告：跨 case 聚合（每 case 等权） */
export function buildMetricsReport(
  evaluations: readonly EvaluationInput[],
  options: MetricsOptions = DEFAULT_METRICS_OPTIONS,
): MetricsReport {
  if (!Array.isArray(evaluations) || evaluations.length === 0) {
    throw new Error("evaluations must be a non-empty array of EvaluationInput");
  }
  const caseReports = evaluations.map((evaluation) => evaluateCase(evaluation, options));
  const perConfig = {} as Partial<Record<MetricsConfigId, ConfigSummary>>;
  for (const configId of CONFIG_IDS) {
    const summary = summarizeConfigCases(configId, caseReports);
    if (summary !== null) {
      perConfig[configId] = summary;
    }
  }
  return { caseCount: caseReports.length, perConfig };
}

/** RunMetrics 的扁平投影（统计聚合输入形状） */
export function flattenRunMetrics(metrics: RunMetrics): FlatMetrics {
  return {
    lineTp: metrics.lineCounts.tp,
    lineFp: metrics.lineCounts.fp,
    lineFn: metrics.lineCounts.fn,
    lineRecall: metrics.lineLevel.recall,
    linePrecision: metrics.lineLevel.precision,
    lineF1: metrics.lineLevel.f1,
    fileTp: metrics.fileCounts.tp,
    fileFp: metrics.fileCounts.fp,
    fileFn: metrics.fileCounts.fn,
    fileRecall: metrics.fileLevel.recall,
    filePrecision: metrics.fileLevel.precision,
    fileF1: metrics.fileLevel.f1,
    uncachedInputTokens: metrics.tokens.uncachedInputTokens,
    cachedInputTokens: metrics.tokens.cachedInputTokens,
    cacheWriteTokens: metrics.tokens.cacheWriteTokens,
    outputTokens: metrics.tokens.outputTokens,
    totalInputTokens: metrics.tokens.totalInputTokens,
    totalTokens: metrics.tokens.totalTokens,
    cacheHitRate: metrics.tokens.cacheHitRate,
    rie: metrics.efficiency.rie,
    carc: metrics.efficiency.carc,
    toolCostTokens: metrics.toolCostTokens,
    toolCalls: metrics.toolCalls,
    rounds: metrics.rounds,
  };
}

/** 一组扁平指标的均值 ± 样本标准差（逐字段；null 值跳过，全空字段为 null） */
export function summarizeFlatMetrics(samples: readonly FlatMetrics[]): MetricsStats {
  if (samples.length === 0) {
    throw new Error("summarizeFlatMetrics requires at least one sample");
  }
  const values = {} as Record<MetricsField, Stat | null>;
  for (const field of METRICS_FIELDS) {
    values[field] = summarizeDefined(samples.map((sample) => sample[field]));
  }
  return { sampleCount: samples.length, values };
}

/** 统计结果的均值投影（每字段取 Stat.mean；无样本字段为 null） */
export function meanFlatMetrics(stats: MetricsStats): FlatMetrics {
  const means = {} as Record<MetricsField, number | null>;
  for (const field of METRICS_FIELDS) {
    const stat = stats.values[field];
    means[field] = stat === null || stat === undefined ? null : stat.mean;
  }
  return means;
}

function summarizeConfigCases(
  configId: MetricsConfigId,
  caseReports: readonly CaseMetricsReport[],
): ConfigSummary | null {
  const entries = caseReports.flatMap((report) => {
    const configReport = report.perConfig[configId];
    return configReport === undefined ? [] : [{ caseId: report.caseId, report: configReport }];
  });
  if (entries.length === 0) {
    return null;
  }
  const coldSamples = entries.flatMap((entry) =>
    entry.report.cold === null ? [] : [flattenRunMetrics(entry.report.cold)],
  );
  const hotMeans = entries.flatMap((entry) =>
    entry.report.hot === null ? [] : [meanFlatMetrics(entry.report.hot)],
  );
  return {
    configId,
    caseCount: entries.length,
    hotCaseCount: hotMeans.length,
    cold: coldSamples.length > 0 ? summarizeFlatMetrics(coldSamples) : null,
    hot: hotMeans.length > 0 ? summarizeFlatMetrics(hotMeans) : null,
    perCase: entries.map((entry) => summarizeCaseEntry(entry.caseId, entry.report)),
  };
}

function summarizeCaseEntry(caseId: string, report: ConfigCaseReport): CaseSummaryEntry {
  return {
    caseId,
    repCount: report.repCount,
    cold: report.cold === null ? null : flattenRunMetrics(report.cold),
    hot: report.hot === null ? null : meanFlatMetrics(report.hot),
  };
}

// ===== 输入校验（fail fast，错误指明字段与期望） =====

function validateEvaluationInput(input: EvaluationInput): void {
  if (typeof input !== "object" || input === null) {
    throw new Error("input must be an EvaluationInput object");
  }
  if (typeof input.mrCase !== "object" || input.mrCase === null) {
    throw new Error("input.mrCase must be an MRCase object");
  }
  requireNonEmptyString(input.mrCase.caseId, "input.mrCase.caseId");
  if (typeof input.runsByConfig !== "object" || input.runsByConfig === null) {
    throw new Error("input.runsByConfig must be a Partial record of MetricsConfigId to RunResult[]");
  }
  const keys = Object.keys(input.runsByConfig);
  if (keys.length === 0) {
    throw new Error("input.runsByConfig must list at least one config");
  }
  for (const key of keys) {
    if (!VALID_CONFIG_IDS.has(key)) {
      throw new Error(
        `input.runsByConfig has unknown config key "${key}" (must be one of ${VALID_CONFIG_IDS_NOTE})`,
      );
    }
    validateConfigRuns(key as MetricsConfigId, input.runsByConfig[key as MetricsConfigId], input.mrCase.caseId);
  }
}

function validateConfigRuns(
  configId: MetricsConfigId,
  runs: unknown,
  caseId: string,
): void {
  if (!Array.isArray(runs) || runs.length === 0) {
    throw new Error(`input.runsByConfig["${configId}"] must be a non-empty array of RunResult`);
  }
  runs.forEach((run, index) => {
    if (typeof run !== "object" || run === null) {
      throw new Error(`input.runsByConfig["${configId}"][${index}] must be a RunResult object`);
    }
    const record = run as RunResult;
    if (record.caseId !== caseId) {
      throw new Error(
        `input.runsByConfig["${configId}"][${index}].caseId "${record.caseId}" does not match mrCase.caseId "${caseId}"`,
      );
    }
    if (record.configId !== configId) {
      throw new Error(
        `input.runsByConfig["${configId}"][${index}].configId "${record.configId}" does not match its key "${configId}"`,
      );
    }
  });
}

function validateRunResult(run: RunResult): void {
  if (typeof run !== "object" || run === null) {
    throw new Error("run must be a RunResult object");
  }
  requireNonEmptyString(run.caseId, "run.caseId");
  if (!VALID_CONFIG_IDS.has(run.configId)) {
    throw new Error(
      `run.configId must be one of ${VALID_CONFIG_IDS_NOTE} (got ${JSON.stringify(run.configId)})`,
    );
  }
  if (!Number.isInteger(run.rounds) || run.rounds < 0) {
    throw new Error(`run.rounds must be a non-negative integer (got ${JSON.stringify(run.rounds)})`);
  }
  if (!Number.isInteger(run.toolCalls) || run.toolCalls < 0) {
    throw new Error(
      `run.toolCalls must be a non-negative integer (got ${JSON.stringify(run.toolCalls)})`,
    );
  }
  if (typeof run.audit !== "object" || run.audit === null || !Array.isArray(run.audit.toolCallLog)) {
    throw new Error("run.audit.toolCallLog must be an array of ToolCallRecord");
  }
  run.audit.toolCallLog.forEach((call, index) => {
    if (typeof call !== "object" || call === null || typeof call.resultSummary !== "string") {
      throw new Error(
        `run.audit.toolCallLog[${index}] must be a ToolCallRecord with a string resultSummary`,
      );
    }
  });
}

function requireNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}
