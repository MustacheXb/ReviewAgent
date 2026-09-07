/**
 * 判定链编排（Ticket 11 / issue #12）：规则粗筛（T10）→ GPT 系 LLM-as-judge 异构复核
 * → 双口径指标（规则口径 / judge 口径），复核后的计数经 T10 纯函数重算
 * （computePRF / computeEfficiencyMetrics，即「judge 裁定结果可回填 Metrics 计算管线」）。
 *
 * 复核语义（LLM-Hit-Judge 协议）：
 * - judge 拿全量 Finding 卡 × 真值卡 + MR 上下文，做一对一语义匹配；
 * - 命中（confidence ≥ 门槛）→ judge 口径 TP；未命中 → FP
 *   （规则 TP 被推翻记 JUDGE_REJECTED；规则 FP 获显式拒绝条目记 JUDGE_REJECTED、
 *   无条目记 JUDGE_NO_MATCH）；未被命中的真值 → FN；
 * - 与规则口径的逐 Finding 结论差异记 disagreement（TP_OVERTURNED / FP_RESCUED），
 *   供 10% 人工抽检分层抽样（src/sampling）。
 *
 * 有界失败纪律（不崩溃）：
 * - clean MR（truth = null）与零 finding：匹配平凡，不调用 judge（与官方脚本同口径）；
 * - judge 调用异常（网络 / 响应格式）：status = "error"，judge 口径回退规则口径，
 *   错误信息经脱敏记录；
 * - judge 输出越界 / 重复占用条目：丢弃并记 anomaly，不整单报废。
 */

import type { ConfigId } from "../contracts/config.js";
import { CONFIGS } from "../contracts/config.js";
import type { Finding } from "../contracts/finding.js";
import type { MRCase, MRTruth, TruthLocation } from "../contracts/mr-case.js";
import type { RunResult } from "../contracts/run.js";
import {
  computeEfficiencyMetrics,
  computePRF,
  computeTokenMetrics,
  computeToolCostTokens,
  normalizeFilePath,
  screenFindings,
} from "../metrics/index.js";
import type {
  EfficiencyMetrics,
  FindingVerdict,
  FpReason,
  PRFMetrics,
  ScreeningCounts,
  ScreeningOptions,
  TokenMetrics,
  ToolCostPricing,
  TruthMiss,
} from "../metrics/types.js";
import { DEFAULT_SCREENING_OPTIONS, DEFAULT_TOOL_COST_PRICING } from "../metrics/types.js";
import type {
  JudgeClient,
  JudgeRequest,
  MatchConfidence,
  MatchConfidenceThreshold,
} from "./contracts.js";
import {
  DEFAULT_MATCH_CONFIDENCE_THRESHOLD,
  findingToCard,
  truthToCards,
} from "./contracts.js";
import { resolveAdjudication } from "./resolve.js";
import type { ResolvedAdjudication } from "./resolve.js";

/** judge 口径的 FP 归因（T10 词表 + judge 专属两条） */
export type JudgeFpReason = FpReason | "JUDGE_REJECTED" | "JUDGE_NO_MATCH";

/** 单条 Finding 的 judge 口径判定（含规则口径对照） */
export interface JudgeFindingVerdict {
  readonly findingId: string;
  readonly outcome: "TP" | "FP";
  readonly matchedTruthIndex: number | null;
  /** TP：finding.line 相对真值区间的行位偏差（0 = 区间内）；FP 为 null */
  readonly lineOffset: number | null;
  readonly matchConfidence: MatchConfidence | null;
  readonly judgeReason: string | null;
  readonly ruleOutcome: "TP" | "FP";
  readonly fpReason: JudgeFpReason | null;
}

/** 规则口径与 judge 口径的逐 Finding 结论差异 */
export interface JudgeDisagreement {
  readonly findingId: string;
  readonly truthIndex: number | null;
  readonly ruleOutcome: "TP" | "FP";
  readonly judgeOutcome: "TP" | "FP";
  /** TP_OVERTURNED：规则 TP 被 judge 推翻；FP_RESCUED：规则 FP 被 judge 救回 */
  readonly kind: "TP_OVERTURNED" | "FP_RESCUED";
}

export type JudgeRunStatus =
  /** judge 复核完成 */
  | "judged"
  /** clean MR（truth = null）：FP 为定义性结论，不经过 judge */
  | "skipped-clean-mr"
  /** 零 finding：匹配平凡为空、FN 全量，不经过 judge */
  | "skipped-no-findings"
  /** judge 调用失败：judge 口径回退规则口径（有界失败） */
  | "error";

/** 单次 Run 的判定链结果（双口径） */
export interface JudgeRunResult {
  readonly caseId: string;
  readonly configId: ConfigId;
  /** 重复运行序（0 起，rep1 = 0）；单次调用为 null，judgeEvaluations 会回填 */
  readonly repIndex: number | null;
  readonly status: JudgeRunStatus;
  readonly errorMessage: string | null;
  readonly anomalies: readonly string[];
  readonly judgeVerdicts: readonly JudgeFindingVerdict[];
  readonly judgeMisses: readonly TruthMiss[];
  readonly judgeCounts: ScreeningCounts;
  readonly judgePrf: PRFMetrics;
  readonly judgeEfficiency: EfficiencyMetrics;
  readonly ruleCounts: ScreeningCounts;
  readonly rulePrf: PRFMetrics;
  readonly ruleEfficiency: EfficiencyMetrics;
  readonly tokens: TokenMetrics;
  readonly toolCostTokens: number;
  readonly toolCalls: number;
  readonly rounds: number;
  readonly disagreements: readonly JudgeDisagreement[];
}

export interface JudgeChainOptions {
  /** 规则粗筛口径（缺省 DEFAULT_SCREENING_OPTIONS） */
  readonly screening?: ScreeningOptions;
  /** 工具成本计价（缺省 DEFAULT_TOOL_COST_PRICING） */
  readonly toolCost?: ToolCostPricing;
  /** 匹配置信度门槛（缺省 "low"：none 恒拒绝；提示词截断上限经 JudgeClient 构造参数注入） */
  readonly matchConfidenceThreshold?: MatchConfidenceThreshold;
}

interface ResolvedChainOptions {
  readonly screening: ScreeningOptions;
  readonly toolCost: ToolCostPricing;
  readonly matchConfidenceThreshold: MatchConfidenceThreshold;
}

/** 判定链主入口：单次 Run 的 规则粗筛 → judge 复核 → 双口径结果 */
export async function judgeRun(
  run: RunResult,
  mrCase: MRCase,
  judgeClient: JudgeClient,
  options: JudgeChainOptions = {},
): Promise<JudgeRunResult> {
  const resolved = resolveChainOptions(options);
  validateJudgeRunInputs(run, mrCase);
  const configId = narrowMainConfigId(run);
  const ruleScreening = screenFindings(run.findings, mrCase.truth, resolved.screening);
  const tokens = computeTokenMetrics(run.usage);
  const toolCostTokens = computeToolCostTokens(run, resolved.toolCost);
  const rulePrf = computePRF(ruleScreening.lineLevel);
  const ruleEfficiency = computeEfficiencyMetrics({ lineLevel: rulePrf, tokens, toolCostTokens });
  const base = {
    caseId: run.caseId,
    configId,
    repIndex: null,
    tokens,
    toolCostTokens,
    toolCalls: run.toolCalls,
    rounds: run.rounds,
    ruleCounts: ruleScreening.lineLevel,
    rulePrf,
    ruleEfficiency,
  };
  if (mrCase.truth === null) {
    return {
      ...base,
      status: "skipped-clean-mr",
      errorMessage: null,
      anomalies: [],
      judgeVerdicts: ruleScreening.verdicts.map(fromRuleVerdict),
      judgeMisses: [],
      judgeCounts: ruleScreening.lineLevel,
      judgePrf: rulePrf,
      judgeEfficiency: ruleEfficiency,
      disagreements: [],
    };
  }
  if (run.findings.length === 0) {
    const misses = allMisses(mrCase.truth.locations);
    const counts: ScreeningCounts = { tp: 0, fp: 0, fn: misses.length };
    const prf = computePRF(counts);
    return {
      ...base,
      status: "skipped-no-findings",
      errorMessage: null,
      anomalies: [],
      judgeVerdicts: [],
      judgeMisses: misses,
      judgeCounts: counts,
      judgePrf: prf,
      judgeEfficiency: computeEfficiencyMetrics({ lineLevel: prf, tokens, toolCostTokens }),
      disagreements: [],
    };
  }
  return judgeWithFallback(run, mrCase, judgeClient, resolved, {
    base,
    ruleVerdicts: ruleScreening.verdicts,
  });
}

async function judgeWithFallback(
  run: RunResult,
  mrCase: MRCase,
  judgeClient: JudgeClient,
  resolved: ResolvedChainOptions,
  context: {
    readonly base: Omit<JudgeRunResult, "status" | "errorMessage" | "anomalies" | "judgeVerdicts" | "judgeMisses" | "judgeCounts" | "judgePrf" | "judgeEfficiency" | "disagreements">;
    readonly ruleVerdicts: readonly FindingVerdict[];
  },
): Promise<JudgeRunResult> {
  const { base, ruleVerdicts } = context;
  const truth = mrCase.truth as MRTruth;
  let adjudication;
  try {
    adjudication = await judgeClient.adjudicate(buildJudgeRequest(run.caseId, run.findings, mrCase));
  } catch (error) {
    return {
      ...base,
      status: "error",
      errorMessage: `judge client failed; judge metrics fell back to the rule screening verdicts: ${redactSecrets(errorMessage(error))}`,
      anomalies: [],
      judgeVerdicts: ruleVerdicts.map(fromRuleVerdict),
      judgeMisses: screenMissesOf(truth, ruleVerdicts),
      judgeCounts: base.ruleCounts,
      judgePrf: base.rulePrf,
      judgeEfficiency: base.ruleEfficiency,
      disagreements: [],
    };
  }
  const resolution = resolveAdjudication(
    adjudication,
    run.findings.length,
    truth.locations.length,
    resolved.matchConfidenceThreshold,
  );
  const counts = judgeCounts(run.findings.length, truth.locations.length, resolution);
  const judgePrf = computePRF(counts);
  return {
    ...base,
    status: "judged",
    errorMessage: null,
    anomalies: resolution.anomalies,
    judgeVerdicts: mergeVerdicts(run.findings, truth.locations, ruleVerdicts, resolution),
    judgeMisses: judgeMisses(truth.locations, resolution),
    judgeCounts: counts,
    judgePrf,
    judgeEfficiency: computeEfficiencyMetrics({
      lineLevel: judgePrf,
      tokens: base.tokens,
      toolCostTokens: base.toolCostTokens,
    }),
    disagreements: collectDisagreements(run.findings, ruleVerdicts, resolution),
  };
}

function judgeCounts(
  findingCount: number,
  truthCount: number,
  resolution: ResolvedAdjudication,
): ScreeningCounts {
  return {
    tp: resolution.matches.length,
    fp: findingCount - resolution.matches.length,
    fn: truthCount - resolution.matches.length,
  };
}

function mergeVerdicts(
  findings: readonly Finding[],
  truthLocations: readonly TruthLocation[],
  ruleVerdicts: readonly FindingVerdict[],
  resolution: ResolvedAdjudication,
): readonly JudgeFindingVerdict[] {
  const matchByFinding = new Map(resolution.matches.map((match) => [match.findingIndex, match]));
  const rejectionByFinding = new Map(resolution.rejections.map((rejection) => [rejection.findingIndex, rejection]));
  return findings.map((finding, index) => {
    const rule = ruleVerdicts[index];
    const ruleOutcome = rule === undefined ? "FP" : rule.outcome;
    const match = matchByFinding.get(index);
    if (match !== undefined) {
      const location = truthLocations[match.truthIndex];
      return {
        findingId: finding.id,
        outcome: "TP" as const,
        matchedTruthIndex: match.truthIndex,
        lineOffset: location === undefined ? null : lineOffsetOf(finding.line, location),
        matchConfidence: match.matchConfidence,
        judgeReason: match.matchReason,
        ruleOutcome,
        fpReason: null,
      };
    }
    const rejection = rejectionByFinding.get(index);
    return {
      findingId: finding.id,
      outcome: "FP" as const,
      matchedTruthIndex: null,
      lineOffset: null,
      matchConfidence: rejection === undefined ? null : rejection.matchConfidence,
      judgeReason: rejection === undefined ? null : rejection.matchReason,
      ruleOutcome,
      fpReason: ruleOutcome === "TP" || rejection !== undefined ? "JUDGE_REJECTED" : "JUDGE_NO_MATCH",
    };
  });
}

function judgeMisses(
  truthLocations: readonly TruthLocation[],
  resolution: ResolvedAdjudication,
): readonly TruthMiss[] {
  const claimed = new Set(resolution.matches.map((match) => match.truthIndex));
  return truthLocations.flatMap((location, index) =>
    claimed.has(index)
      ? []
      : [
          {
            truthIndex: index,
            file: normalizeFilePath(location.file),
            lineStart: location.lineStart,
            lineEnd: location.lineEnd,
            defectNature: location.defectNature,
          },
        ],
  );
}

function collectDisagreements(
  findings: readonly Finding[],
  ruleVerdicts: readonly FindingVerdict[],
  resolution: ResolvedAdjudication,
): readonly JudgeDisagreement[] {
  const matchByFinding = new Map(resolution.matches.map((match) => [match.findingIndex, match]));
  const disagreements: JudgeDisagreement[] = [];
  findings.forEach((finding, index) => {
    const rule = ruleVerdicts[index];
    const ruleOutcome = rule === undefined ? "FP" : rule.outcome;
    const match = matchByFinding.get(index);
    const judgeOutcome = match === undefined ? "FP" : "TP";
    if (ruleOutcome === judgeOutcome) {
      return;
    }
    disagreements.push({
      findingId: finding.id,
      truthIndex: match === undefined ? null : match.truthIndex,
      ruleOutcome,
      judgeOutcome,
      kind: ruleOutcome === "TP" ? "TP_OVERTURNED" : "FP_RESCUED",
    });
  });
  return disagreements;
}

function fromRuleVerdict(verdict: FindingVerdict): JudgeFindingVerdict {
  return {
    findingId: verdict.findingId,
    outcome: verdict.outcome,
    matchedTruthIndex: verdict.matchedTruthIndex,
    lineOffset: verdict.lineOffset,
    matchConfidence: null,
    judgeReason: null,
    ruleOutcome: verdict.outcome,
    fpReason: verdict.fpReason,
  };
}

function allMisses(truthLocations: readonly TruthLocation[]): readonly TruthMiss[] {
  return truthLocations.map((location, index) => ({
    truthIndex: index,
    file: normalizeFilePath(location.file),
    lineStart: location.lineStart,
    lineEnd: location.lineEnd,
    defectNature: location.defectNature,
  }));
}

/** FN 清单 = 真值位置 − 规则 TP 占用（回退口径下与规则粗筛一致） */
function screenMissesOf(
  truth: MRTruth,
  ruleVerdicts: readonly FindingVerdict[],
): readonly TruthMiss[] {
  const matched = new Set(
    ruleVerdicts
      .map((verdict) => verdict.matchedTruthIndex)
      .filter((index): index is number => index !== null),
  );
  return truth.locations.flatMap((location, index) =>
    matched.has(index)
      ? []
      : [
          {
            truthIndex: index,
            file: normalizeFilePath(location.file),
            lineStart: location.lineStart,
            lineEnd: location.lineEnd,
            defectNature: location.defectNature,
          },
        ],
  );
}

function buildJudgeRequest(
  caseId: string,
  findings: readonly Finding[],
  mrCase: MRCase,
): JudgeRequest {
  const truth = mrCase.truth as MRTruth;
  return {
    caseId,
    findings: findings.map(findingToCard),
    truths: truthToCards(truth),
    context: {
      issueDescription: mrCase.issueDescription,
      diff: mrCase.diff,
      fixPatch: truth.fixPatch,
    },
  };
}

function lineOffsetOf(line: number, location: TruthLocation): number {
  if (line < location.lineStart) {
    return location.lineStart - line;
  }
  if (line > location.lineEnd) {
    return line - location.lineEnd;
  }
  return 0;
}

function resolveChainOptions(options: JudgeChainOptions): ResolvedChainOptions {
  return {
    screening: options.screening ?? DEFAULT_SCREENING_OPTIONS,
    toolCost: options.toolCost ?? DEFAULT_TOOL_COST_PRICING,
    matchConfidenceThreshold: options.matchConfidenceThreshold ?? DEFAULT_MATCH_CONFIDENCE_THRESHOLD,
  };
}

function validateJudgeRunInputs(run: RunResult, mrCase: MRCase): void {
  if (typeof run !== "object" || run === null) {
    throw new Error("run must be a RunResult object");
  }
  if (typeof run.caseId !== "string" || run.caseId.length === 0) {
    throw new Error("run.caseId must be a non-empty string");
  }
  if (run.caseId !== mrCase.caseId) {
    throw new Error(`run.caseId "${run.caseId}" does not match mrCase.caseId "${mrCase.caseId}"`);
  }
  const configIds = new Set<string>(Object.keys(CONFIGS));
  if (typeof run.configId !== "string" || !configIds.has(run.configId)) {
    throw new Error(`run.configId must be one of "A"-"E" (got ${JSON.stringify(run.configId)})`);
  }
}

/**
 * 窄化辅助：RunResult.configId 自 T13 起放宽为 MetricsConfigId（外部参照列
 * 走同一 metrics 管线），但 judge 链只消费 A–E 主矩阵——validateJudgeRunInputs
 * 已拒绝 A–E 之外的取值，此处仅做类型窄化（无运行时语义）。
 */
function narrowMainConfigId(run: RunResult): ConfigId {
  return run.configId as ConfigId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 错误信息脱敏：环境变量中的 API key 一律替换为 [REDACTED]（防异常文本携带密钥） */
function redactSecrets(message: string): string {
  let redacted = message;
  for (const secret of [process.env.OPENAI_API_KEY, process.env.DEEPSEEK_API_KEY]) {
    if (typeof secret === "string" && secret.trim().length > 0) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
  }
  return redacted;
}
