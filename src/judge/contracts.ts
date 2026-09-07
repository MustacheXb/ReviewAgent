/**
 * Judge 契约（Ticket 11 / issue #12）——判定链第二级：
 * 原生真值 → 规则粗筛（T10）→ 【GPT 系 LLM-as-judge】→ 10% 人工抽检。
 *
 * 协议来源：MCR-Bench 的 LLM-Hit-Judge（ISSTA 2026，arXiv 2608.27442；
 * 官方 evaluation/Metric/prompt_builder.py + llm_evaluator.py，2026-09-03 逐字核验）：
 * - 任务：模型输出缺陷 × 真值缺陷的一对一语义匹配（核心判据「是否描述同一底层代码问题」）；
 * - 输出 JSON：matches[{model_defect_index, ground_truth_defect_index, match_confidence,
 *   match_reason}] + unmatched_ground_truth + summary，索引 1 起、confidence ∈
 *   high/medium/low/none（none = 已考虑但不匹配，即显式 reject + 理由）；
 * - 计分：未匹配的模型输出 = FP、未匹配的真值 = FN → P/R/F1；
 * - judge 参数：temperature 0.2、top_p 0.95。
 *
 * 本模块类型为协议归一层（0 起索引、结构化 TS 形状）；
 * prompt.ts 按官方格式渲染（1 起索引），parse.ts 负责归一。
 */

import type { Finding } from "../contracts/finding.js";
import type { MRTruth } from "../contracts/mr-case.js";

/** 匹配置信度（官方词表；"none" = 已考虑并拒绝，附拒绝理由） */
export type MatchConfidence = "high" | "medium" | "low" | "none";

export const MATCH_CONFIDENCE_RANK: Readonly<Record<MatchConfidence, number>> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

/**
 * 置信度门槛：≥ 门槛的 match 条目计为命中。
 * - "low"（默认）：low/medium/high 均命中，"none" 恒拒绝；
 * - "medium"/"high"：收紧命中口径；
 * - "none"：官方脚本宽松口径——凡 truth 索引非 null 的条目均计命中（忽略 confidence）。
 */
export type MatchConfidenceThreshold = "none" | "low" | "medium" | "high";

export const DEFAULT_MATCH_CONFIDENCE_THRESHOLD: MatchConfidenceThreshold = "low";

/** 单条模型输出缺陷卡（judge 的一侧输入；字段缺失用 null，不参与渲染） */
export interface JudgeFindingCard {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** 所在文件；null = 未给出 */
  readonly file: string | null;
  /** 行号；null = 未给出 */
  readonly line: number | null;
  /** 类别（Finding.category / MCR taxonomy）；null = 未给出 */
  readonly category: string | null;
  /** 证据摘录（可选，逐条有界） */
  readonly evidence: readonly string[];
}

/** 单条真值缺陷卡（judge 的另一侧输入） */
export interface JudgeTruthCard {
  readonly id: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly file: string | null;
  readonly lineStart: number | null;
  readonly lineEnd: number | null;
  /** 性质类别（TruthLocation.defectNature / MCR taxonomy）；null = 未给出 */
  readonly category: string | null;
  /** 严重级（仅 MCR 缺陷卡有）；null = 未给出 */
  readonly severity: string | null;
}

/** MR 上下文（POC1 判定链模式提供；MCR 校准模式为 null 以保持与官方 judge 同信息面） */
export interface JudgeMrContext {
  readonly issueDescription: string;
  readonly diff: string;
  /** 最小修复补丁（逆补丁法真值的缺陷身份说明）；null = 无 */
  readonly fixPatch: string | null;
}

/** JudgeClient 请求：卡片集合 + 可选 MR 上下文 */
export interface JudgeRequest {
  readonly caseId: string;
  readonly findings: readonly JudgeFindingCard[];
  readonly truths: readonly JudgeTruthCard[];
  readonly context: JudgeMrContext | null;
}

/** 归一后的单条匹配裁定（0 起索引；truthIndex null = 显式拒绝） */
export interface JudgeMatch {
  readonly findingIndex: number;
  /** 命中的真值卡下标（0 起）；null = 该条为拒绝条目（confidence 应为 "none"） */
  readonly truthIndex: number | null;
  readonly matchConfidence: MatchConfidence;
  readonly matchReason: string;
}

/** JudgeClient 输出：归一后的裁定（一对一约束由 resolveAdjudication 强制） */
export interface JudgeAdjudication {
  readonly matches: readonly JudgeMatch[];
  readonly summary: string | null;
}

/**
 * LLM-as-judge 客户端边界（spec #1 Testing Decisions：「LLM judge 在其后的
 * 独立 client 边界，复用同一 fake 模式」）。实现：
 * - GptJudgeClient（src/judge/gpt-judge-client.ts，OpenAI 兼容真实客户端）；
 * - FakeJudgeClient（src/judge/fake-judge-client.ts，脚本化 + 请求捕获）。
 */
export interface JudgeClient {
  adjudicate(request: JudgeRequest): Promise<JudgeAdjudication>;
}

/** 提示词上下文截断上限（有界输入；截断处内联 "[truncated]" 标记） */
export interface JudgeContextLimits {
  readonly maxDiffChars: number;
  readonly maxIssueDescriptionChars: number;
  readonly maxFixPatchChars: number;
  readonly maxTitleChars: number;
  readonly maxDescriptionChars: number;
  readonly maxEvidenceEntries: number;
  readonly maxEvidenceCharsPerEntry: number;
}

export const DEFAULT_JUDGE_CONTEXT_LIMITS: JudgeContextLimits = {
  // MR 边界 ≤10 文件 / diff ≤2K 行（spec #1 user story 23），2K 行 diff 约 60K 字符
  maxDiffChars: 60_000,
  maxIssueDescriptionChars: 8_000,
  maxFixPatchChars: 8_000,
  maxTitleChars: 500,
  maxDescriptionChars: 4_000,
  maxEvidenceEntries: 3,
  maxEvidenceCharsPerEntry: 400,
};

/** Finding → 缺陷卡（POC1 判定链模式） */
export function findingToCard(finding: Finding): JudgeFindingCard {
  return {
    id: finding.id,
    title: finding.title,
    description: finding.description,
    file: finding.file,
    line: finding.line,
    category: finding.category,
    evidence: [...finding.evidence],
  };
}

/** MRTruth → 真值卡列表（逆补丁法真值：位置 + 性质；缺陷身份经 fixPatch 表达） */
export function truthToCards(truth: MRTruth): readonly JudgeTruthCard[] {
  return truth.locations.map((location, index) => ({
    id: `TRUTH-${index + 1}`,
    title: null,
    description: null,
    file: location.file,
    lineStart: location.lineStart,
    lineEnd: location.lineEnd,
    category: location.defectNature,
    severity: null,
  }));
}
