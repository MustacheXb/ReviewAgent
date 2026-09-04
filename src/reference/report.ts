import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { REFERENCE_CONFIG_ID } from "../contracts/config.js";
import type { MRCase } from "../contracts/mr-case.js";
import {
  buildMetricsReport,
  evaluateRun,
  summarizeFlatMetrics,
} from "../metrics/index.js";
import type {
  EvaluationInput,
  FlatMetrics,
  MetricsField,
  MetricsReport,
  MetricsStats,
} from "../metrics/types.js";
import {
  groupAndSortByRep,
  meanOf,
  readJsonArrayFile,
  writeJsonFile,
} from "../shared/report-io.js";
import type { ReferenceRejectionStage } from "./contracts.js";
import type { ClaudeCodeReferencePlan, ReferenceRunUnit } from "./plan.js";
import { expandReferencePlan } from "./plan.js";
import type { ReferenceFailure, ReferenceOutcome } from "./runner.js";
import { REFERENCE_FAILURES_FILE } from "./runner.js";
import type { ReferenceRunRecord } from "./run-store.js";
import { referenceRecordToRunResult, ReferenceRunStore } from "./run-store.js";

/**
 * 外部参照报告装配（Ticket 13 / issue #14）：记录 → 同一 metrics 管线（单列
 * REFERENCE_CONFIG_ID）→ 阴性对照单列 → 归一化留痕汇总 → 单列参照报告。
 *
 * 单列纪律（spec #1 user story 30）：
 * - verdicts 恒 null、excludedFromMainVerdict 恒 true——外部参照不进 S/A/B
 *   主判定（模型不可同源，锚 C 比较无意义）；报告与 Dashboard 双处显式标注；
 * - 指标经同一 evaluateRun / buildMetricsReport 纯函数计算（config 键 =
 *   "claude-code"），与 A–E 矩阵同一口径，可横向对照但永不混入主报告；
 * - clean MR（truth = null）不进主指标，按阴性对照口径单列（每条 Finding 计 1 FP）。
 */

/** 阴性对照单列（clean MR：全部 Finding 计 FP） */
export interface ReferenceNegativeControl {
  readonly caseCount: number;
  readonly totalFalsePositives: number;
  /** 每 clean MR 的 FP 数（case 内跨 rep 均值，再跨 case 均值 ± 标准差；仅 lineFp 有效） */
  readonly falsePositivesPerCase: MetricsStats;
}

/** 归一化留痕汇总（有界失败的量化面） */
export interface ReferenceNormalizationSummary {
  readonly runCount: number;
  readonly okRuns: number;
  readonly degradedRuns: number;
  readonly totalFindings: number;
  readonly rejectedFindings: number;
  readonly rejectionsByStage: Readonly<Record<ReferenceRejectionStage, number>>;
}

/** 运行环境留档汇总（可复现性） */
export interface ReferenceRuntimeSummary {
  readonly requestedModel: string;
  /** CLI 回报的实际模型 id 去重（与请求模型不符时以此为准解读） */
  readonly actualModels: readonly string[];
  /** 观察到的 claude CLI 版本去重 */
  readonly claudeVersions: readonly string[];
  /** 全部运行的 CLI 成本合计（美元；任一运行缺失回报则为 null） */
  readonly totalCostUsd: number | null;
  readonly permissionDeniedRuns: number;
}

export interface ClaudeCodeReferenceReport {
  /** 报告类别标记（与主实验 ExperimentReport 区分） */
  readonly kind: "claude-code-external-reference";
  readonly referenceId: string;
  readonly plan: ClaudeCodeReferencePlan;
  /** 明确标注：外部参照不进 S/A/B 主判定（spec #1 user story 30） */
  readonly excludedFromMainVerdict: true;
  /** 人读标注（Dashboard 与 report.json 双处留档） */
  readonly mainVerdictNote: string;
  /** 恒 null：S/A/B 判定仅对主实验 A–E 矩阵执行 */
  readonly verdicts: null;
  readonly executed: number;
  readonly resumed: number;
  readonly failed: number;
  readonly failures: readonly ReferenceFailure[];
  /** 主集（truth ≠ null）case 数 */
  readonly caseCount: number;
  /** 阴性对照（clean MR）case 数 */
  readonly negativeControlCaseCount: number;
  /** 同一 buildMetricsReport 管线（config 键 = "claude-code" 单列；A–E 恒缺省） */
  readonly metrics: MetricsReport | null;
  readonly negativeControl: ReferenceNegativeControl | null;
  readonly normalization: ReferenceNormalizationSummary;
  readonly runtime: ReferenceRuntimeSummary;
}

export const REFERENCE_MAIN_VERDICT_NOTE =
  "External cross-model reference only (Claude Code, model not same-source with the " +
  "deepseek-v4 harness): these numbers are reported in a separate single column and are " +
  "explicitly excluded from the S/A/B main verdict, whose anchor (config C) belongs to the " +
  "A-E main-matrix experiment.";

/** 装配单列外部参照报告（纯读 outcome，无 LLM 调用） */
export function buildClaudeCodeReferenceReport(
  outcome: Pick<
    ReferenceOutcome,
    "plan" | "records" | "cases" | "executed" | "resumed" | "failures"
  >,
): ClaudeCodeReferenceReport {
  const { plan } = outcome;
  const byCase = groupRecordsByCase(outcome.records);
  const mainCases = outcome.cases.filter((mrCase) => mrCase.truth !== null);
  const negativeCases = outcome.cases.filter((mrCase) => mrCase.truth === null);
  const metrics = buildReferenceMetrics(mainCases, byCase);
  const negativeControl = buildNegativeControl(negativeCases, byCase);
  return {
    kind: "claude-code-external-reference",
    referenceId: plan.referenceId,
    plan,
    excludedFromMainVerdict: true,
    mainVerdictNote: REFERENCE_MAIN_VERDICT_NOTE,
    verdicts: null,
    executed: outcome.executed,
    resumed: outcome.resumed,
    failed: outcome.failures.length,
    failures: outcome.failures,
    caseCount: mainCases.length,
    negativeControlCaseCount: negativeCases.length,
    metrics,
    negativeControl,
    normalization: summarizeNormalization(outcome.records),
    runtime: summarizeRuntime(plan, outcome.records),
  };
}

/** 主集评估：记录 → RunResult（REFERENCE_CONFIG_ID 单列）→ 同一 buildMetricsReport 管线 */
function buildReferenceMetrics(
  mainCases: readonly MRCase[],
  byCase: ReadonlyMap<string, readonly ReferenceRunRecord[]>,
): MetricsReport | null {
  const evaluations: EvaluationInput[] = [];
  for (const mrCase of mainCases) {
    const records = byCase.get(mrCase.caseId);
    if (records === undefined || records.length === 0) {
      continue;
    }
    evaluations.push({
      mrCase,
      runsByConfig: { [REFERENCE_CONFIG_ID]: records.map(referenceRecordToRunResult) },
    });
  }
  return evaluations.length > 0 ? buildMetricsReport(evaluations) : null;
}

/** 阴性对照：clean MR 每 Finding 计 1 FP（与主实验同口径，复用 evaluateRun） */
function buildNegativeControl(
  negativeCases: readonly MRCase[],
  byCase: ReadonlyMap<string, readonly ReferenceRunRecord[]>,
): ReferenceNegativeControl | null {
  if (negativeCases.length === 0) {
    return null;
  }
  const perCase: number[][] = [];
  let totalFalsePositives = 0;
  for (const mrCase of negativeCases) {
    const records = byCase.get(mrCase.caseId);
    if (records === undefined || records.length === 0) {
      continue;
    }
    const fpCounts = records.map((record) =>
      evaluateRun(referenceRecordToRunResult(record), mrCase).lineCounts.fp,
    );
    perCase.push(fpCounts);
    totalFalsePositives += fpCounts.reduce((sum, count) => sum + count, 0);
  }
  if (perCase.length === 0) {
    return null;
  }
  // 阴性对照统计口径（与主实验一致）：先 case 内跨 rep 均值，再跨 case 均值 ± 标准差
  const falsePositivesPerCase = summarizeFlatMetrics(
    perCase.map((fpCounts) => ({ ...FP_ONLY_FLAT, lineFp: meanOf(fpCounts) })),
  );
  return { caseCount: perCase.length, totalFalsePositives, falsePositivesPerCase };
}

const FP_ONLY_FLAT: FlatMetrics = {
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

function summarizeNormalization(
  records: readonly ReferenceRunRecord[],
): ReferenceNormalizationSummary {
  const stages: Record<ReferenceRejectionStage, number> = {
    CLI_OUTPUT_UNPARSABLE: 0,
    FINDINGS_FIELD_INVALID: 0,
    ENTRY_SCHEMA_INVALID: 0,
    DUPLICATE_ID: 0,
  };
  let totalFindings = 0;
  let rejectedFindings = 0;
  for (const record of records) {
    totalFindings += record.findings.length;
    rejectedFindings += record.rejections.length;
    for (const rejection of record.rejections) {
      stages[rejection.stage] += 1;
    }
  }
  return {
    runCount: records.length,
    okRuns: records.filter((record) => record.status === "ok").length,
    degradedRuns: records.filter((record) => record.status === "degraded").length,
    totalFindings,
    rejectedFindings,
    rejectionsByStage: stages,
  };
}

function summarizeRuntime(
  plan: ClaudeCodeReferencePlan,
  records: readonly ReferenceRunRecord[],
): ReferenceRuntimeSummary {
  const costs = records.map((record) => record.totalCostUsd);
  const totalCostUsd = costs.every((cost) => cost !== null)
    ? costs.reduce((sum, cost) => sum + (cost ?? 0), 0)
    : null;
  return {
    requestedModel: plan.model,
    actualModels: distinct(records.flatMap((record) => record.actualModels)),
    claudeVersions: distinct(records.map((record) => record.claudeVersion)),
    totalCostUsd,
    permissionDeniedRuns: records.filter((record) => record.permissionDenials > 0).length,
  };
}

/** 记录 → (caseId → rep 升序记录) 分组（分组/排序原语共享自 shared/report-io） */
function groupRecordsByCase(
  records: readonly ReferenceRunRecord[],
): ReadonlyMap<string, readonly ReferenceRunRecord[]> {
  return groupAndSortByRep(records, (record) => record.caseId);
}

function distinct(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

/** 报告落盘：reference-report.json（全量）+ reference-dashboard.md */
export async function persistReferenceReport(
  referenceRoot: string,
  report: ClaudeCodeReferenceReport,
): Promise<void> {
  await writeJsonFile(path.join(referenceRoot, "reference-report.json"), report);
  const markdown = renderReferenceDashboardMarkdown(report);
  await mkdir(path.dirname(path.join(referenceRoot, "reference-dashboard.md")), {
    recursive: true,
  });
  await writeFile(path.join(referenceRoot, "reference-dashboard.md"), markdown, "utf8");
}

/** 报告重建（--report-only）：从落盘 plan/cases/记录重建 outcome（不再调用 claude） */
export async function rebuildReferenceOutcome(
  referenceRoot: string,
  loadPlan: () => Promise<ClaudeCodeReferencePlan>,
  loadCases: () => Promise<readonly MRCase[]>,
): Promise<
  Pick<ReferenceOutcome, "plan" | "records" | "cases" | "executed" | "resumed" | "failures">
> {
  const plan = await loadPlan();
  const cases = await loadCases();
  const expanded = expandReferencePlan(plan, cases);
  const store = new ReferenceRunStore(referenceRoot);
  const all = await store.readAll();
  const plannedKeys = new Set(expanded.units.map(unitKeyOf));
  const records = expanded.units.flatMap((unit) => {
    const record = all.find(
      (candidate) =>
        plannedKeys.has(recordKeyOf(candidate)) &&
        recordKeyOf(candidate) === unitKeyOf(unit) &&
        candidate.requestedModel === plan.model &&
        candidate.maxTurns === plan.maxTurns &&
        candidate.promptTemplateVersion === plan.promptTemplateVersion,
    );
    return record === undefined ? [] : [record];
  });
  return {
    plan,
    records,
    cases: expanded.cases,
    executed: 0,
    resumed: records.length,
    failures: await readFailures(referenceRoot),
  };
}

async function readFailures(referenceRoot: string): Promise<readonly ReferenceFailure[]> {
  return readJsonArrayFile<ReferenceFailure>(path.join(referenceRoot, REFERENCE_FAILURES_FILE));
}

function unitKeyOf(unit: ReferenceRunUnit): string {
  return `${unit.source}/${unit.caseId}/rep-${unit.rep}`;
}

function recordKeyOf(record: ReferenceRunRecord): string {
  return `${record.source}/${record.caseId}/rep-${record.rep}`;
}

// ===== Dashboard 渲染（单列参照；风格对齐 experiment/dashboard.ts） =====

/** 比率型字段（渲染为百分比）；其余按数值渲染 */
const RATIO_FIELDS: ReadonlySet<MetricsField> = new Set([
  "lineRecall",
  "linePrecision",
  "lineF1",
  "fileRecall",
  "filePrecision",
  "fileF1",
  "cacheHitRate",
  "rie",
]);

/** 四组核心指标的展示行序（分组标题插入在组首字段前） */
const REFERENCE_DASHBOARD_ROWS: readonly {
  readonly field: MetricsField;
  readonly group?: string;
}[] = [
  { field: "lineRecall", group: "Review Quality" },
  { field: "linePrecision" },
  { field: "lineF1" },
  { field: "totalInputTokens", group: "Context Efficiency" },
  { field: "totalTokens" },
  { field: "toolCalls", group: "Agent Efficiency" },
  { field: "rounds" },
  { field: "cacheHitRate", group: "Cache Efficiency" },
  { field: "cachedInputTokens" },
  { field: "uncachedInputTokens" },
  { field: "rie", group: "Derived" },
  { field: "carc" },
];

/**
 * 单列外部参照 Dashboard（确定性 Markdown；无指标的空段省略）。
 * 显式标注：EXTERNAL REFERENCE——不进 S/A/B 主判定（spec #1 user story 30）。
 */
export function renderReferenceDashboardMarkdown(report: ClaudeCodeReferenceReport): string {
  const lines: string[] = [];
  lines.push(`# Claude Code External Reference: ${report.referenceId}`);
  lines.push("");
  lines.push(
    "> **EXTERNAL REFERENCE — NOT part of the S/A/B main verdict.** " +
      `${report.mainVerdictNote}`,
  );
  lines.push("");
  lines.push(
    `- model: \`${report.plan.model}\` / maxTurns: ${report.plan.maxTurns} / prompt template: \`${report.plan.promptTemplateVersion}\` / reps: ${report.plan.reps} / sources: ${report.plan.sources.join(", ")}`,
  );
  lines.push(
    `- units: executed ${report.executed}, resumed ${report.resumed}, failed ${report.failed} / cases: ${report.caseCount} main + ${report.negativeControlCaseCount} clean-MR`,
  );
  lines.push("");
  appendReferenceMetricsTable(lines, "Metrics — rep2+ hot (mean ± std, primary)", report, "hot");
  appendReferenceMetricsTable(lines, "Metrics — rep1 cold (mean ± std, separate)", report, "cold");
  appendReferenceNegativeControl(lines, report);
  appendReferenceNormalization(lines, report);
  appendReferenceRuntime(lines, report);
  appendReferenceFailures(lines, report);
  return `${lines.join("\n")}\n`;
}

function appendReferenceMetricsTable(
  lines: string[],
  heading: string,
  report: ClaudeCodeReferenceReport,
  tier: "hot" | "cold",
): void {
  const summary = report.metrics?.perConfig[REFERENCE_CONFIG_ID];
  const stats = summary === undefined ? null : summary[tier];
  if (stats === null || stats === undefined) {
    return;
  }
  lines.push(`## ${heading} — column \`${REFERENCE_CONFIG_ID}\` (external reference)`);
  lines.push("");
  lines.push("| Metric | claude-code |");
  lines.push("|---|---|");
  for (const row of REFERENCE_DASHBOARD_ROWS) {
    if (row.group !== undefined) {
      lines.push(`| **${row.group}** |  |`);
    }
    lines.push(`| ${row.field} | ${fmtStatByField(stats.values[row.field], row.field)} |`);
  }
  lines.push("");
}

function appendReferenceNegativeControl(
  lines: string[],
  report: ClaudeCodeReferenceReport,
): void {
  const control = report.negativeControl;
  if (control === null) {
    return;
  }
  lines.push("## Negative control (clean MR; every finding counts as 1 FP)");
  lines.push("");
  lines.push("| Column | Cases | Total FP | FP per case (mean ± std) |");
  lines.push("|---|---|---|---|");
  lines.push(
    `| ${REFERENCE_CONFIG_ID} | ${control.caseCount} | ${control.totalFalsePositives} | ${fmtStatByField(control.falsePositivesPerCase.values.lineFp, "lineFp")} |`,
  );
  lines.push("");
}

function appendReferenceNormalization(
  lines: string[],
  report: ClaudeCodeReferenceReport,
): void {
  const n = report.normalization;
  if (n.runCount === 0) {
    return;
  }
  lines.push("## Normalization audit (bounded failure; invalid entries rejected, run kept)");
  lines.push("");
  lines.push(
    `- runs: ${n.runCount} (ok ${n.okRuns}, degraded ${n.degradedRuns}) / findings: ${n.totalFindings} accepted, ${n.rejectedFindings} rejected`,
  );
  const stageEntries = Object.entries(n.rejectionsByStage).filter(([, count]) => count > 0);
  if (stageEntries.length > 0) {
    lines.push(
      `- rejections by stage: ${stageEntries.map(([stage, count]) => `${stage}=${count}`).join(", ")}`,
    );
  }
  lines.push("");
}

function appendReferenceRuntime(lines: string[], report: ClaudeCodeReferenceReport): void {
  const r = report.runtime;
  if (report.normalization.runCount === 0) {
    return;
  }
  lines.push("## Runtime provenance (reproducibility)");
  lines.push("");
  lines.push(`- requested model: \`${r.requestedModel}\``);
  lines.push(
    `- actual model(s) reported by CLI: ${r.actualModels.length > 0 ? r.actualModels.map((m) => `\`${m}\``).join(", ") : "—"}`,
  );
  lines.push(
    `- claude CLI version(s): ${r.claudeVersions.length > 0 ? r.claudeVersions.map((v) => `\`${v}\``).join(", ") : "—"}`,
  );
  lines.push(`- total CLI cost: ${r.totalCostUsd === null ? "—" : `$${r.totalCostUsd.toFixed(2)}`}`);
  lines.push(`- runs with permission denials: ${r.permissionDeniedRuns}`);
  lines.push("");
}

function appendReferenceFailures(lines: string[], report: ClaudeCodeReferenceReport): void {
  if (report.failures.length === 0) {
    return;
  }
  lines.push(`## Failures (${report.failures.length}; isolated, run continued)`);
  lines.push("");
  for (const failure of report.failures.slice(0, 20)) {
    lines.push(
      `- \`${failure.source}/${failure.caseId}/rep-${failure.rep}\`: ${failure.message}`,
    );
  }
  if (report.failures.length > 20) {
    lines.push(`- ... and ${report.failures.length - 20} more (see reference-report.json)`);
  }
  lines.push("");
}

// ===== 数值格式化（确定性；null/undefined 统一 "—"） =====

function fmtStatByField(
  stat: { readonly mean: number; readonly std: number } | null | undefined,
  field: MetricsField,
): string {
  if (stat === null || stat === undefined) {
    return "—";
  }
  return `${fmtByField(stat.mean, field)} ± ${fmtByField(stat.std, field)}`;
}

function fmtByField(value: number, field: MetricsField): string {
  return RATIO_FIELDS.has(field)
    ? `${round(value * 100, 1)}%`
    : `${Math.round(value)}`;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
