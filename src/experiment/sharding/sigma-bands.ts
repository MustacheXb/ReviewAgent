import type { MRCase, MRTruth } from "../../contracts/mr-case.js";
import type { Finding } from "../../contracts/finding.js";
import { DEFAULT_SCREENING_OPTIONS, type Stat } from "../../metrics/types.js";
import { evaluateNoLoss, evaluateNoWrongMerge } from "./criteria.js";
import type { GroupValidationReport } from "./harness.js";
import { mergeShardFindings, type ShardFindings } from "../../sharding/merge-findings.js";

/**
 * #59 σ 带判定层（实验设计 §2.4）：两组对比 + 计数守卫 + 锚点键校准——纯函数，
 * IO 壳在 scripts/analyze-sharding-validation.ts（报告扫描 / 基线装载 / 落盘）。
 *
 * - 主判指标 = strict 不丢率（evaluateNoLoss；loose 口径并列报告不进主判）。
 * - 对比 A（纯切分合并效应）：候选 = 处理臂逐组逐 rep strict 率，基线 = 控制臂。
 * - 对比 B（填充 + 组合效应）：候选 = 控制臂，基线 = 直跑自漂移底（每案例 rep r
 *   的 findings 在其余 rep 结果中的 strict 命中占比——evaluateNoLoss 同定义复用）。
 * - 带 = 基线侧均值 ± max(σ_base, σ_cand)（ADR-0007 对称 max σ 带）；任一侧
 *   n < 3 不判定；恶化方向带外才是失败（不丢率越高越好）。
 * - 归因链：A 带外（恶化）= 切分合并效应实锤；仅 B 带外（恶化）= 填充效应主导。
 * - 计数守卫（不进 σ 带）：不重 / 不误并非零即逐例调查。
 * - 锚点键校准（AC5 素材）：处理臂各片以 ±1/±3/±5 重放合并 + 误并判据；合成
 *   真值 = 入选案例真值并集（composeComposite 契约）。
 * - 产出确定性：全 JSON 可序列化、无时间戳，同输入必同报告。
 */

/** σ 带最小样本护栏（§1 共同方法：n < 3 不判定） */
export const MIN_SAMPLE_COUNT = 3;
/** 不丢 / LOO 匹配行距容差（= 合并层 lineWindow 缺省，harness 同款） */
export const MATCH_WINDOW = 3;
/** 锚点键校准窗口（起步值 3；§2.4） */
export const CALIBRATION_WINDOWS = [1, 3, 5] as const;

/** 一份已装载的组验证报告（断点产物：组 × rep） */
export interface LoadedShardingReport {
  readonly group: string;
  readonly rep: number;
  readonly report: GroupValidationReport;
}

export interface SigmaBandInput {
  readonly reports: readonly LoadedShardingReport[];
  readonly expectedGroups: readonly string[];
  readonly expectedReps: readonly number[];
  /** LOO 底原料：caseId → rep → 直跑 findings（缺 rep = 该配对缺席，如实跳过） */
  readonly baselineFindings: ReadonlyMap<string, ReadonlyMap<number, readonly Finding[]>>;
  /** 案例表（合成真值并集用） */
  readonly caseById: ReadonlyMap<string, MRCase>;
}

/** 单臂样本：一个 (组, rep, 臂) 的 strict 不丢率（空基线 = null，如实列明） */
export interface ArmSample {
  readonly group: string;
  readonly rep: number;
  readonly arm: "treatment" | "control";
  readonly baselineFindings: number;
  readonly strictMatched: number;
  readonly strictRate: number | null;
  readonly shardCount: number;
  readonly findingCount: number;
  readonly tokens: number;
}

/** LOO 自漂移样本：一个 (案例, rep) 的直跑自漂移命中率 */
export interface LooSample {
  readonly caseId: string;
  readonly rep: number;
  readonly ownFindings: number;
  readonly strictRate: number;
}

export type BandVerdictKind = "IN" | "OUT_WORSE" | "OUT_BETTER" | "INSUFFICIENT_SAMPLE";

export interface BandVerdict {
  readonly baseline: Stat | null;
  readonly candidate: Stat | null;
  readonly bandLo: number | null;
  readonly bandHi: number | null;
  readonly verdict: BandVerdictKind;
  readonly note: string;
}

export interface SigmaBandAnalysis {
  readonly protocol: {
    readonly metric: string;
    readonly band: string;
    readonly minSampleCount: number;
    readonly matchWindow: number;
    readonly calibrationWindows: readonly number[];
  };
  readonly completeness: {
    readonly expectedGroups: readonly string[];
    readonly foundReports: readonly string[];
    readonly missing: readonly string[];
    readonly emptyBaselineSamples: readonly string[];
  };
  readonly samples: {
    readonly treatment: readonly (Record<string, number | string | null>)[];
    readonly control: readonly (Record<string, number | string | null>)[];
    readonly looSelfDrift: readonly LooSample[];
  };
  readonly comparisonA: BandVerdict;
  readonly comparisonB: BandVerdict;
  readonly attribution: string;
  readonly guards: {
    readonly noDuplicate: { readonly total: number; readonly details: readonly string[] };
    readonly noWrongMerge: { readonly total: number; readonly details: readonly string[] };
  };
  readonly anchorKeyCalibration: readonly {
    readonly lineWindow: number;
    readonly mergedCount: number;
    readonly wrongMergeEntries: number;
    readonly wrongMergeDetails: readonly string[];
  }[];
  readonly budgetReadout: {
    readonly tokensPerArmRep: readonly { readonly unit: string; readonly shards: number; readonly tokens: number }[];
  };
}

/** 均值 ± 样本标准差（n-1；count ≤ 1 时 std = 0——与 metrics Stat 同口径） */
function statOf(values: readonly number[]): Stat {
  const count = values.length;
  if (count === 0) {
    return { count: 0, mean: 0, std: 0 };
  }
  const mean = values.reduce((sum, v) => sum + v, 0) / count;
  if (count <= 1) {
    return { count, mean, std: 0 };
  }
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (count - 1);
  return { count, mean, std: Math.sqrt(variance) };
}

/** 对称 max σ 带判定：带 = 基线侧均值 ± max(σ_base, σ_cand)；n < 3 不判定 */
export function judgeBand(
  baselineValues: readonly number[],
  candidateValues: readonly number[],
): BandVerdict {
  const baseline = statOf(baselineValues);
  const candidate = statOf(candidateValues);
  if (baseline.count < MIN_SAMPLE_COUNT || candidate.count < MIN_SAMPLE_COUNT) {
    const insufficient =
      baseline.count < MIN_SAMPLE_COUNT && candidate.count < MIN_SAMPLE_COUNT
        ? "both"
        : baseline.count < MIN_SAMPLE_COUNT
          ? "baseline"
          : "candidate";
    return {
      baseline: baseline.count > 0 ? baseline : null,
      candidate: candidate.count > 0 ? candidate : null,
      bandLo: null,
      bandHi: null,
      verdict: "INSUFFICIENT_SAMPLE",
      note: `样本不足（${insufficient} 侧 n < ${MIN_SAMPLE_COUNT}）——不判定`,
    };
  }
  const sigma = Math.max(baseline.std, candidate.std);
  const bandLo = baseline.mean - sigma;
  const bandHi = baseline.mean + sigma;
  const verdict =
    candidate.mean < bandLo ? "OUT_WORSE" : candidate.mean > bandHi ? "OUT_BETTER" : "IN";
  return {
    baseline,
    candidate,
    bandLo,
    bandHi,
    verdict,
    note:
      verdict === "OUT_WORSE"
        ? "候选侧均值低于带下界（恶化方向带外）"
        : verdict === "OUT_BETTER"
          ? "候选侧均值高于带上界（改善方向带外）"
          : "候选侧均值在带内",
  };
}

/** 单臂样本（tokens = 臂级 usage 的 i+o+cacheRead 口径，与预算锚同面） */
function armSampleOf(
  group: string,
  rep: number,
  arm: "treatment" | "control",
  report: GroupValidationReport,
): ArmSample {
  const armReport = report.arms[arm];
  const usage = armReport.usage;
  return {
    group,
    rep,
    arm,
    baselineFindings: armReport.noLoss.totalBaseline,
    strictMatched: armReport.noLoss.totalStrict,
    strictRate:
      armReport.noLoss.totalBaseline === 0
        ? null
        : armReport.noLoss.totalStrict / armReport.noLoss.totalBaseline,
    shardCount: armReport.shardCount,
    findingCount: armReport.findings.length,
    tokens: usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0),
  };
}

/** LOO 自漂移底：每案例 rep r 的 findings 在其余 rep 结果中的 strict 命中占比 */
function looSamples(input: SigmaBandInput): readonly LooSample[] {
  const samples: LooSample[] = [];
  const caseIds = [...input.baselineFindings.keys()].sort();
  for (const caseId of caseIds) {
    const byRep = input.baselineFindings.get(caseId)!;
    for (const rep of [...byRep.keys()].sort((a, b) => a - b)) {
      const own = byRep.get(rep)!;
      if (own.length === 0) {
        continue; // 空基线无命中率可算（如实缺席）
      }
      const others = [...byRep.entries()]
        .filter(([otherRep]) => otherRep !== rep)
        .flatMap(([, findings]) => findings);
      if (others.length === 0) {
        continue; // 其余 rep 全缺席，LOO 不可算
      }
      const noLoss = evaluateNoLoss({
        baseline: [{ caseId, rep, findings: own }],
        findings: others,
        matchWindow: MATCH_WINDOW,
        screening: DEFAULT_SCREENING_OPTIONS,
      });
      samples.push({
        caseId,
        rep,
        ownFindings: own.length,
        strictRate: noLoss.totalStrict / noLoss.totalBaseline,
      });
    }
  }
  return samples;
}

/** 合成真值 = 入选案例真值并集（composeComposite 契约） */
function unionTruth(
  includedCaseIds: readonly string[],
  caseById: ReadonlyMap<string, MRCase>,
  groupId: string,
): MRTruth {
  const locations = includedCaseIds.flatMap((caseId) => {
    const mrCase = caseById.get(caseId);
    if (mrCase === undefined) {
      throw new Error(`group "${groupId}" includes unknown caseId "${caseId}" (not in cases file)`);
    }
    if (mrCase.truth === null || mrCase.truth === undefined) {
      throw new Error(`group "${groupId}" includes case "${caseId}" whose truth is null (composeComposite contract violation)`);
    }
    return mrCase.truth.locations;
  });
  return { locations, fixPatch: "" };
}

/** 锚点键校准：处理臂各片以 ±1/±3/±5 重放合并 + 误并判据 */
function calibrateAnchorKey(input: SigmaBandInput): SigmaBandAnalysis["anchorKeyCalibration"] {
  return CALIBRATION_WINDOWS.map((lineWindow) => {
    let mergedCount = 0;
    let wrongMergeEntries = 0;
    const wrongMergeDetails: string[] = [];
    for (const { group, rep, report } of input.reports) {
      const shards: ShardFindings[] = report.arms.treatment.runs.map((run) => ({
        shardId: run.runId,
        findings: run.findings,
      }));
      const merged = mergeShardFindings(shards, { lineWindow });
      if (!merged.ok) {
        throw new Error(`merge replay failed at window ${lineWindow} (${group}/rep-${rep}): ${merged.error.message}`);
      }
      mergedCount += merged.value.findings.length;
      const truth = unionTruth(report.manifests.treatment.includedCaseIds, input.caseById, group);
      const wrongMerge = evaluateNoWrongMerge({
        shards,
        merge: { lineWindow },
        truth,
        screening: DEFAULT_SCREENING_OPTIONS,
      });
      if (!wrongMerge.ok) {
        throw new Error(`wrong-merge replay failed at window ${lineWindow} (${group}/rep-${rep}): ${wrongMerge.error.message}`);
      }
      wrongMergeEntries += wrongMerge.value.entries.length;
      for (const entry of wrongMerge.value.entries) {
        wrongMergeDetails.push(`${group}/rep-${rep}: anchor=${entry.anchorFindingId} truth=[${entry.distinctTruthIndices.join(",")}]`);
      }
    }
    return { lineWindow, mergedCount, wrongMergeEntries, wrongMergeDetails };
  });
}

/** 归因链（§2.4）：A 带外（恶化）= 切分合并效应实锤；仅 B 带外（恶化）= 填充效应主导 */
function attributionOf(comparisonA: BandVerdict, comparisonB: BandVerdict): string {
  if (comparisonA.verdict === "OUT_WORSE") {
    return "对比 A 带外（恶化）：切分合并效应实锤（处理臂不丢率低于控制臂带下界）";
  }
  if (comparisonB.verdict === "OUT_WORSE") {
    return "对比 A 带内、对比 B 带外（恶化）：填充 + 组合效应主导（控制臂不丢率低于直跑自漂移带下界）";
  }
  if (comparisonA.verdict === "INSUFFICIENT_SAMPLE" || comparisonB.verdict === "INSUFFICIENT_SAMPLE") {
    return "样本不足，归因链不成立（补齐报告后重跑）";
  }
  return "两对比均带内：未见切分合并 / 填充引入超出各自对照的真实丢失";
}

function sampleLine(sample: ArmSample): Record<string, number | string | null> {
  return {
    unit: `${sample.group}/rep-${sample.rep}`,
    baselineFindings: sample.baselineFindings,
    strictMatched: sample.strictMatched,
    strictRate: sample.strictRate === null ? null : round(sample.strictRate),
    shards: sample.shardCount,
    findings: sample.findingCount,
    tokens: sample.tokens,
  };
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function buildSigmaBandAnalysis(input: SigmaBandInput): SigmaBandAnalysis {
  const samples = input.reports.flatMap(({ group, rep, report }) => [
    armSampleOf(group, rep, "treatment", report),
    armSampleOf(group, rep, "control", report),
  ]);
  const treatment = samples.filter((sample) => sample.arm === "treatment");
  const control = samples.filter((sample) => sample.arm === "control");
  const loo = looSamples(input);

  const comparisonA = judgeBand(
    control.filter(hasRate).map((sample) => sample.strictRate!),
    treatment.filter(hasRate).map((sample) => sample.strictRate!),
  );
  const comparisonB = judgeBand(
    loo.map((sample) => sample.strictRate),
    control.filter(hasRate).map((sample) => sample.strictRate!),
  );

  // 计数守卫（不进 σ 带）：非零即逐例调查
  const noDuplicateDetails = input.reports.flatMap(({ group, rep, report }) =>
    report.noDuplicate.pairs.map(
      (pair) => `${group}/rep-${rep}: ${pair.findingIdA} ~ ${pair.findingIdB} (Δ${pair.lineDelta})`,
    ),
  );
  const noWrongMergeDetails = input.reports.flatMap(({ group, rep, report }) =>
    report.noWrongMerge.entries.map(
      (entry) => `${group}/rep-${rep}: anchor=${entry.anchorFindingId} truth=[${entry.distinctTruthIndices.join(",")}]`,
    ),
  );

  const found = input.reports.map(({ group, rep }) => `${group}/rep-${rep}`);
  const foundSet = new Set(found);
  const missing: string[] = [];
  for (const group of input.expectedGroups) {
    for (const rep of input.expectedReps) {
      const key = `${group}/rep-${rep}`;
      if (!foundSet.has(key)) {
        missing.push(key);
      }
    }
  }

  return {
    protocol: {
      metric: "strict 不丢率（evaluateNoLoss；loose 口径见逐臂报告）",
      band: "对称 max σ 带（ADR-0007）：基线侧均值 ± max(σ_base, σ_cand)",
      minSampleCount: MIN_SAMPLE_COUNT,
      matchWindow: MATCH_WINDOW,
      calibrationWindows: CALIBRATION_WINDOWS,
    },
    completeness: {
      expectedGroups: input.expectedGroups,
      foundReports: found,
      missing,
      emptyBaselineSamples: samples
        .filter((sample) => sample.strictRate === null)
        .map((sample) => `${sample.group}/rep-${sample.rep}/${sample.arm}`),
    },
    samples: {
      treatment: treatment.map(sampleLine),
      control: control.map(sampleLine),
      looSelfDrift: loo,
    },
    comparisonA,
    comparisonB,
    attribution: attributionOf(comparisonA, comparisonB),
    guards: {
      noDuplicate: { total: noDuplicateDetails.length, details: noDuplicateDetails },
      noWrongMerge: { total: noWrongMergeDetails.length, details: noWrongMergeDetails },
    },
    anchorKeyCalibration: calibrateAnchorKey(input),
    budgetReadout: {
      tokensPerArmRep: samples.map((sample) => ({
        unit: `${sample.group}/rep-${sample.rep}/${sample.arm}`,
        shards: sample.shardCount,
        tokens: sample.tokens,
      })),
    },
  };
}

function hasRate(sample: ArmSample): boolean {
  return sample.strictRate !== null;
}
