import type { ConfigId } from "../contracts/config.js";
import { CONFIGS } from "../contracts/config.js";
import type { FlatMetrics, MetricsField, Stat } from "../metrics/types.js";
import type { ExperimentReport } from "./report.js";

/**
 * Dashboard 汇总渲染（Ticket 12 / spec 用户故事 28）：ExperimentReport → Markdown。
 *
 * 四组核心指标（Review Quality / Context Efficiency / Agent Efficiency / Cache
 * Efficiency）+ 派生指标 RIE / CARC + S/A/B 自动判定（主锚 config C），
 * 外加 阴性对照 / Verifier 消融 / Ledger 去重 / judge 判定链 / 人工抽检 汇总。
 * 纯函数：给定报告产出确定性 Markdown（落盘为 dashboard.md，外部留痕）。
 */

const CONFIG_IDS: readonly ConfigId[] = Object.keys(CONFIGS) as ConfigId[];

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
const DASHBOARD_ROWS: readonly { readonly field: MetricsField; readonly group?: string }[] = [
  { field: "lineRecall", group: "Review Quality" },
  { field: "linePrecision" },
  { field: "lineF1" },
  { field: "totalInputTokens", group: "Context Efficiency" },
  { field: "totalTokens" },
  { field: "toolCostTokens" },
  { field: "toolCalls", group: "Agent Efficiency" },
  { field: "rounds" },
  { field: "cacheHitRate", group: "Cache Efficiency" },
  { field: "cachedInputTokens" },
  { field: "uncachedInputTokens" },
  { field: "rie", group: "Derived" },
  { field: "carc" },
];

/** 报告 → Markdown Dashboard（确定性输出；无指标的空段省略） */
export function renderDashboardMarkdown(report: ExperimentReport): string {
  const lines: string[] = [];
  lines.push(`# Experiment Dashboard: ${report.plan.experimentId}`);
  lines.push("");
  lines.push(
    `- model: \`${report.plan.model}\` / verifier: \`${report.plan.verifier}\` / reps: ${report.plan.reps} / configs: ${report.plan.configs.join(", ")}`,
  );
  lines.push(
    `- units: executed ${report.executed}, resumed ${report.resumed}, failed ${report.failed} / cases: ${report.caseCount} main + ${report.negativeControlCaseCount} clean-MR`,
  );
  lines.push("");
  appendVerdicts(lines, report);
  appendMetricsTable(lines, "Metrics — rep2+ hot (mean ± std, primary)", report, "hot");
  appendMetricsTable(lines, "Metrics — rep1 cold (mean ± std, separate)", report, "cold");
  appendNegativeControl(lines, report);
  appendVerifierAblation(lines, report);
  appendDedup(lines, report);
  appendJudge(lines, report);
  appendHumanReview(lines, report);
  appendFailures(lines, report);
  return `${lines.join("\n")}\n`;
}

function appendVerdicts(lines: string[], report: ExperimentReport): void {
  if (report.verdicts === null) {
    return;
  }
  lines.push("## S/A/B verdicts (anchor: config C)");
  lines.push("");
  lines.push(`anchor available: ${report.verdicts.anchorAvailable}`);
  lines.push("");
  lines.push("| Config | Outcome | Recall | Total tokens | Cache hit | Basis |");
  lines.push("|---|---|---|---|---|---|");
  for (const verdict of report.verdicts.verdicts) {
    lines.push(
      `| ${verdict.configId} | ${verdict.outcome} | ${fmtRatio(verdict.target.recall)} | ${fmtNumber(verdict.target.totalTokens)} | ${fmtRatio(verdict.target.cacheHitRate)} | ${verdict.basis} |`,
    );
  }
  lines.push("");
}

function appendMetricsTable(
  lines: string[],
  heading: string,
  report: ExperimentReport,
  tier: "hot" | "cold",
): void {
  if (report.metrics === null) {
    return;
  }
  const configs = CONFIG_IDS.filter((configId) => report.metrics?.perConfig[configId] !== undefined);
  if (configs.length === 0) {
    return;
  }
  const hasTier = configs.some((configId) => {
    const summary = report.metrics?.perConfig[configId];
    return summary !== undefined && summary[tier] !== null;
  });
  if (!hasTier) {
    return;
  }
  lines.push(`## ${heading}`);
  lines.push("");
  lines.push(`| Metric | ${configs.join(" | ")} |`);
  lines.push(`|---|${configs.map(() => "---").join("|")}|`);
  for (const row of DASHBOARD_ROWS) {
    if (row.group !== undefined) {
      lines.push(`| **${row.group}** | ${configs.map(() => "").join(" | ")} |`);
    }
    const cells = configs.map((configId) => {
      const summary = report.metrics?.perConfig[configId];
      const stats = summary === undefined ? null : summary[tier];
      return fmtStat(stats?.values[row.field] ?? null, row.field);
    });
    lines.push(`| ${row.field} | ${cells.join(" | ")} |`);
  }
  lines.push("");
}

function appendNegativeControl(lines: string[], report: ExperimentReport): void {
  if (report.negativeControl === null || report.negativeControl.perConfig.length === 0) {
    return;
  }
  lines.push("## Negative control (clean MR; every finding counts as 1 FP)");
  lines.push("");
  lines.push("| Config | Cases | Total FP | FP per case (mean ± std) |");
  lines.push("|---|---|---|---|");
  for (const entry of report.negativeControl.perConfig) {
    lines.push(
      `| ${entry.configId} | ${entry.caseCount} | ${entry.totalFalsePositives} | ${fmtStat(entry.falsePositivesPerCase.values.lineFp, "lineFp")} |`,
    );
  }
  lines.push("");
}

function appendVerifierAblation(lines: string[], report: ExperimentReport): void {
  const ablation = report.verifierAblation;
  if (ablation === null) {
    return;
  }
  lines.push("## Verifier ablation (off = single-pass baseline vs on = second pass, tokens counted in CARC)");
  lines.push("");
  lines.push("| Config | off lineFp | on lineFp | off totalTokens | on totalTokens | on CARC | verifier tokens (in/out) | removed findings |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const entry of ablation.perConfig) {
    lines.push(
      `| ${entry.configId} | ${fmtFlat(entry.off, "lineFp")} | ${fmtFlat(entry.on, "lineFp")} | ${fmtFlat(entry.off, "totalTokens")} | ${fmtFlat(entry.on, "totalTokens")} | ${fmtFlat(entry.on, "carc")} | ${entry.verifierTokens.input} / ${entry.verifierTokens.output} | ${entry.removedFindings} |`,
    );
  }
  lines.push("");
}

function appendDedup(lines: string[], report: ExperimentReport): void {
  if (report.dedup.length === 0) {
    return;
  }
  lines.push("## Context Ledger dedup");
  lines.push("");
  lines.push("| Config | Tool calls | Dedup calls | Dedup ratio |");
  lines.push("|---|---|---|---|");
  for (const entry of report.dedup) {
    lines.push(
      `| ${entry.configId} | ${entry.toolCalls} | ${entry.dedupCalls} | ${entry.dedupRatio === null ? "—" : `${round(entry.dedupRatio * 100, 1)}%`} |`,
    );
  }
  lines.push("");
}

function appendJudge(lines: string[], report: ExperimentReport): void {
  const judge = report.judge;
  if (judge === null) {
    return;
  }
  lines.push("## Judge chain (GPT heterogeneous; rule vs judge dual measure)");
  lines.push("");
  lines.push(
    `- runs: ${judge.runCount} (judged ${judge.judgedCount}, clean-MR ${judge.skippedCleanMrCount}, no-findings ${judge.skippedNoFindingsCount}, error ${judge.errorCount})`,
  );
  lines.push("");
  if (judge.perConfig.length > 0) {
    lines.push("| Config | Runs | Rule recall (mean ± std) | Judge recall (mean ± std) |");
    lines.push("|---|---|---|---|");
    for (const entry of judge.perConfig) {
      lines.push(
        `| ${entry.configId} | ${entry.runCount} | ${fmtStat(entry.rule.values.lineRecall, "lineRecall")} | ${fmtStat(entry.judge.values.lineRecall, "lineRecall")} |`,
      );
    }
    lines.push("");
  }
}

function appendHumanReview(lines: string[], report: ExperimentReport): void {
  const humanReview = report.humanReview;
  if (humanReview === null) {
    return;
  }
  lines.push("## Human review sampling (10%, seeded)");
  lines.push("");
  lines.push(
    `- seed: \`${humanReview.seed}\` / rate: ${round(humanReview.rate * 100, 1)}% / units: ${humanReview.totalUnits} / selected: ${humanReview.selectedUnits.length} / forms: ${humanReview.forms.length}`,
  );
  lines.push("");
}

function appendFailures(lines: string[], report: ExperimentReport): void {
  if (report.failures.length === 0) {
    return;
  }
  lines.push(`## Failures (${report.failures.length}; isolated, run continued)`);
  lines.push("");
  for (const failure of report.failures.slice(0, 20)) {
    lines.push(
      `- \`${failure.source}/${failure.caseId}/${failure.configId}/rep-${failure.rep}\`: ${failure.message}`,
    );
  }
  if (report.failures.length > 20) {
    lines.push(`- ... and ${report.failures.length - 20} more (see report.json)`);
  }
  lines.push("");
}

// ===== 数值格式化（确定性；null/undefined 统一 "—"） =====

function fmtStat(stat: Stat | null | undefined, field: MetricsField): string {
  if (stat === null || stat === undefined) {
    return "—";
  }
  return `${fmtByField(stat.mean, field)} ± ${fmtByField(stat.std, field)}`;
}

function fmtFlat(metrics: FlatMetrics | null, field: MetricsField): string {
  if (metrics === null) {
    return "—";
  }
  const value = metrics[field];
  return value === null ? "—" : fmtByField(value, field);
}

function fmtRatio(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "—";
  }
  return `${round(value * 100, 1)}%`;
}

function fmtNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "—";
  }
  return `${Math.round(value)}`;
}

function fmtByField(value: number, field: MetricsField): string {
  return RATIO_FIELDS.has(field) ? fmtRatio(value) : fmtNumber(value);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
