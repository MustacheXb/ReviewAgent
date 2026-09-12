import type { MetricsConfigId } from "../contracts/config.js";
import { summarizeDefined } from "./stats.js";
import type { FlatMetrics, MetricsField, Stat } from "./types.js";

/**
 * 指标对齐门协议 v2（#31，落地 #30 噪声底报告 §6 修订建议）。
 *
 * 判定口径（修订后）：
 * 1. 对称 max σ 带：带宽 = 两侧样本 σ 较大者、中心 = 基线均值——消除「带取自哪侧」的
 *    方向依赖（|Δmean| ≤ max σ ⟺ 双向均落带）。遗留单侧带（#29 口径）并列报告，
 *    协议变更可见且可复算锚定。
 * 2. 最小样本护栏：任一侧 n < minSampleCount（默认 3）的格标 INSUFFICIENT_SAMPLE，
 *    不判定、不触发 FAIL（样本不足 ≠ 偏差证据）。
 * 3. 单元配对符号检验（噪声对照侧在场时的主判据）：单元级
 *    |Δcandidate−baseline| vs |Δnoise−baseline| 的精确二项符号检验；
 *    仅「候选显著更差」方向拒绝才 FAIL（无证据更差 = PASS）。
 *    前置规则（按指标）：该指标配对检验 PASS 时，其带外格不触发 FAIL（带外被
 *    「候选与噪声不可区分」否决，advisory 可见）；NOT_TESTED / 缺席时回落格判定。
 * 4. 样本量建议面：已判定格任一侧 n < advisorySampleCount（默认 15）出 advisory
 *    （#30 实测：n=9 的 σ 估计跨次摆幅可达 3.7×；取最小侧——小侧才是 σ 不稳源）。
 * 5. 时点配对面：各侧执行窗 + 对照-基线两窗区间距离（不相交取最近边距、重叠为 0），
 *    超过阈值（默认 48h）出 advisory（跨日部署漂移预警）。
 *
 * 本模块为纯函数：无网络、无 LLM、无文件系统副作用，输入输出全显式。
 * 记录加载（RunStore → evaluateRun → 扁平化）在 src/experiment/alignment-gate-io.ts。
 */

/** 门判定指标缺省口径（#29/#30 四指标） */
export const DEFAULT_GATE_METRICS: readonly MetricsField[] = [
  "lineRecall",
  "linePrecision",
  "totalTokens",
  "cacheHitRate",
];

/** 一个评测单元（case × config × rep）的扁平指标样本 */
export interface GateUnitSample {
  /** 单元唯一键（加载器口径 `${source}:${caseId}:${configId}:rep${rep}`；配对按键匹配） */
  readonly unitKey: string;
  readonly configId: MetricsConfigId;
  readonly flat: FlatMetrics;
}

/** 一侧的执行窗（记录 completedAt 的 min/max；可选——无留痕时缺席） */
export interface GateExecutionWindow {
  readonly first: string;
  readonly last: string;
}

/** 门的一侧输入：基线 / 候选 / 噪声对照 */
export interface GateSideInput {
  readonly name: string;
  readonly units: readonly GateUnitSample[];
  readonly window?: GateExecutionWindow;
}

export interface AlignmentGateOptions {
  /** 参与判定的指标（缺省四指标口径） */
  readonly metrics: readonly MetricsField[];
  /** 最小样本护栏：任一侧 n < 该值 → INSUFFICIENT_SAMPLE（缺省 3） */
  readonly minSampleCount: number;
  /** 样本量建议阈值：已判定格 n < 该值出 advisory（缺省 15） */
  readonly advisorySampleCount: number;
  /** 符号检验显著性水平（缺省 0.05） */
  readonly significanceLevel: number;
  /** 时点配对预警阈值（小时；缺省 48） */
  readonly temporalPairingHours: number;
}

export const DEFAULT_ALIGNMENT_GATE_OPTIONS: AlignmentGateOptions = {
  metrics: DEFAULT_GATE_METRICS,
  minSampleCount: 3,
  advisorySampleCount: 15,
  significanceLevel: 0.05,
  temporalPairingHours: 48,
};

export type GateCellStatus =
  | "IN"
  | "OUT"
  | "INSUFFICIENT_SAMPLE"
  | "NO_BASELINE_SAMPLES"
  | "NO_CANDIDATE_SAMPLES";

export interface GateBand {
  readonly lo: number;
  readonly hi: number;
}

/** 一个 (config × metric) 格的判定 */
export interface GateCell {
  readonly configId: MetricsConfigId;
  readonly metric: MetricsField;
  readonly baseline: Stat | null;
  readonly candidate: Stat | null;
  /** 修订口径带：baseline.mean ± max(σ_base, σ_cand)；任一侧无样本为 null */
  readonly symmetricBand: GateBand | null;
  /** 遗留口径带（#29 单侧基线 σ）；任一侧无样本为 null */
  readonly legacyBand: GateBand | null;
  /** 修订口径判定 */
  readonly status: GateCellStatus;
  /** 遗留口径判定（并列报告；无最小样本护栏——忠实复刻 #29） */
  readonly legacyStatus: GateCellStatus;
  /** candidate.mean − baseline.mean；任一侧无样本为 null */
  readonly delta: number | null;
  /** INSUFFICIENT_SAMPLE 时指出不足的侧；否则 null */
  readonly insufficientSide: "baseline" | "candidate" | "both" | null;
}

/** 一个指标的单元配对符号检验结果（噪声对照侧在场时） */
export interface PairedMetricResult {
  readonly metric: MetricsField;
  /** 参与检验的非并列配对数（= candidateWorse + candidateBetter） */
  readonly pairCount: number;
  /** mean |Δcandidate−baseline|（全部有效三元组，含并列） */
  readonly candidateMeanDelta: number | null;
  /** mean |Δnoise−baseline|（同上） */
  readonly noiseMeanDelta: number | null;
  /** |Δcandidate| > |Δnoise| 的单元数（候选更差） */
  readonly candidateWorse: number;
  /** |Δcandidate| < |Δnoise| 的单元数（候选更好） */
  readonly candidateBetter: number;
  /** |Δ| 完全相等的并列单元数（剔除出检验） */
  readonly ties: number;
  /** 精确二项单侧 p = P(Bin(n, 0.5) ≥ candidateWorse)；n = 0 或无有效配对为 null */
  readonly worseDirectionP: number | null;
  /** FAIL = 候选显著更差（p ≤ α 且过半）；NOT_TESTED = 无有效配对 */
  readonly verdict: "PASS" | "FAIL" | "NOT_TESTED";
}

export interface TemporalPairingReport {
  readonly baselineWindow: GateExecutionWindow | null;
  readonly candidateWindow: GateExecutionWindow | null;
  readonly noiseWindow: GateExecutionWindow | null;
  /** candidate 与 baseline 两窗区间距离（小时；不相交取最近边距、重叠为 0）；任一侧缺席或不可解析为 null */
  readonly candidateGapHours: number | null;
  /** noise 与 baseline 两窗区间距离（小时；同上） */
  readonly noiseGapHours: number | null;
  readonly exceedsThreshold: boolean;
}

export interface AlignmentGateReport {
  readonly baselineSide: string;
  readonly candidateSide: string;
  readonly noiseSide: string | null;
  readonly metrics: readonly MetricsField[];
  readonly cells: readonly GateCell[];
  /** 噪声对照缺席时为空数组 */
  readonly paired: readonly PairedMetricResult[];
  /** 任一侧带执行窗时在场；否则 null */
  readonly temporal: TemporalPairingReport | null;
  readonly advisories: readonly string[];
  readonly verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
  readonly basis: string;
}

/** 主入口：两侧（+ 可选噪声对照）单元样本 → 结构化判定报告 */
export function runAlignmentGate(
  baseline: GateSideInput,
  candidate: GateSideInput,
  noiseControl: GateSideInput | null = null,
  options: AlignmentGateOptions = DEFAULT_ALIGNMENT_GATE_OPTIONS,
): AlignmentGateReport {
  validateSide(baseline, "baseline");
  validateSide(candidate, "candidate");
  if (noiseControl !== null) {
    validateSide(noiseControl, "noiseControl");
  }
  validateAlignmentGateOptions(options);

  const byConfigBase = groupByConfig(baseline.units);
  const byConfigCand = groupByConfig(candidate.units);
  const configIds = [...new Set([...byConfigBase.keys(), ...byConfigCand.keys()])].sort();

  const cells: GateCell[] = [];
  for (const configId of configIds) {
    for (const metric of options.metrics) {
      cells.push(judgeCell(configId, metric, byConfigBase.get(configId) ?? [], byConfigCand.get(configId) ?? [], options));
    }
  }

  const paired =
    noiseControl === null
      ? []
      : options.metrics.map((metric) =>
          judgePairedMetric(metric, baseline.units, candidate.units, noiseControl.units, options),
        );

  const temporalBundle = buildTemporalReport(baseline, candidate, noiseControl, options);
  const temporal = temporalBundle.report;
  const pairedVerdictByMetric = new Map(paired.map((result) => [result.metric, result.verdict]));
  const advisories = collectAdvisories(cells, paired, temporalBundle, pairedVerdictByMetric, options);

  // 前置规则（#31 What-to-build 3：配对检验在场时升主判据）：指标的配对检验 PASS
  // → 其带外格的 FAIL 贡献被否决（带外 = 检验力问题，非对齐失败）；NOT_TESTED /
  // 缺席（含噪声侧不在场）→ 该指标回落格判定。配对 FAIL 恒触发 FAIL。
  const failed =
    paired.some((result) => result.verdict === "FAIL") ||
    cells.some((cell) => cell.status === "OUT" && pairedVerdictByMetric.get(cell.metric) !== "PASS");
  const maskedOutCount = cells.filter(
    (cell) => cell.status === "OUT" && pairedVerdictByMetric.get(cell.metric) === "PASS",
  ).length;
  const judged =
    cells.some((cell) => cell.status === "IN" || cell.status === "OUT") ||
    paired.some((result) => result.verdict === "PASS" || result.verdict === "FAIL");
  const verdict: AlignmentGateReport["verdict"] = failed ? "FAIL" : judged ? "PASS" : "INCONCLUSIVE";

  const inCount = cells.filter((cell) => cell.status === "IN").length;
  const outCount = cells.filter((cell) => cell.status === "OUT").length;
  const insufficientCount = cells.filter((cell) => cell.status === "INSUFFICIENT_SAMPLE").length;
  const missingCount = cells.length - inCount - outCount - insufficientCount;
  const pairedNote =
    noiseControl === null
      ? "未执行（无噪声对照侧）"
      : `${paired.filter((p) => p.verdict === "PASS").length} PASS / ${paired.filter((p) => p.verdict === "FAIL").length} FAIL / ${paired.filter((p) => p.verdict === "NOT_TESTED").length} NOT_TESTED`;
  const precedenceNote =
    noiseControl === null ? "" : `；主判据否决带外格 ${maskedOutCount} 个（配对 PASS 的指标）`;
  const basis = `格判定：${inCount} IN / ${outCount} OUT / ${insufficientCount} 样本不足 / ${missingCount} 缺失；配对检验：${pairedNote}${precedenceNote}；判定 ${verdict}`;

  return {
    baselineSide: baseline.name,
    candidateSide: candidate.name,
    noiseSide: noiseControl === null ? null : noiseControl.name,
    metrics: [...options.metrics],
    cells,
    paired,
    temporal,
    advisories,
    verdict,
    basis,
  };
}

// ===== 格判定 =====

function groupByConfig(units: readonly GateUnitSample[]): Map<MetricsConfigId, FlatMetrics[]> {
  const map = new Map<MetricsConfigId, FlatMetrics[]>();
  for (const unit of units) {
    const existing = map.get(unit.configId);
    if (existing === undefined) {
      map.set(unit.configId, [unit.flat]);
    } else {
      existing.push(unit.flat);
    }
  }
  return map;
}

function judgeCell(
  configId: MetricsConfigId,
  metric: MetricsField,
  baseFlats: readonly FlatMetrics[],
  candFlats: readonly FlatMetrics[],
  options: AlignmentGateOptions,
): GateCell {
  const baseline = summarizeDefined(baseFlats.map((flat) => flat[metric]));
  const candidate = summarizeDefined(candFlats.map((flat) => flat[metric]));

  let status: GateCellStatus;
  let legacyStatus: GateCellStatus;
  let symmetricBand: GateBand | null = null;
  let legacyBand: GateBand | null = null;
  let insufficientSide: "baseline" | "candidate" | "both" | null = null;

  if (baseline === null) {
    status = "NO_BASELINE_SAMPLES";
    legacyStatus = "NO_BASELINE_SAMPLES";
  } else if (candidate === null) {
    status = "NO_CANDIDATE_SAMPLES";
    legacyStatus = "NO_CANDIDATE_SAMPLES";
  } else {
    legacyBand = { lo: baseline.mean - baseline.std, hi: baseline.mean + baseline.std };
    legacyStatus = candidate.mean >= legacyBand.lo && candidate.mean <= legacyBand.hi ? "IN" : "OUT";

    const baseShort = baseline.count < options.minSampleCount;
    const candShort = candidate.count < options.minSampleCount;
    if (baseShort || candShort) {
      status = "INSUFFICIENT_SAMPLE";
      insufficientSide = baseShort && candShort ? "both" : baseShort ? "baseline" : "candidate";
    } else {
      const sigma = Math.max(baseline.std, candidate.std);
      symmetricBand = { lo: baseline.mean - sigma, hi: baseline.mean + sigma };
      status = candidate.mean >= symmetricBand.lo && candidate.mean <= symmetricBand.hi ? "IN" : "OUT";
    }
  }

  return {
    configId,
    metric,
    baseline,
    candidate,
    symmetricBand,
    legacyBand,
    status,
    legacyStatus,
    delta: baseline !== null && candidate !== null ? candidate.mean - baseline.mean : null,
    insufficientSide,
  };
}

// ===== 单元配对符号检验 =====

function judgePairedMetric(
  metric: MetricsField,
  baselineUnits: readonly GateUnitSample[],
  candidateUnits: readonly GateUnitSample[],
  noiseUnits: readonly GateUnitSample[],
  options: AlignmentGateOptions,
): PairedMetricResult {
  const baseByKey = new Map(baselineUnits.map((unit) => [unit.unitKey, unit.flat[metric]]));
  const candByKey = new Map(candidateUnits.map((unit) => [unit.unitKey, unit.flat[metric]]));
  const noiseByKey = new Map(noiseUnits.map((unit) => [unit.unitKey, unit.flat[metric]]));

  let candidateWorse = 0;
  let candidateBetter = 0;
  let ties = 0;
  let candidateDeltaSum = 0;
  let noiseDeltaSum = 0;
  let validTriplets = 0;

  for (const [unitKey, baseValue] of baseByKey) {
    const candValue = candByKey.get(unitKey);
    const noiseValue = noiseByKey.get(unitKey);
    if (
      candValue === undefined ||
      noiseValue === undefined ||
      baseValue === null ||
      candValue === null ||
      noiseValue === null
    ) {
      continue;
    }
    const candidateDelta = Math.abs(candValue - baseValue);
    const noiseDelta = Math.abs(noiseValue - baseValue);
    candidateDeltaSum += candidateDelta;
    noiseDeltaSum += noiseDelta;
    validTriplets += 1;
    if (candidateDelta === noiseDelta) {
      ties += 1;
    } else if (candidateDelta > noiseDelta) {
      candidateWorse += 1;
    } else {
      candidateBetter += 1;
    }
  }

  const pairCount = candidateWorse + candidateBetter;
  const p = pairCount === 0 ? null : binomialUpperTail(candidateWorse, pairCount);
  let verdict: PairedMetricResult["verdict"];
  if (validTriplets === 0) {
    verdict = "NOT_TESTED";
  } else if (p !== null && p <= options.significanceLevel && candidateWorse > candidateBetter) {
    verdict = "FAIL";
  } else {
    verdict = "PASS";
  }

  return {
    metric,
    pairCount,
    candidateMeanDelta: validTriplets === 0 ? null : candidateDeltaSum / validTriplets,
    noiseMeanDelta: validTriplets === 0 ? null : noiseDeltaSum / validTriplets,
    candidateWorse,
    candidateBetter,
    ties,
    worseDirectionP: p,
    verdict,
  };
}

/** 精确二项单侧上尾：P(X ≥ w)，X ~ Binomial(n, 0.5)。n ≤ ~1000（2^-n 不下溢域） */
function binomialUpperTail(w: number, n: number): number {
  if (w <= 0) {
    return 1;
  }
  let pmf = 2 ** -n;
  let sum = 0;
  for (let k = 0; k <= n; k += 1) {
    if (k >= w) {
      sum += pmf;
    }
    pmf = (pmf * (n - k)) / (k + 1);
  }
  return Math.min(1, sum);
}

// ===== 时点配对面 =====

/** 时点面内部产物：公开报告 + 不可解析侧（advisory 用；解析只做一次） */
interface TemporalReportBundle {
  readonly report: TemporalPairingReport | null;
  readonly unparseableSides: readonly string[];
}

function buildTemporalReport(
  baseline: GateSideInput,
  candidate: GateSideInput,
  noiseControl: GateSideInput | null,
  options: AlignmentGateOptions,
): TemporalReportBundle {
  const hasAnyWindow = baseline.window !== undefined || candidate.window !== undefined || noiseControl?.window !== undefined;
  if (!hasAnyWindow) {
    return { report: null, unparseableSides: [] };
  }
  const baseMillis = parseWindow(baseline.window);
  const candMillis = parseWindow(candidate.window);
  const noiseMillis = parseWindow(noiseControl?.window);
  const unparseableSides: string[] = [];
  if (baseline.window !== undefined && baseMillis === null) {
    unparseableSides.push("baseline");
  }
  if (candidate.window !== undefined && candMillis === null) {
    unparseableSides.push("candidate");
  }
  if (noiseControl?.window !== undefined && noiseMillis === null) {
    unparseableSides.push("noise");
  }
  const candidateGapHours = windowGapHours(candMillis, baseMillis);
  const noiseGapHours = windowGapHours(noiseMillis, baseMillis);
  const gaps = [candidateGapHours, noiseGapHours].filter((gap): gap is number => gap !== null);
  return {
    report: {
      baselineWindow: baseline.window ?? null,
      candidateWindow: candidate.window ?? null,
      noiseWindow: noiseControl?.window ?? null,
      candidateGapHours,
      noiseGapHours,
      exceedsThreshold: gaps.some((gap) => gap > options.temporalPairingHours),
    },
    unparseableSides,
  };
}

function parseWindow(window: GateExecutionWindow | undefined): { readonly first: number; readonly last: number } | null {
  if (window === undefined) {
    return null;
  }
  const first = Date.parse(window.first);
  const last = Date.parse(window.last);
  return Number.isFinite(first) && Number.isFinite(last) ? { first, last } : null;
}

/** 两执行窗的区间距离（小时）：不相交取最近边距，重叠为 0（时点紧邻/重叠都不预警） */
function windowGapHours(
  a: { readonly first: number; readonly last: number } | null,
  b: { readonly first: number; readonly last: number } | null,
): number | null {
  if (a === null || b === null) {
    return null;
  }
  const separationMillis = Math.max(a.first - b.last, b.first - a.last, 0);
  return separationMillis / 3_600_000;
}

// ===== advisory 汇总（顺序确定：格 → 配对 → 时点） =====

function collectAdvisories(
  cells: readonly GateCell[],
  paired: readonly PairedMetricResult[],
  temporalBundle: TemporalReportBundle,
  pairedVerdictByMetric: ReadonlyMap<MetricsField, PairedMetricResult["verdict"]>,
  options: AlignmentGateOptions,
): string[] {
  const advisories: string[] = [];
  for (const cell of cells) {
    const label = `${cell.configId}/${cell.metric}`;
    if (cell.status === "INSUFFICIENT_SAMPLE") {
      const side = cell.insufficientSide === "both" ? "双侧" : cell.insufficientSide === "baseline" ? "基线侧" : "候选侧";
      const n = cell.insufficientSide === "candidate" ? cell.candidate?.count : cell.baseline?.count;
      advisories.push(`样本不足：${label} ${side} n=${n ?? "?"} < ${options.minSampleCount}，未判定`);
    } else if (cell.status === "NO_BASELINE_SAMPLES" || cell.status === "NO_CANDIDATE_SAMPLES") {
      const side = cell.status === "NO_BASELINE_SAMPLES" ? "基线侧" : "候选侧";
      advisories.push(`数据缺失：${label} ${side}无有效样本（指标全 null 或 config 缺席）`);
    } else if (cell.status !== cell.legacyStatus) {
      advisories.push(`协议修订可见：${label} 遗留单侧带判 ${cell.legacyStatus}、对称带判 ${cell.status}（#30 噪声底修订）`);
    }
    if (cell.status === "OUT" && pairedVerdictByMetric.get(cell.metric) === "PASS") {
      advisories.push(
        `格带外由配对检验否决：${label} 对称带判 OUT，但 ${cell.metric} 配对符号检验 PASS（候选与噪声不可区分）——按 v2 主判据不触发 FAIL`,
      );
    }
    if (cell.status === "IN" || cell.status === "OUT") {
      const baseN = cell.baseline?.count ?? 0;
      const candN = cell.candidate?.count ?? 0;
      if (Math.min(baseN, candN) < options.advisorySampleCount) {
        advisories.push(
          `样本量建议：${label} 基线 n=${baseN} / 候选 n=${candN}，最小侧 < ${options.advisorySampleCount}——σ 估计跨次摆幅大（#30 实测可达 3.7×），格级带判定按噪声底口径解读`,
        );
      }
    }
  }
  for (const result of paired) {
    if (result.verdict === "NOT_TESTED") {
      advisories.push(`配对检验未执行：${result.metric} 有效配对 0`);
    }
  }
  const temporal = temporalBundle.report;
  if (temporal !== null) {
    if (temporalBundle.unparseableSides.length > 0) {
      advisories.push(`时间窗不可解析（${temporalBundle.unparseableSides.join(", ")}）：时点间隔未计算`);
    }
    if (temporal.exceedsThreshold) {
      const parts = [
        temporal.candidateGapHours !== null ? `candidate-baseline ${temporal.candidateGapHours.toFixed(1)}h` : null,
        temporal.noiseGapHours !== null ? `noise-baseline ${temporal.noiseGapHours.toFixed(1)}h` : null,
      ].filter((part): part is string => part !== null);
      advisories.push(
        `时点配对预警：${parts.join("、")} > ${options.temporalPairingHours}h——跨日部署漂移可能同时进入两侧对照（#30 §4.2/§4.3）`,
      );
    }
  }
  return advisories;
}

// ===== 输入校验（fail fast，错误指明字段与期望；CLI 收尾经它统一域规则） =====

function validateSide(side: GateSideInput, label: string): void {
  if (typeof side !== "object" || side === null) {
    throw new Error(`${label} must be a GateSideInput object`);
  }
  if (typeof side.name !== "string" || side.name.trim().length === 0) {
    throw new Error(`${label}.name must be a non-empty string`);
  }
  if (!Array.isArray(side.units) || side.units.length === 0) {
    throw new Error(`${label}.units must be a non-empty array of GateUnitSample`);
  }
  side.units.forEach((unit, index) => {
    if (typeof unit !== "object" || unit === null) {
      throw new Error(`${label}.units[${index}] must be a GateUnitSample object`);
    }
    if (typeof unit.unitKey !== "string" || unit.unitKey.length === 0) {
      throw new Error(`${label}.units[${index}].unitKey must be a non-empty string`);
    }
    if (typeof unit.flat !== "object" || unit.flat === null) {
      throw new Error(`${label}.units[${index}].flat must be a FlatMetrics object`);
    }
  });
}

/** 选项域校验（公开：CLI 参数收尾复用，域规则单源——不与解析层重复维护） */
export function validateAlignmentGateOptions(options: AlignmentGateOptions): void {
  if (!Array.isArray(options.metrics) || options.metrics.length === 0) {
    throw new Error("options.metrics must be a non-empty array of MetricsField");
  }
  if (!Number.isInteger(options.minSampleCount) || options.minSampleCount < 1) {
    throw new Error(`options.minSampleCount must be an integer ≥ 1 (got ${JSON.stringify(options.minSampleCount)})`);
  }
  if (!Number.isInteger(options.advisorySampleCount) || options.advisorySampleCount < 1) {
    throw new Error(
      `options.advisorySampleCount must be an integer ≥ 1 (got ${JSON.stringify(options.advisorySampleCount)})`,
    );
  }
  if (!(options.significanceLevel > 0 && options.significanceLevel < 1)) {
    throw new Error(
      `options.significanceLevel must be in (0, 1) exclusive (got ${JSON.stringify(options.significanceLevel)})`,
    );
  }
  if (!(options.temporalPairingHours > 0)) {
    throw new Error(
      `options.temporalPairingHours must be > 0 (got ${JSON.stringify(options.temporalPairingHours)})`,
    );
  }
}
