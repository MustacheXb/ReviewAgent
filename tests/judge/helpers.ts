/** Judge 模块测试工厂：官方线上 JSON 形状（1 起索引）→ 归一裁定 */
import type { JudgeAdjudication, JudgeMatch } from "../../src/judge/contracts.js";

/** 官方线上 match 条目（1 起索引；gt null = 显式拒绝） */
export function wireMatch(args: {
  readonly model: number;
  readonly truth?: number | null;
  readonly confidence?: string;
  readonly reason?: string;
}): Record<string, unknown> {
  return {
    model_defect_index: args.model,
    ground_truth_defect_index: args.truth === undefined ? null : args.truth,
    match_confidence: args.confidence ?? "high",
    match_reason: args.reason ?? "test reason",
  };
}

/** 官方线上裁定 JSON 文本（1 起索引） */
export function wireAdjudicationText(
  matches: readonly Record<string, unknown>[],
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({ matches, unmatched_ground_truth: [], summary: {}, ...extra });
}

/** 归一裁定（0 起索引） */
export function adjudication(matches: readonly JudgeMatch[]): JudgeAdjudication {
  return { matches: [...matches], summary: "test summary" };
}

/** 归一 match 条目（0 起索引） */
export function match(args: {
  readonly finding: number;
  readonly truth: number | null;
  readonly confidence?: JudgeMatch["matchConfidence"];
  readonly reason?: string;
}): JudgeMatch {
  return {
    findingIndex: args.finding,
    truthIndex: args.truth,
    matchConfidence: args.confidence ?? "high",
    matchReason: args.reason ?? "test reason",
  };
}
