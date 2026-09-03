/**
 * 裁定归一后的占用解析（纯函数）：界内校验 → 置信度门槛 → 一对一占用。
 *
 * 一对一占用（复用规则粗筛 T10 的确定性纪律）：按条目出现顺序贪心占用，
 * 每个模型缺陷卡至多命中一条真值卡、每条真值卡至多被一个模型缺陷卡命中；
 * 重复占用条目丢弃并记 anomaly（有界失败，不整单报废）。
 *
 * 置信度门槛语义（MatchConfidenceThreshold）：
 * rank(confidence) ≥ rank(threshold) 才计命中；threshold = "none"（rank 0）复现
 * 官方 llm_evaluator.py 的宽松口径——凡 truth 索引非 null 的条目均计命中（含
 * confidence "none" 的条目），供校准对照用；默认 "low" 即协议语义（none 恒拒绝）。
 */

import type {
  JudgeAdjudication,
  JudgeMatch,
  MatchConfidence,
  MatchConfidenceThreshold,
} from "./contracts.js";
import { DEFAULT_MATCH_CONFIDENCE_THRESHOLD, MATCH_CONFIDENCE_RANK } from "./contracts.js";
import { JudgeClientError } from "./errors.js";

/** 占用解析后的命中对（truthIndex 恒非 null、恒一对一） */
export interface ResolvedMatch {
  readonly findingIndex: number;
  readonly truthIndex: number;
  readonly matchConfidence: MatchConfidence;
  readonly matchReason: string;
}

export interface ResolvedAdjudication {
  /** 命中对（界内、过门槛、一对一占用后幸存） */
  readonly matches: readonly ResolvedMatch[];
  /** 显式/门槛拒绝条目（每 finding 至多记首条：truthIndex null 或 confidence 未过门槛） */
  readonly rejections: readonly JudgeMatch[];
  /** 有界失败留痕：越界索引、重复占用被丢弃的条目等 */
  readonly anomalies: readonly string[];
}

export function resolveAdjudication(
  adjudication: JudgeAdjudication,
  findingCount: number,
  truthCount: number,
  threshold: MatchConfidenceThreshold = DEFAULT_MATCH_CONFIDENCE_THRESHOLD,
): ResolvedAdjudication {
  validateCount(findingCount, "findingCount");
  validateCount(truthCount, "truthCount");
  if (typeof adjudication !== "object" || adjudication === null || !Array.isArray(adjudication.matches)) {
    throw new JudgeClientError("adjudication.matches must be an array of JudgeMatch");
  }
  const claimedFindings = new Set<number>();
  const claimedTruths = new Set<number>();
  const matches: ResolvedMatch[] = [];
  const rejections: JudgeMatch[] = [];
  const rejectedFindings = new Set<number>();
  const anomalies: string[] = [];
  for (const entry of adjudication.matches) {
    resolveEntry(entry, {
      findingCount,
      truthCount,
      threshold,
      claimedFindings,
      claimedTruths,
      rejectedFindings,
      matches,
      rejections,
      anomalies,
    });
  }
  return { matches, rejections, anomalies };
}

interface ResolveState {
  readonly findingCount: number;
  readonly truthCount: number;
  readonly threshold: MatchConfidenceThreshold;
  readonly claimedFindings: Set<number>;
  readonly claimedTruths: Set<number>;
  readonly rejectedFindings: Set<number>;
  readonly matches: ResolvedMatch[];
  readonly rejections: JudgeMatch[];
  readonly anomalies: string[];
}

function resolveEntry(entry: JudgeMatch, state: ResolveState): void {
  if (!Number.isInteger(entry.findingIndex) || entry.findingIndex < 0 || entry.findingIndex >= state.findingCount) {
    state.anomalies.push(
      `dropped match entry with out-of-range finding index ${JSON.stringify(entry.findingIndex)} (findings: 0..${state.findingCount - 1})`,
    );
    return;
  }
  if (
    entry.truthIndex !== null &&
    (!Number.isInteger(entry.truthIndex) || entry.truthIndex < 0 || entry.truthIndex >= state.truthCount)
  ) {
    state.anomalies.push(
      `dropped match entry with out-of-range truth index ${JSON.stringify(entry.truthIndex)} (truths: 0..${state.truthCount - 1})`,
    );
    return;
  }
  if (entry.truthIndex === null || !passesThreshold(entry.matchConfidence, state.threshold)) {
    if (!state.rejectedFindings.has(entry.findingIndex)) {
      state.rejectedFindings.add(entry.findingIndex);
      state.rejections.push(entry);
    }
    return;
  }
  const truthIndex = entry.truthIndex;
  if (state.claimedFindings.has(entry.findingIndex)) {
    state.anomalies.push(
      `dropped duplicate match for model defect index ${entry.findingIndex} (already matched truth ${firstClaimedTruth(state.matches, entry.findingIndex)})`,
    );
    return;
  }
  if (state.claimedTruths.has(truthIndex)) {
    state.anomalies.push(`dropped match entry: truth index ${truthIndex} already claimed one-to-one`);
    return;
  }
  state.claimedFindings.add(entry.findingIndex);
  state.claimedTruths.add(truthIndex);
  state.matches.push({
    findingIndex: entry.findingIndex,
    truthIndex,
    matchConfidence: entry.matchConfidence,
    matchReason: entry.matchReason,
  });
}

/** rank(confidence) ≥ rank(threshold) 计命中；threshold "none"（rank 0）= 官方宽松口径 */
export function passesThreshold(confidence: MatchConfidence, threshold: MatchConfidenceThreshold): boolean {
  return MATCH_CONFIDENCE_RANK[confidence] >= MATCH_CONFIDENCE_RANK[threshold];
}

function firstClaimedTruth(matches: readonly ResolvedMatch[], findingIndex: number): number {
  const claimed = matches.find((match) => match.findingIndex === findingIndex);
  return claimed === undefined ? -1 : claimed.truthIndex;
}

function validateCount(count: number, name: string): void {
  if (!Number.isInteger(count) || count < 0) {
    throw new JudgeClientError(`${name} must be a non-negative integer (got ${JSON.stringify(count)})`);
  }
}
