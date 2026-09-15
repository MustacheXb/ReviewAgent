/**
 * Phase 2 主数据分析报告复算脚本（#38）。
 *
 * 用途：从 runs/ 留痕与 gate JSON 锚点重放 docs/report/《Phase 2 主数据分析报告》全部数字表，
 * 保证「无手抽数字」。纯离线读取聚合，零网关消耗，零新指标定义（全部为既有口径的均值/计数/求和）。
 *
 * 类型契约：引用 src/ 既有契约（contracts/config、metrics/types、judge/orchestrate、
 * experiment/report），本地仅声明展示顺序（CONFIG_IDS——契约 CONFIGS 为无序键控表）。
 *
 * 运行：
 *   pnpm analyze:phase2
 * 输出：markdown 表格（stdout），与报告表格逐项对应。
 * 退出码：0 成功；2 加载错误。
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ConfigId } from "../src/contracts/config.js";
import type { MetricsField, VerdictReports } from "../src/metrics/types.js";
import type { JudgeRunResult } from "../src/judge/orchestrate.js";
import type { ExperimentReport, HumanReviewOutput, JudgeStageReport } from "../src/experiment/report.js";

/** 三侧实验目录（主数据 / 噪声对照 / DSH 附录侧） */
const SIDES = ["phase2-main", "phase2-noise", "phase2-dsh"] as const;
type Side = (typeof SIDES)[number];
const SIDE_LABEL: Record<Side, string> = {
  "phase2-main": "main",
  "phase2-noise": "noise",
  "phase2-dsh": "dsh",
};
/** 展示顺序（本地呈现约定；契约 CONFIGS 为无序键控表） */
const CONFIG_IDS: readonly ConfigId[] = ["A", "B", "C", "D", "E"];

/** 判定链 σ 面（与 #36 误差棒同口径）的指标集（rule 口径） */
const SIGMA_METRICS = ["lineRecall", "linePrecision", "totalTokens", "cacheHitRate"] as const;
type SigmaMetric = (typeof SIGMA_METRICS)[number];

/** 预算估算窗（#32 spec 立项口径，矩阵级——noise/dsh 为同矩阵重跑沿用同窗；来源为票面记录，非本脚本推导） */
const ESTIMATE_WINDOW = { billedLo: 19e6, billedHi: 27e6, withCacheLo: 84e6, withCacheHi: 113e6 };

/** judge completion 信封上界（#39：glm 系推理模型 32768/调用；调用 usage 不落盘） */
const JUDGE_ENVELOPE_TOKENS = 32768;

type JudgePerConfig = JudgeStageReport["perConfig"][number];

// ── 基础工具 ────────────────────────────────────────────────────────────
function fmt(value: number | null | undefined, digits = 4): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return String(Number(value.toFixed(digits)));
}
function fmtTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(Math.round(value));
}
function statOf(entries: readonly JudgePerConfig[], configId: ConfigId): JudgePerConfig | undefined {
  return entries.find((entry) => entry.configId === configId);
}
function statMean(entry: JudgePerConfig, side: "rule" | "judge", metric: MetricsField): number | null {
  const stat = entry[side].values[metric];
  return stat === null || stat === undefined ? null : stat.mean;
}
function ruleMean(entry: JudgePerConfig, metric: MetricsField): number | null {
  return statMean(entry, "rule", metric);
}
function judgeMean(entry: JudgePerConfig, metric: MetricsField): number | null {
  return statMean(entry, "judge", metric);
}

async function readJson(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    throw new Error(`cannot read ${path}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`cannot parse ${path}: ${(error as Error).message}`);
  }
}
async function readReport(runsRoot: string, side: Side): Promise<ExperimentReport> {
  return (await readJson(join(runsRoot, side, "report.json"))) as ExperimentReport;
}
/** 判定面就绪性：verdicts/judge 阶段缺失即失败（报告要求三侧全量可复算，不静默降级） */
function stageOf(report: ExperimentReport, side: Side): { verdicts: VerdictReports; judge: JudgeStageReport } {
  if (report.verdicts === null) throw new Error(`report of ${side} missing verdicts stage`);
  if (report.judge === null) throw new Error(`report of ${side} missing judge stage`);
  return { verdicts: report.verdicts, judge: report.judge };
}

// ── 执行 record 收集（预算/时点面数据源；缺失即报错——报告要求 450/450 可复算）──
interface ExecRecord {
  readonly completedAt: string;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly outputTokens: number;
}
async function collectExecRecords(
  runsRoot: string,
  experimentId: string,
  reps: readonly number[] = [1, 2, 3],
): Promise<ReadonlyArray<ExecRecord>> {
  const records: ExecRecord[] = [];
  const casesRoot = join(runsRoot, experimentId, "runs", "vul4j");
  let caseDirs: string[];
  try {
    caseDirs = await readdir(casesRoot);
  } catch {
    throw new Error(`cannot list ${casesRoot}`);
  }
  for (const caseId of caseDirs) {
    for (const configId of CONFIG_IDS) {
      for (const rep of reps) {
        const path = join(casesRoot, caseId, configId, `rep-${rep}.json`);
        let parsed: {
          readonly completedAt?: string;
          readonly baseline?: { readonly usage?: { readonly inputTokens?: number; readonly cacheReadTokens?: number; readonly outputTokens?: number } };
        };
        try {
          parsed = (await readJson(path)) as typeof parsed;
        } catch {
          throw new Error(`missing unit record ${path} (report requires 450/450 records)`);
        }
        const usage = parsed.baseline?.usage;
        if (parsed.completedAt === undefined || usage === undefined) {
          throw new Error(`malformed unit record ${path}`);
        }
        records.push({
          completedAt: parsed.completedAt,
          inputTokens: usage.inputTokens ?? 0,
          cacheReadTokens: usage.cacheReadTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
        });
      }
    }
  }
  return records;
}
type TokenCaliber = "billed" | "withCache";
function sumTokens(records: ReadonlyArray<ExecRecord>, caliber: TokenCaliber): number {
  return records.reduce(
    (acc, r) => acc + r.inputTokens + r.outputTokens + (caliber === "withCache" ? r.cacheReadTokens : 0),
    0,
  );
}

// ── 跨 rep σ（#36 误差棒口径）：按 (caseId, configId) 分组 3-rep 样本 σ，None 剔除，≥2 有效 rep 才计，对 30 案取均值 ──
const SIGMA_EXTRACTORS: Record<SigmaMetric, (row: JudgeRunResult) => number | null> = {
  lineRecall: (row) => row.rulePrf?.recall ?? null,
  linePrecision: (row) => row.rulePrf?.precision ?? null,
  totalTokens: (row) => row.tokens?.totalTokens ?? null,
  cacheHitRate: (row) => row.tokens?.cacheHitRate ?? null,
};
function repSigma(results: ReadonlyArray<JudgeRunResult>): Map<string, number> {
  const perCell = new Map<string, Record<SigmaMetric, number[]>>();
  for (const row of results) {
    const key = `${row.caseId}|${row.configId}`;
    let cell = perCell.get(key);
    if (cell === undefined) {
      cell = { lineRecall: [], linePrecision: [], totalTokens: [], cacheHitRate: [] };
      perCell.set(key, cell);
    }
    for (const metric of SIGMA_METRICS) {
      const value = SIGMA_EXTRACTORS[metric](row);
      if (value !== null) cell[metric].push(value);
    }
  }
  const out = new Map<string, number>();
  for (const configId of CONFIG_IDS) {
    const cellSigmas = new Map<SigmaMetric, number[]>(SIGMA_METRICS.map((m) => [m, [] as number[]]));
    for (const [key, cell] of perCell) {
      if (!key.endsWith(`|${configId}`)) continue;
      for (const metric of SIGMA_METRICS) {
        if (cell[metric].length >= 2) cellSigmas.get(metric)?.push(sampleStd(cell[metric]));
      }
    }
    for (const metric of SIGMA_METRICS) {
      const sigmas = cellSigmas.get(metric) ?? [];
      out.set(`${configId}/${metric}`, sigmas.length === 0 ? Number.NaN : sigmas.reduce((a, b) => a + b, 0) / sigmas.length);
    }
  }
  return out;
}
function sampleStd(values: ReadonlyArray<number>): number {
  const n = values.length;
  if (n < 2) return Number.NaN;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / (n - 1);
  return Math.sqrt(variance);
}

// ── T1 判定分布：三侧 S/A/B ─────────────────────────────────────────────
function faceVerdicts(verdictsBySide: ReadonlyMap<Side, VerdictReports>): string[] {
  const out: string[] = [];
  const emit = (line = "") => out.push(line);
  emit("## T1 判定分布（S/A/B，锚 = C rep2+ 热口径；三侧并列）");
  emit();
  emit("| config | main | noise | dsh |");
  emit("|---|---|---|---|");
  for (const configId of CONFIG_IDS) {
    emit(
      `| ${configId} | ${verdictsBySide.get("phase2-main")?.verdicts.find((v) => v.configId === configId)?.outcome ?? "—"} | ${verdictsBySide.get("phase2-noise")?.verdicts.find((v) => v.configId === configId)?.outcome ?? "—"} | ${verdictsBySide.get("phase2-dsh")?.verdicts.find((v) => v.configId === configId)?.outcome ?? "—"} |`,
    );
  }
  const mainVerdicts = verdictsBySide.get("phase2-main");
  const outcomesOf = (map: VerdictReports | undefined): string =>
    JSON.stringify(CONFIG_IDS.map((c) => map?.verdicts.find((v) => v.configId === c)?.outcome));
  emit();
  emit(
    `锚可用性：main anchor=${mainVerdicts?.anchorConfigId ?? "—"} available=${mainVerdicts?.anchorAvailable ?? "—"}；三侧 outcome 逐字一致 = ${[...verdictsBySide.values()].every((m) => outcomesOf(m) === outcomesOf(mainVerdicts))}`,
  );
  emit();
  return out;
}

// ── T1b：B 配置判据明细（main）──────────────────────────────────────────
function faceCriteria(mainVerdicts: VerdictReports | undefined): string[] {
  const bVerdict = mainVerdicts?.verdicts.find((v) => v.configId === "B");
  if (bVerdict === undefined) return [];
  const out: string[] = [];
  const emit = (line = "") => out.push(line);
  emit("### T1b main 侧 B 配置判据明细（S 级四判据 + 全档位）");
  emit();
  emit("| grade | metric | value | threshold | pass |");
  emit("|---|---|---|---|---|");
  for (const c of bVerdict.criteria) {
    const isToken = c.metric === "TOTAL_TOKENS";
    emit(
      `| ${c.grade} | ${c.metric} | ${isToken ? fmtTokens(c.value) : fmt(c.value)} | ${c.threshold === null ? "—" : isToken ? fmtTokens(c.threshold) : fmt(c.threshold)} | ${c.pass ? "✅" : "❌"} |`,
    );
  }
  emit();
  return out;
}

// ── T2 判定链：rule vs judge（main）─────────────────────────────────────
function faceChain(judge: JudgeStageReport): string[] {
  const out: string[] = [];
  const emit = (line = "") => out.push(line);
  emit(`## T2 判定链（main 侧每配置 ${judge.results.length / CONFIG_IDS.length} 单元均值：rule 粗筛 vs judge 链）`);
  emit();
  emit("| config | rule Recall | judge Recall | rule Prec | judge Prec | rule F1 | judge F1 | disagreement 单元 | matchConf (H/M/L) |");
  emit("|---|---|---|---|---|---|---|---|---|");
  const skippedByConfig = new Map<ConfigId, number>();
  const unitCountByConfig = new Map<ConfigId, number>();
  for (const configId of CONFIG_IDS) {
    const entry = statOf(judge.perConfig, configId);
    if (entry === undefined) continue;
    const rows = judge.results.filter((r) => r.configId === configId);
    unitCountByConfig.set(configId, rows.length);
    const disUnits = rows.filter((r) => (r.disagreements?.length ?? 0) > 0).length;
    const conf = { high: 0, medium: 0, low: 0, other: 0 };
    for (const row of rows) {
      for (const v of row.judgeVerdicts ?? []) {
        if (v.outcome !== "TP") continue;
        if (v.matchConfidence === "high") conf.high += 1;
        else if (v.matchConfidence === "medium") conf.medium += 1;
        else if (v.matchConfidence === "low") conf.low += 1;
        else conf.other += 1;
      }
    }
    skippedByConfig.set(configId, rows.filter((r) => r.status === "skipped-no-findings").length);
    emit(
      `| ${configId} | ${fmt(ruleMean(entry, "lineRecall"))} | ${fmt(judgeMean(entry, "lineRecall"))} | ${fmt(ruleMean(entry, "linePrecision"))} | ${fmt(judgeMean(entry, "linePrecision"))} | ${fmt(ruleMean(entry, "lineF1"))} | ${fmt(judgeMean(entry, "lineF1"))} | ${disUnits}/${rows.length} | ${conf.high}/${conf.medium}/${conf.low}${conf.other > 0 ? ` (+${conf.other})` : ""} |`,
    );
  }
  const kindCounts = new Map<string, number>();
  for (const row of judge.results) {
    for (const d of row.disagreements ?? []) kindCounts.set(d.kind, (kindCounts.get(d.kind) ?? 0) + 1);
  }
  emit();
  emit(
    `skipped-no-findings（0 finding 单元，judge 零调用）：${[...skippedByConfig].map(([c, n]) => `${c}=${n}/${unitCountByConfig.get(c) ?? "—"}`).join(" / ")}`,
  );
  emit(`disagreement 种类合计：${[...kindCounts.entries()].map(([k, n]) => `${k}=${n}`).join(" / ") || "0"}`);
  emit();
  return out;
}

// ── T3 五配置对比（main）───────────────────────────────────────────────
function faceComparison(judges: ReadonlyMap<Side, JudgeStageReport>): string[] {
  const mainJudge = judges.get("phase2-main");
  if (mainJudge === undefined) return [];
  const out: string[] = [];
  const emit = (line = "") => out.push(line);
  emit(`## T3 五配置对比（main 侧 judge 口径每配置 ${mainJudge.results.length / CONFIG_IDS.length} 单元均值）`);
  emit();
  emit("| config | lineRecall | linePrecision | lineF1 | totalTokens | cacheHitRate | RIE | CaRC | toolCalls | rounds |");
  emit("|---|---|---|---|---|---|---|---|---|---|");
  for (const configId of CONFIG_IDS) {
    const entry = statOf(mainJudge.perConfig, configId);
    if (entry === undefined) continue;
    emit(
      `| ${configId} | ${fmt(judgeMean(entry, "lineRecall"))} | ${fmt(judgeMean(entry, "linePrecision"))} | ${fmt(judgeMean(entry, "lineF1"))} | ${fmtTokens(judgeMean(entry, "totalTokens"))} | ${fmt(judgeMean(entry, "cacheHitRate"))} | ${fmt(judgeMean(entry, "rie"))} | ${fmtTokens(judgeMean(entry, "carc"))} | ${fmt(judgeMean(entry, "toolCalls"), 1)} | ${fmt(judgeMean(entry, "rounds"), 2)} |`,
    );
  }
  emit();
  return out;
}

// ── T3b：D 不稳定三侧对照（#30 归因面）──────────────────────────────────
function faceInstability(judges: ReadonlyMap<Side, JudgeStageReport>): string[] {
  const out: string[] = [];
  const emit = (line = "") => out.push(line);
  emit("### T3b D 配置不稳定三侧对照（judge lineRecall / totalTokens 均值）");
  emit();
  emit("| config | main R / T | noise R / T | dsh R / T | R 三侧极差 |");
  emit("|---|---|---|---|---|");
  for (const configId of CONFIG_IDS) {
    const cells: string[] = [];
    const recalls: number[] = [];
    for (const side of SIDES) {
      const entry = statOf(judges.get(side)?.perConfig ?? [], configId);
      const r = entry === undefined ? null : judgeMean(entry, "lineRecall");
      const t = entry === undefined ? null : judgeMean(entry, "totalTokens");
      if (r !== null) recalls.push(r);
      cells.push(`${fmt(r)} / ${fmtTokens(t)}`);
    }
    const spread = recalls.length === 3 ? fmt(Math.max(...recalls) - Math.min(...recalls)) : "—";
    emit(`| ${configId} | ${cells[0]} | ${cells[1]} | ${cells[2]} | ${spread} |`);
  }
  emit();
  return out;
}

// ── T4 方差面：跨 rep σ（#36 口径重放）────────────────────────────────
function faceSigma(judges: ReadonlyMap<Side, JudgeStageReport>): string[] {
  const mainJudge = judges.get("phase2-main");
  const noiseJudge = judges.get("phase2-noise");
  if (mainJudge === undefined) return [];
  const sigmaMain = repSigma(mainJudge.results);
  const sigmaNoise = noiseJudge === undefined ? null : repSigma(noiseJudge.results);
  const out: string[] = [];
  const emit = (line = "") => out.push(line);
  emit("## T4 方差面（跨 rep σ，单元内 3-rep 样本 σ 对 30 案均值；#36 口径重放）");
  emit();
  emit("| config/metric | main σ | noise σ |");
  emit("|---|---|---|");
  const fmtSigma = (value: number | undefined): string =>
    value === undefined || Number.isNaN(value) ? "—" : value >= 1e3 ? fmtTokens(value) : fmt(value);
  for (const configId of CONFIG_IDS) {
    for (const metric of SIGMA_METRICS) {
      const key = `${configId}/${metric}`;
      emit(`| ${key} | ${fmtSigma(sigmaMain.get(key))} | ${fmtSigma(sigmaNoise?.get(key))} |`);
    }
  }
  emit();
  return out;
}

// ── T5 预算总账（三侧 EXEC + 冒烟 + judge 信封）─────────────────────────
async function faceBudget(runsRoot: string, reports: ReadonlyMap<Side, ExperimentReport>): Promise<string[]> {
  const out: string[] = [];
  const emit = (line = "") => out.push(line);
  emit("## T5 预算总账（EXEC 双口径 + judge 信封上界）");
  emit();
  emit("| 侧 | 单元 | 计费口径 | 含缓存读口径 | judge 调用 | judge 信封上界 |");
  emit("|---|---|---|---|---|---|");
  const totals: { side: string; billed: number; withCache: number }[] = [];
  let execUnits = 0;
  for (const side of SIDES) {
    const records = await collectExecRecords(runsRoot, side);
    execUnits += records.length;
    const judgedCount = reports.get(side)?.judge?.results.filter((r) => r.status === "judged").length ?? 0;
    const billed = sumTokens(records, "billed");
    const withCache = sumTokens(records, "withCache");
    totals.push({ side: SIDE_LABEL[side], billed, withCache });
    emit(`| ${SIDE_LABEL[side]} | ${records.length} | ${fmtTokens(billed)} | ${fmtTokens(withCache)} | ${judgedCount} | ≤${fmtTokens(judgedCount * JUDGE_ENVELOPE_TOKENS)} |`);
  }
  // 冒烟（#32 释能冒烟，1 案 × 5 配置 × 1 rep；目录缺失则如实注记跳过）
  try {
    const smokeRecords = await collectExecRecords(runsRoot, "phase2-smoke", [1]);
    const billed = sumTokens(smokeRecords, "billed");
    const withCache = sumTokens(smokeRecords, "withCache");
    emit(`| smoke | ${smokeRecords.length} | ${fmtTokens(billed)} | ${fmtTokens(withCache)} | — | — |`);
    totals.push({ side: "smoke", billed, withCache });
  } catch (error) {
    emit(`| smoke | （目录缺失，跳过：${(error as Error).message}） | — | — | — | — |`);
  }
  const execTotals = totals.filter((t) => t.side !== "smoke");
  const execBilled = execTotals.reduce((acc, t) => acc + t.billed, 0);
  const execWithCache = execTotals.reduce((acc, t) => acc + t.withCache, 0);
  emit(`| **三侧 EXEC 合计** | ${execUnits} | **${fmtTokens(execBilled)}** | **${fmtTokens(execWithCache)}** | | |`);
  emit();
  emit(
    `主数据估算窗（#32 立项，19–27M / 84–113M）：main ${estimateWindowVerdict(totals.find((t) => t.side === "main"), "billed")} / ${estimateWindowVerdict(totals.find((t) => t.side === "main"), "withCache")}`,
  );
  emit();
  return out;
}

// ── T6 时点面 ──────────────────────────────────────────────────────────
async function faceTemporal(runsRoot: string): Promise<string[]> {
  const out: string[] = [];
  const emit = (line = "") => out.push(line);
  emit("## T6 时点面（EXEC 执行窗，UTC）");
  emit();
  emit("| 侧 | 首 record | 末 record | 时长 |");
  emit("|---|---|---|---|");
  const windows = new Map<string, { first: string; last: string }>();
  for (const side of SIDES) {
    const records = await collectExecRecords(runsRoot, side);
    const times = records.map((r) => r.completedAt).sort();
    const first = times[0];
    const last = times[times.length - 1];
    if (first === undefined || last === undefined) throw new Error(`no completedAt records under ${side}`);
    windows.set(SIDE_LABEL[side], { first, last });
    emit(`| ${SIDE_LABEL[side]} | ${first} | ${last} | ${durationHours(first, last)}h |`);
  }
  emit();
  emit(
    `窗间隔：main→noise = ${gapHours(windows.get("main")?.last, windows.get("noise")?.first)}h；main→dsh = ${gapHours(windows.get("main")?.last, windows.get("dsh")?.first)}h；noise→dsh = ${gapHours(windows.get("noise")?.last, windows.get("dsh")?.first)}h`,
  );
  emit();
  return out;
}

// ── T8 人工抽检面 ──────────────────────────────────────────────────────
async function faceHumanReview(runsRoot: string, judge: JudgeStageReport): Promise<string[]> {
  const out: string[] = [];
  const emit = (line = "") => out.push(line);
  emit("## T8 人工抽检（calibration 样本构成）");
  emit();
  try {
    const forms = (await readJson(join(runsRoot, "phase2-main", "human-review", "forms.json"))) as HumanReviewOutput;
    // 分层口径 = 协议 stratumOf（src/sampling/review-plan.ts）：无 judge 行 → no-judge；
    // 有 judge 行（含 skipped-no-findings，零分歧）按 disagreements 分 disagreement/agreement 层
    const stratumOf = (form: HumanReviewOutput["forms"][number]): "disagreement" | "agreement" | "no-judge" => {
      const row = judge.results.find(
        (r) => r.caseId === form.caseId && r.configId === form.configId && r.repIndex === form.repIndex,
      );
      if (row === undefined) return "no-judge";
      return row.disagreements.length > 0 ? "disagreement" : "agreement";
    };
    const counts = { disagreement: 0, agreement: 0, "no-judge": 0 };
    for (const form of forms.forms) counts[stratumOf(form)] += 1;
    const items = forms.forms.reduce((acc, f) => acc + f.items.length, 0);
    const findingItems = forms.forms.reduce((acc, f) => acc + f.items.filter((i) => i.kind === "FINDING").length, 0);
    emit(`seed = ${forms.seed}，rate = ${forms.rate}，总单元 ${forms.totalUnits}，入选 ${forms.selectedUnits.length}`);
    emit(
      `表单 ${forms.forms.length} 份（disagreement 层 ${counts.disagreement} / agreement 层 ${counts.agreement} / no-judge 层 ${counts["no-judge"]}），条目 ${items}（FINDING ${findingItems} / MISSED_TRUTH ${items - findingItems}）`,
    );
  } catch (error) {
    emit(`（forms.json 不可读：${(error as Error).message}）`);
  }
  emit();
  return out;
}

// ── 主流程 ─────────────────────────────────────────────────────────────
async function main(argv: string[]): Promise<number> {
  const runsRoot = argv[0] ?? "runs";
  const reports = new Map<Side, ExperimentReport>();
  const judges = new Map<Side, JudgeStageReport>();
  const verdictsBySide = new Map<Side, VerdictReports>();
  for (const side of SIDES) {
    const report = await readReport(runsRoot, side);
    const stages = stageOf(report, side);
    reports.set(side, report);
    judges.set(side, stages.judge);
    verdictsBySide.set(side, stages.verdicts);
  }
  const out: string[] = [];
  out.push(...faceVerdicts(verdictsBySide));
  out.push(...faceCriteria(verdictsBySide.get("phase2-main")));
  const mainJudge = judges.get("phase2-main");
  if (mainJudge === undefined) throw new Error("main judge stage missing");
  out.push(...faceChain(mainJudge));
  out.push(...faceComparison(judges));
  out.push(...faceInstability(judges));
  out.push(...faceSigma(judges));
  out.push(...(await faceBudget(runsRoot, reports)));
  out.push(...(await faceTemporal(runsRoot)));
  out.push(...(await faceHumanReview(runsRoot, mainJudge)));
  process.stdout.write(`${out.join("\n")}\n`);
  return 0;
}

function estimateWindowVerdict(total: { billed: number; withCache: number } | undefined, caliber: TokenCaliber): string {
  if (total === undefined) return "—";
  const value = total[caliber];
  const lo = caliber === "billed" ? ESTIMATE_WINDOW.billedLo : ESTIMATE_WINDOW.withCacheLo;
  const hi = caliber === "billed" ? ESTIMATE_WINDOW.billedHi : ESTIMATE_WINDOW.withCacheHi;
  return `${fmtTokens(value)} → ${value >= lo && value <= hi ? "IN" : "OUT"}（窗 ${fmtTokens(lo)}–${fmtTokens(hi)}）`;
}
function durationHours(first: string, last: string): string {
  return ((Date.parse(last) - Date.parse(first)) / 3.6e6).toFixed(1);
}
function gapHours(end: string | undefined, start: string | undefined): string {
  if (end === undefined || start === undefined) return "—";
  return ((Date.parse(start) - Date.parse(end)) / 3.6e6).toFixed(2);
}

try {
  process.exit(await main(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`analyze-phase2: ${(error as Error).message}\n`);
  process.exit(2);
}
