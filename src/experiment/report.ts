import type { ConfigId } from "../contracts/config.js";
import { CONFIGS } from "../contracts/config.js";
import type { MRCase } from "../contracts/mr-case.js";
import { runUnitKeyString } from "../contracts/run-unit.js";
import type { CacheBreakReason } from "../contracts/run.js";
import type { RunResult } from "../contracts/run.js";
import { CACHE_BREAK_REASONS, tallyCacheBreakReasons } from "../loop/cache-break.js";
import type { JudgeClient, JudgeRunResult } from "../judge/index.js";
import { flattenJudgeRun, judgeRun } from "../judge/index.js";
import {
  buildMetricsReport,
  evaluateRun,
  judgeAllVerdicts,
  meanFlatMetrics,
  summarizeFlatMetrics,
} from "../metrics/index.js";
import type {
  EvaluationInput,
  FlatMetrics,
  MetricsReport,
  MetricsStats,
  VerdictReports,
} from "../metrics/types.js";
import { buildHumanReviewForms, buildReviewUnits, buildSamplingPlan } from "../sampling/index.js";
import type { HumanReviewForm } from "../sampling/index.js";
import {
  groupAndSortByRep,
  meanOf,
  readJsonArrayFile,
  readJsonFile,
  writeJsonFile,
} from "../shared/report-io.js";
import path from "node:path";
import type { ExperimentPlan } from "./plan.js";
import { expandPlan } from "./plan.js";
import type { RunFailure, RunnerPaths } from "./runner.js";
import { FAILURES_FILE } from "./runner.js";
import type { RunRecord } from "./run-store.js";
import { recordToBaselineRunResult, recordToRunResult, RunStore } from "./run-store.js";

/**
 * 实验报告装配（Ticket 12）：记录 → 指标聚合（分层冷/热）→ S/A/B 判定（锚 C）
 * → 阴性对照单列 → Verifier 消融对照 → Ledger 去重复核 → judge 判定链（断点续跑）
 * → 10% 人工抽检表单。
 *
 * 口径纪律：
 * - clean MR（truth = null）不进主指标与 S/A/B（无真值锚点），单列 FP 报告
 *   （阴性对照口径：每条 Finding 计 1 FP）；
 * - Verifier on 时主口径 = 复核后 Finding + 合并 usage（Verifier token 计入 CARC），
 *   off 档对照 = 同批运行的基线 Finding（单遍自证），成对可比；
 * - judge 阶段按单元落盘续跑（judgeRun 有界失败，error 回退规则口径）。
 */

const CONFIG_IDS: readonly ConfigId[] = Object.keys(CONFIGS) as ConfigId[];
const LEDGER_DEDUP_PREFIX = "Already loaded: ctx#";

export interface NegativeControlConfigEntry {
  readonly configId: ConfigId;
  readonly caseCount: number;
  /** FP 总数（全部 rep） */
  readonly totalFalsePositives: number;
  /** 每 clean MR 的 FP 数（case 内跨 rep 均值，再跨 case 均值 ± 标准差） */
  readonly falsePositivesPerCase: MetricsStats;
}

export interface NegativeControlReport {
  readonly caseCount: number;
  readonly perConfig: readonly NegativeControlConfigEntry[];
}

export interface VerifierConfigDelta {
  readonly configId: ConfigId;
  /** off 档（单遍自证）热口径均值 */
  readonly off: FlatMetrics | null;
  /** on 档（二遍复核）热口径均值 */
  readonly on: FlatMetrics | null;
  /** Verifier 追加 token（该 config 全部 rep 的 verifier usage 求和） */
  readonly verifierTokens: { readonly input: number; readonly output: number };
  /** 复核剔除的 Finding 总数 */
  readonly removedFindings: number;
}

export interface VerifierAblationReport {
  /** off 档指标报告（基线 Finding，同批运行） */
  readonly offTier: MetricsReport;
  /** on 档指标报告（复核后 Finding + 合并 usage；主口径） */
  readonly onTier: MetricsReport;
  readonly perConfig: readonly VerifierConfigDelta[];
}

export interface LedgerDedupConfigEntry {
  readonly configId: ConfigId;
  readonly toolCalls: number;
  /** Ledger 去重命中数（toolCallLog resultSummary 以 "Already loaded: ctx#" 开头） */
  readonly dedupCalls: number;
  readonly dedupRatio: number | null;
}

/** Cache Break 原因分类统计（spec US13；run 内相邻请求对的前缀分歧归因） */
export interface CacheBreakConfigEntry {
  readonly configId: ConfigId;
  /** 参与统计的运行记录数 */
  readonly runCount: number;
  /** Cache Break 总数（0 = 前缀纪律未被破坏） */
  readonly breakCount: number;
  /** 按原因分类计数（零值字段保留，列序恒定） */
  readonly byReason: Readonly<Record<CacheBreakReason, number>>;
}

export interface JudgeStageReport {
  readonly runCount: number;
  readonly judgedCount: number;
  readonly skippedCleanMrCount: number;
  readonly skippedNoFindingsCount: number;
  readonly errorCount: number;
  readonly perConfig: readonly {
    readonly configId: ConfigId;
    readonly runCount: number;
    readonly rule: MetricsStats;
    readonly judge: MetricsStats;
  }[];
  /** 全部判定结果（repIndex 已回填；人工抽检与外部复核的输入） */
  readonly results: readonly JudgeRunResult[];
}

export interface HumanReviewOutput {
  readonly seed: string;
  readonly rate: number;
  readonly totalUnits: number;
  readonly selectedUnits: readonly string[];
  readonly forms: readonly HumanReviewForm[];
}

export interface ExperimentReport {
  readonly experimentId: string;
  readonly plan: ExperimentPlan;
  readonly executed: number;
  readonly resumed: number;
  readonly failed: number;
  readonly failures: readonly RunFailure[];
  /** --report-only 重建时因损坏被跳过的记录文件（相对 runs 根；不静默丢弃的审计口径） */
  readonly corruptRecordFiles: readonly string[];
  /** 主集（truth ≠ null）case 数 */
  readonly caseCount: number;
  /** 阴性对照（clean MR）case 数 */
  readonly negativeControlCaseCount: number;
  readonly metrics: MetricsReport | null;
  readonly verdicts: VerdictReports | null;
  readonly negativeControl: NegativeControlReport | null;
  readonly verifierAblation: VerifierAblationReport | null;
  readonly dedup: readonly LedgerDedupConfigEntry[];
  /** Cache Break 原因分类统计（spec US13） */
  readonly cacheBreaks: readonly CacheBreakConfigEntry[];
  readonly judge: JudgeStageReport | null;
  readonly humanReview: HumanReviewOutput | null;
}

export interface ReportDeps {
  /** plan.judge = true 时必需（判定链 judge 阶段） */
  readonly judgeClient?: JudgeClient;
  readonly onJudgeUnit?: (event: { readonly unit: string; readonly status: string }) => void;
}

/** 装配完整实验报告（judge 阶段带断点续跑；人检表单按 plan 种子固定） */
export async function buildExperimentReport(
  outcome: {
    readonly plan: ExperimentPlan;
    readonly records: readonly RunRecord[];
    readonly cases: readonly MRCase[];
    readonly executed: number;
    readonly resumed: number;
    readonly failures: readonly RunFailure[];
    /** 重建路径下的损坏记录文件清单（在线运行路径无此字段） */
    readonly skippedCorruptFiles?: readonly string[];
  },
  deps: ReportDeps,
  paths: RunnerPaths,
): Promise<ExperimentReport> {
  const { plan } = outcome;
  const byCase = groupRecordsByCase(outcome.records);
  const mainCases = outcome.cases.filter((mrCase) => mrCase.truth !== null);
  const negativeCases = outcome.cases.filter((mrCase) => mrCase.truth === null);
  const mainEvaluations = buildEvaluations(mainCases, byCase, recordToRunResult);
  const negativeEvaluations = buildEvaluations(negativeCases, byCase, recordToRunResult);
  const metrics = mainEvaluations.length > 0 ? buildMetricsReport(mainEvaluations) : null;
  const verdicts = metrics !== null ? judgeAllVerdicts(metrics) : null;
  const negativeControl = buildNegativeControlReport(negativeCases, byCase);
  const verifierAblation =
    plan.verifier === "on" ? buildVerifierAblation(mainCases, byCase, outcome.records) : null;
  const dedup = buildLedgerDedupReport(outcome.records);
  const cacheBreaks = buildCacheBreakReport(outcome.records);
  const judge =
    plan.judge && deps.judgeClient !== undefined
      ? await runJudgeStage(outcome.cases, outcome.records, deps.judgeClient, deps, paths)
      : null;
  const judgeResults = judge?.results ?? [];
  const humanReviewEvaluations = [...mainEvaluations, ...negativeEvaluations];
  const humanReview =
    humanReviewEvaluations.length > 0
      ? buildHumanReviewOutput(humanReviewEvaluations, judgeResults, {
          seed: plan.humanReviewSeed,
          rate: plan.humanReviewRate,
        })
      : null;
  return {
    experimentId: plan.experimentId,
    plan,
    executed: outcome.executed,
    resumed: outcome.resumed,
    failed: outcome.failures.length,
    failures: outcome.failures,
    corruptRecordFiles: outcome.skippedCorruptFiles ?? [],
    caseCount: mainCases.length,
    negativeControlCaseCount: negativeCases.length,
    metrics,
    verdicts,
    negativeControl,
    verifierAblation,
    dedup,
    cacheBreaks,
    judge,
    humanReview,
  };
}

/** 记录 → (caseId → (configId → rep 升序记录)) 分组（分组/排序原语共享自 shared/report-io） */
function groupRecordsByCase(
  records: readonly RunRecord[],
): ReadonlyMap<string, ReadonlyMap<ConfigId, readonly RunRecord[]>> {
  const byCaseId = groupAndSortByRep(records, (record) => record.caseId);
  const byCase = new Map<string, ReadonlyMap<ConfigId, readonly RunRecord[]>>();
  for (const [caseId, caseRecords] of byCaseId) {
    byCase.set(caseId, groupAndSortByRep(caseRecords, (record) => record.configId));
  }
  return byCase;
}

/** case + 分组记录 → EvaluationInput[]（跳过无记录的 case；rep 顺序即重复运行顺序） */
function buildEvaluations(
  cases: readonly MRCase[],
  byCase: ReadonlyMap<string, ReadonlyMap<ConfigId, readonly RunRecord[]>>,
  toResult: (record: RunRecord) => RunResult,
): readonly EvaluationInput[] {
  const evaluations: EvaluationInput[] = [];
  for (const mrCase of cases) {
    const byConfig = byCase.get(mrCase.caseId);
    if (byConfig === undefined) {
      continue;
    }
    const runsByConfig: Partial<Record<ConfigId, readonly RunResult[]>> = {};
    for (const [configId, runs] of byConfig) {
      if (runs.length > 0) {
        runsByConfig[configId] = runs.map(toResult);
      }
    }
    if (Object.keys(runsByConfig).length > 0) {
      evaluations.push({ mrCase, runsByConfig });
    }
  }
  return evaluations;
}

/** 阴性对照报告：每 config 的 FP/case 统计（case 内跨 rep 均值 → 跨 case 均值 ± 标准差） */
function buildNegativeControlReport(
  cases: readonly MRCase[],
  byCase: ReadonlyMap<string, ReadonlyMap<ConfigId, readonly RunRecord[]>>,
): NegativeControlReport | null {
  if (cases.length === 0) {
    return null;
  }
  const perConfig: NegativeControlConfigEntry[] = [];
  for (const configId of CONFIG_IDS) {
    const perCase: number[][] = [];
    let totalFalsePositives = 0;
    for (const mrCase of cases) {
      const runs = byCase.get(mrCase.caseId)?.get(configId) ?? [];
      if (runs.length === 0) {
        continue;
      }
      const fpCounts = runs.map((record) => evaluateFpCount(record, mrCase));
      perCase.push(fpCounts);
      totalFalsePositives += fpCounts.reduce((sum, count) => sum + count, 0);
    }
    if (perCase.length === 0) {
      continue;
    }
    perConfig.push({
      configId,
      caseCount: perCase.length,
      totalFalsePositives,
      // 阴性对照统计口径：先 case 内跨 rep 均值，再跨 case 均值 ± 标准差（仅 lineFp 字段有效）
      falsePositivesPerCase: summarizeFlatMetrics(
        perCase.map((fpCounts) => ({ ...NULL_FLAT, lineFp: meanOf(fpCounts) })),
      ),
    });
  }
  return { caseCount: cases.length, perConfig };
}

/** 单次运行的 FP 计数（阴性对照口径：truth = null 时每条 Finding 计 1 FP，CLEAN_MR 归因） */
function evaluateFpCount(record: RunRecord, mrCase: MRCase): number {
  return evaluateRun(recordToRunResult(record), mrCase).lineCounts.fp;
}

const NULL_FLAT: FlatMetrics = {
  lineTp: 0,
  lineFp: 0,
  lineFn: 0,
  lineRecall: null,
  linePrecision: null,
  lineF1: null,
  fileTp: 0,
  fileFp: 0,
  fileFn: 0,
  fileRecall: null,
  filePrecision: null,
  fileF1: null,
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  totalInputTokens: 0,
  totalTokens: 0,
  cacheHitRate: null,
  rie: null,
  carc: 0,
  toolCostTokens: 0,
  toolCalls: 0,
  rounds: 0,
};

/** Verifier 消融对照：off 档（基线）vs on 档（复核后）成对指标 */
function buildVerifierAblation(
  cases: readonly MRCase[],
  byCase: ReadonlyMap<string, ReadonlyMap<ConfigId, readonly RunRecord[]>>,
  records: readonly RunRecord[],
): VerifierAblationReport | null {
  const offEvaluations = buildEvaluations(cases, byCase, recordToBaselineRunResult);
  const onEvaluations = buildEvaluations(cases, byCase, recordToRunResult);
  if (offEvaluations.length === 0 || onEvaluations.length === 0) {
    return null;
  }
  const offTier = buildMetricsReport(offEvaluations);
  const onTier = buildMetricsReport(onEvaluations);
  const perConfig: VerifierConfigDelta[] = [];
  for (const configId of CONFIG_IDS) {
    const onSummary = onTier.perConfig[configId];
    const offSummary = offTier.perConfig[configId];
    if (onSummary === undefined) {
      continue;
    }
    const configRecords = records.filter((record) => record.configId === configId);
    const verifierTokens = configRecords.reduce(
      (sum, record) => ({
        input: sum.input + (record.verifierPass?.usage.inputTokens ?? 0),
        output: sum.output + (record.verifierPass?.usage.outputTokens ?? 0),
      }),
      { input: 0, output: 0 },
    );
    const removedFindings = configRecords.reduce(
      (sum, record) => sum + (record.verifierPass?.removedFindingIds.length ?? 0),
      0,
    );
    perConfig.push({
      configId,
      off:
        offSummary !== undefined && offSummary.hot !== null ? meanFlatMetrics(offSummary.hot) : null,
      on: onSummary.hot !== null ? meanFlatMetrics(onSummary.hot) : null,
      verifierTokens,
      removedFindings,
    });
  }
  return { offTier, onTier, perConfig };
}

/** Ledger 去重收益：从审计 toolCallLog 直接统计（无需侵入工具层） */
function buildLedgerDedupReport(records: readonly RunRecord[]): readonly LedgerDedupConfigEntry[] {
  const perConfig: LedgerDedupConfigEntry[] = [];
  for (const configId of CONFIG_IDS) {
    const configRecords = records.filter((record) => record.configId === configId);
    if (configRecords.length === 0) {
      continue;
    }
    const toolCalls = configRecords.reduce((sum, record) => {
      const snapshot = record.effective ?? record.baseline;
      return sum + snapshot.audit.toolCallLog.length;
    }, 0);
    const dedupCalls = configRecords.reduce((sum, record) => {
      const snapshot = record.effective ?? record.baseline;
      return (
        sum +
        snapshot.audit.toolCallLog.filter((call) =>
          call.resultSummary.startsWith(LEDGER_DEDUP_PREFIX),
        ).length
      );
    }, 0);
    perConfig.push({
      configId,
      toolCalls,
      dedupCalls,
      dedupRatio: toolCalls > 0 ? dedupCalls / toolCalls : null,
    });
  }
  return perConfig;
}

/** Cache Break 原因分类统计（spec US13）：run 内相邻请求分歧归因，按 config 汇总 */
export function buildCacheBreakReport(records: readonly RunRecord[]): readonly CacheBreakConfigEntry[] {
  const perConfig: CacheBreakConfigEntry[] = [];
  for (const configId of CONFIG_IDS) {
    const configRecords = records.filter((record) => record.configId === configId);
    if (configRecords.length === 0) {
      continue;
    }
    const byReason = configRecords.reduce(
      (tally, record) => {
        const snapshot = record.effective ?? record.baseline;
        return mergeReasonTallies(tally, tallyCacheBreakReasons(snapshot.audit.cacheBreaks ?? []));
      },
      tallyCacheBreakReasons([]),
    );
    perConfig.push({
      configId,
      runCount: configRecords.length,
      breakCount: CACHE_BREAK_REASONS.reduce((sum, reason) => sum + byReason[reason], 0),
      byReason,
    });
  }
  return perConfig;
}

function mergeReasonTallies(
  a: Readonly<Record<CacheBreakReason, number>>,
  b: Readonly<Record<CacheBreakReason, number>>,
): Readonly<Record<CacheBreakReason, number>> {
  const merged = { ...a };
  for (const reason of CACHE_BREAK_REASONS) {
    merged[reason] = (merged[reason] ?? 0) + (b[reason] ?? 0);
  }
  return merged;
}

/** judge 判定链阶段（断点续跑：单元级落盘 judge/<source>/<caseId>/<configId>/rep-<rep>.json） */
async function runJudgeStage(
  cases: readonly MRCase[],
  records: readonly RunRecord[],
  judgeClient: JudgeClient,
  deps: ReportDeps,
  paths: RunnerPaths,
): Promise<JudgeStageReport> {
  const caseById = new Map(cases.map((mrCase) => [mrCase.caseId, mrCase]));
  const store = new JudgeStore(path.join(paths.experimentRoot, "judge"));
  const results: JudgeRunResult[] = [];
  for (const record of records) {
    const cached = await store.read(record);
    let result: JudgeRunResult;
    if (cached !== null) {
      result = cached;
    } else {
      const mrCase = caseById.get(record.caseId);
      if (mrCase === undefined) {
        continue; // 记录无对应 case（异址数据集）；不产生判定结果
      }
      const judged = await judgeRun(recordToRunResult(record), mrCase, judgeClient);
      result = { ...judged, repIndex: record.rep - 1 };
      await store.save(record, result);
    }
    deps.onJudgeUnit?.({ unit: runUnitKeyString(record), status: result.status });
    results.push(result);
  }
  return {
    runCount: results.length,
    judgedCount: results.filter((result) => result.status === "judged").length,
    skippedCleanMrCount: results.filter((result) => result.status === "skipped-clean-mr").length,
    skippedNoFindingsCount: results.filter((result) => result.status === "skipped-no-findings").length,
    errorCount: results.filter((result) => result.status === "error").length,
    perConfig: summarizeJudgePerConfig(results),
    results,
  };
}

function summarizeJudgePerConfig(
  results: readonly JudgeRunResult[],
): readonly {
  readonly configId: ConfigId;
  readonly runCount: number;
  readonly rule: MetricsStats;
  readonly judge: MetricsStats;
}[] {
  const perConfig: {
    readonly configId: ConfigId;
    readonly runCount: number;
    readonly rule: MetricsStats;
    readonly judge: MetricsStats;
  }[] = [];
  for (const configId of CONFIG_IDS) {
    const reps = results.filter((result) => result.configId === configId);
    if (reps.length === 0) {
      continue;
    }
    perConfig.push({
      configId,
      runCount: reps.length,
      rule: summarizeFlatMetrics(reps.map((rep) => flattenJudgeRun(rep, "rule"))),
      judge: summarizeFlatMetrics(reps.map((rep) => flattenJudgeRun(rep, "judge"))),
    });
  }
  return perConfig;
}

/** 人检表单输出（seed 固定并随表单落盘，可复现） */
function buildHumanReviewOutput(
  evaluations: readonly EvaluationInput[],
  judgeResults: readonly JudgeRunResult[],
  options: { readonly seed: string; readonly rate: number },
): HumanReviewOutput {
  const units = buildReviewUnits(evaluations, judgeResults);
  const plan = buildSamplingPlan(units, { seed: options.seed, rate: options.rate });
  const forms = buildHumanReviewForms(plan);
  return {
    seed: plan.seed,
    rate: options.rate,
    totalUnits: units.length,
    selectedUnits: plan.selected.map((unit) => unit.key),
    forms,
  };
}

/** 判别键：定位既有记录的运行单元（source / caseId / configId / rep） */
export interface JudgeUnitKey {
  readonly source: string;
  readonly caseId: string;
  readonly configId: string;
  readonly rep: number;
}

/** judge 结果存储（断点续跑；目录约定镜像 RunStore：<root>/<source>/<caseId>/<configId>/rep-<rep>.json） */
export class JudgeStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  pathOf(record: JudgeUnitKey): string {
    const safeCaseId = record.caseId.replace(/[^A-Za-z0-9_.-]/g, "_");
    return path.join(this.rootDir, record.source, safeCaseId, record.configId, `rep-${record.rep}.json`);
  }

  async read(record: JudgeUnitKey): Promise<JudgeRunResult | null> {
    try {
      const parsed = await readJsonFile(this.pathOf(record));
      return parsed !== null && isJudgeResultShape(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** 结果按运行单元落盘（result 内含 repIndex；单元键由 record 显式提供） */
  async save(record: JudgeUnitKey, result: JudgeRunResult): Promise<void> {
    await writeJsonFile(this.pathOf(record), result);
  }
}

function isJudgeResultShape(value: unknown): value is JudgeRunResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Partial<JudgeRunResult>;
  return (
    typeof record.caseId === "string" &&
    typeof record.configId === "string" &&
    typeof record.status === "string" &&
    Array.isArray(record.judgeVerdicts)
  );
}

/** 报告落盘：report.json（全量）+ human-review/forms.json */
export async function persistExperimentReport(
  experimentRoot: string,
  report: ExperimentReport,
): Promise<void> {
  await writeJsonFile(path.join(experimentRoot, "report.json"), report);
  if (report.humanReview !== null) {
    await writeJsonFile(path.join(experimentRoot, "human-review", "forms.json"), report.humanReview);
  }
}

/** 报告重建（--report-only）：从落盘 plan/cases/记录重建 outcome（judge/表单一并续跑） */
export async function rebuildExperimentOutcome(
  experimentRoot: string,
  loadPlan: () => Promise<ExperimentPlan>,
  loadCases: () => Promise<readonly MRCase[]>,
): Promise<{
  readonly plan: ExperimentPlan;
  readonly records: readonly RunRecord[];
  readonly cases: readonly MRCase[];
  readonly executed: number;
  readonly resumed: number;
  readonly failures: readonly RunFailure[];
  readonly skippedCorruptFiles: readonly string[];
}> {
  const plan = await loadPlan();
  const cases = await loadCases();
  const expanded = expandPlan(plan, cases);
  const store = new RunStore(path.join(experimentRoot, "runs"));
  const { records: all, skippedFiles } = await store.readAll();
  const plannedKeys = new Set(expanded.units.map(runUnitKeyString));
  const records = expanded.units.flatMap((unit) => {
    const record = all.find(
      (candidate) =>
        plannedKeys.has(runUnitKeyString(candidate)) &&
        runUnitKeyString(candidate) === runUnitKeyString(unit) &&
        candidate.model === plan.model &&
        candidate.verifier === plan.verifier,
    );
    return record === undefined ? [] : [record];
  });
  return {
    plan,
    records,
    cases: expanded.cases,
    executed: 0,
    resumed: records.length,
    failures: await readFailures(experimentRoot),
    skippedCorruptFiles: skippedFiles,
  };
}

async function readFailures(experimentRoot: string): Promise<readonly RunFailure[]> {
  return readJsonArrayFile<RunFailure>(path.join(experimentRoot, FAILURES_FILE));
}
