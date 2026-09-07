/**
 * 10% 人工抽检：抽样单元构建 + 抽检表单（Ticket 11 / issue #12）。
 *
 * 抽样协议（docs/human-review-sampling-protocol.md 为权威文档，此处为实现）：
 * 1. 单元 = 一次检视运行（caseId × configId × rep）；键 = `${caseId}:${configId}:rep${n}`；
 * 2. 分层 = 判定链分歧（disagreement 层，规则口径与 judge 口径结论不同的运行）
 *    vs 一致层（agreement 层）；无 judge 结果的运行落 no-judge 层；
 *    分层保证稀有层不被 10% 均匀抽样稀释（每层 ceil(n × 10%) ≥ 1）；
 * 3. 选择 = sampler.ts 的 FNV-1a 种子哈希排序取前 k（同 seed 同样本，与输入顺序无关）；
 * 4. 表单 = 每个入选单元一份 HumanReviewForm（逐 Finding/漏检条目列出规则口径与
 *    judge 口径对照 + 判定材料），人工填写 HumanVerdictSubmission 后经
 *    validateHumanVerdictSubmission 校验（边界输入显式报错清单）。
 *
 * 本模块不实现人工评审本身（spec 范围外）：只产出确定性队列与表单格式。
 */

import type { ConfigId } from "../contracts/config.js";
import { CONFIGS } from "../contracts/config.js";
import type { Finding } from "../contracts/finding.js";
import type { EvaluationInput } from "../metrics/types.js";
import type { MRCase, TruthLocation } from "../contracts/mr-case.js";
import type { RunResult } from "../contracts/run.js";
import type { JudgeRunResult } from "../judge/orchestrate.js";
import { sampleUnits } from "./sampler.js";
import type { SamplingOptions, SamplingPlan } from "./sampler.js";

export const HUMAN_REVIEW_PROTOCOL_VERSION = "1";
export const DEFAULT_HUMAN_REVIEW_RATE = 0.1;

/** 人工抽检单元：一次检视运行 + 其判定链结果（供分层与表单渲染） */
export interface ReviewUnit {
  readonly key: string;
  readonly stratum: string;
  readonly caseId: string;
  readonly configId: ConfigId;
  /** 重复运行序（0 起，rep1 = 0） */
  readonly repIndex: number;
  readonly run: RunResult;
  readonly mrCase: MRCase;
  readonly judgeResult: JudgeRunResult | null;
}

/** 抽检表单的单个裁定条目（人工裁决的对象） */
export interface HumanReviewItem {
  /** FINDING = 对一条 Finding 的 TP/FP 裁决；MISSED_TRUTH = 对一条漏检的 FN 确认 */
  readonly kind: "FINDING" | "MISSED_TRUTH";
  readonly findingId: string | null;
  readonly truthIndex: number | null;
  readonly finding: Finding | null;
  readonly truth: TruthLocation | null;
  /** 规则粗筛口径（TP/FP；MISSED_TRUTH 恒 FP 视角缺失，此字段 null） */
  readonly ruleOutcome: "TP" | "FP" | null;
  /** judge 口径（TP/FP；MISSED_TRUTH 恒 FP 视角缺失，此字段 null） */
  readonly judgeOutcome: "TP" | "FP" | null;
  readonly judgeReason: string | null;
  readonly disagreement: boolean;
}

/** 一份人工抽检表单（一个人工抽检单元的完整裁决材料） */
export interface HumanReviewForm {
  readonly protocolVersion: string;
  readonly unitKey: string;
  readonly caseId: string;
  readonly configId: ConfigId;
  readonly repIndex: number;
  readonly seed: string;
  readonly mr: {
    readonly diff: string;
    readonly issueDescription: string;
    readonly truthLocations: readonly TruthLocation[] | null;
    readonly fixPatch: string | null;
  };
  readonly items: readonly HumanReviewItem[];
}

/** 人工裁定提交（人工评审的回填格式；kind 决定合法 verdict 词表） */
export interface HumanVerdictEntry {
  /** FINDING 条目 = findingId；MISSED_TRUTH 条目 = `miss:${truthIndex}` */
  readonly itemId: string;
  readonly verdict: "TP" | "FP" | "FN";
  readonly comment: string | null;
}

export interface HumanVerdictSubmission {
  readonly unitKey: string;
  readonly verdicts: readonly HumanVerdictEntry[];
}

/** 从评估输入构建抽检单元群（judge 结果按 caseId:configId:repIndex 精确对齐） */
export function buildReviewUnits(
  evaluations: readonly EvaluationInput[],
  judgeResults: readonly JudgeRunResult[] = [],
): readonly ReviewUnit[] {
  if (!Array.isArray(evaluations)) {
    throw new Error("evaluations must be an array of EvaluationInput");
  }
  const judgeByKey = new Map(
    judgeResults.map((result) => [unitKey(result.caseId, result.configId, result.repIndex), result]),
  );
  const units: ReviewUnit[] = [];
  const configIds = Object.keys(CONFIGS) as ConfigId[];
  for (const evaluation of evaluations) {
    for (const configId of configIds) {
      const runs = evaluation.runsByConfig[configId];
      if (runs === undefined) {
        continue;
      }
      for (const [repIndex, run] of runs.entries()) {
        const key = unitKey(evaluation.mrCase.caseId, configId, repIndex);
        const judgeResult = judgeByKey.get(key) ?? null;
        units.push({
          key,
          stratum: stratumOf(judgeResult),
          caseId: evaluation.mrCase.caseId,
          configId,
          repIndex,
          run,
          mrCase: evaluation.mrCase,
          judgeResult,
        });
      }
    }
  }
  return units;
}

/** 10% 人工抽检计划（确定性种子抽样；rate 可覆盖，缺省 0.1） */
export function buildSamplingPlan(
  units: readonly ReviewUnit[],
  options: { readonly seed: string; readonly rate?: number },
): SamplingPlan<ReviewUnit> {
  return sampleUnits(units, {
    seed: options.seed,
    rate: options.rate ?? DEFAULT_HUMAN_REVIEW_RATE,
  });
}

/** 入选单元 → 抽检表单（每单元一份；含全部 Finding 裁定条目与漏检确认条目） */
export function buildHumanReviewForms(
  plan: SamplingPlan<ReviewUnit>,
): readonly HumanReviewForm[] {
  return plan.selected.map((unit) => ({
    protocolVersion: HUMAN_REVIEW_PROTOCOL_VERSION,
    unitKey: unit.key,
    caseId: unit.caseId,
    configId: unit.configId,
    repIndex: unit.repIndex,
    seed: plan.seed,
    mr: {
      diff: unit.mrCase.diff,
      issueDescription: unit.mrCase.issueDescription,
      truthLocations: unit.mrCase.truth === null ? null : unit.mrCase.truth.locations,
      fixPatch: unit.mrCase.truth === null ? null : unit.mrCase.truth.fixPatch,
    },
    items: buildItems(unit),
  }));
}

/** 人工裁定提交的边界校验（返回错误清单；空数组 = 合法） */
export function validateHumanVerdictSubmission(
  form: HumanReviewForm,
  submission: HumanVerdictSubmission,
): readonly string[] {
  const errors: string[] = [];
  if (typeof submission !== "object" || submission === null) {
    return ["submission must be a HumanVerdictSubmission object"];
  }
  if (submission.unitKey !== form.unitKey) {
    errors.push(
      `submission.unitKey "${submission.unitKey}" does not match the form unitKey "${form.unitKey}"`,
    );
  }
  if (!Array.isArray(submission.verdicts)) {
    return [...errors, "submission.verdicts must be an array of HumanVerdictEntry"];
  }
  const expectedIds = new Set(form.items.map((item) => itemIdOf(item)));
  const seen = new Set<string>();
  for (const [index, entry] of submission.verdicts.entries()) {
    const item = form.items.find((candidate) => itemIdOf(candidate) === entry?.itemId);
    if (item === undefined) {
      errors.push(`submission.verdicts[${index}].itemId "${entry?.itemId}" does not exist in the form`);
      continue;
    }
    if (seen.has(entry.itemId)) {
      errors.push(`submission.verdicts[${index}].itemId "${entry.itemId}" is duplicated`);
    }
    seen.add(entry.itemId);
    if (!VERDICTS_BY_KIND[item.kind].includes(entry.verdict)) {
      errors.push(
        `submission.verdicts[${index}].verdict "${entry.verdict}" is invalid for ${item.kind} items (allowed: ${VERDICTS_BY_KIND[item.kind].join("/")})`,
      );
    }
    if (entry.comment !== null && typeof entry.comment !== "string") {
      errors.push(`submission.verdicts[${index}].comment must be a string or null`);
    }
  }
  for (const expected of expectedIds) {
    if (!seen.has(expected)) {
      errors.push(`form item "${expected}" has no human verdict (complete coverage required)`);
    }
  }
  return errors;
}

/** FINDING 条目允许 TP/FP；MISSED_TRUTH 条目允许 FN（确认漏检）/ TP（判定链误判漏检） */
const VERDICTS_BY_KIND: Readonly<Record<HumanReviewItem["kind"], readonly string[]>> = {
  FINDING: ["TP", "FP"],
  MISSED_TRUTH: ["FN", "TP"],
};

function buildItems(unit: ReviewUnit): readonly HumanReviewItem[] {
  const ruleOutcomeByFindingId = ruleOutcomes(unit.judgeResult);
  const judgeOutcomeByFindingId = judgeOutcomes(unit.judgeResult);
  const findingItems = unit.run.findings.map((finding) => {
    const judgeOutcome = judgeOutcomeByFindingId.get(finding.id);
    const ruleOutcome = ruleOutcomeByFindingId.get(finding.id);
    const judgeVerdict = unit.judgeResult?.judgeVerdicts.find(
      (verdict) => verdict.findingId === finding.id,
    );
    return {
      kind: "FINDING" as const,
      findingId: finding.id,
      truthIndex: judgeVerdict?.matchedTruthIndex ?? null,
      finding,
      truth: null,
      ruleOutcome: ruleOutcome ?? null,
      judgeOutcome: judgeOutcome ?? null,
      judgeReason: judgeVerdict?.judgeReason ?? null,
      disagreement: ruleOutcome !== undefined && judgeOutcome !== undefined && ruleOutcome !== judgeOutcome,
    };
  });
  const missItems = (unit.judgeResult?.judgeMisses ?? []).map((miss) => ({
    kind: "MISSED_TRUTH" as const,
    findingId: null,
    truthIndex: miss.truthIndex,
    finding: null,
    truth: unit.mrCase.truth?.locations[miss.truthIndex] ?? null,
    ruleOutcome: null,
    judgeOutcome: null,
    judgeReason: null,
    disagreement: false,
  }));
  return [...findingItems, ...missItems];
}

/** 规则口径对照：优先 judge 结果内嵌的 ruleOutcome；无 judge 结果时按粗筛口径重算视角缺省 null */
function ruleOutcomes(judgeResult: JudgeRunResult | null): ReadonlyMap<string, "TP" | "FP"> {
  if (judgeResult === null) {
    return new Map();
  }
  return new Map(judgeResult.judgeVerdicts.map((verdict) => [verdict.findingId, verdict.ruleOutcome]));
}

function judgeOutcomes(judgeResult: JudgeRunResult | null): ReadonlyMap<string, "TP" | "FP"> {
  if (judgeResult === null) {
    return new Map();
  }
  return new Map(judgeResult.judgeVerdicts.map((verdict) => [verdict.findingId, verdict.outcome]));
}

function stratumOf(judgeResult: JudgeRunResult | null): string {
  if (judgeResult === null) {
    return "no-judge";
  }
  return judgeResult.disagreements.length > 0 ? "disagreement" : "agreement";
}

export function unitKey(caseId: string, configId: ConfigId, repIndex: number | null): string {
  return `${caseId}:${configId}:rep${(repIndex ?? 0) + 1}`;
}

function itemIdOf(item: HumanReviewItem): string {
  return item.kind === "FINDING" ? (item.findingId ?? "") : `miss:${item.truthIndex}`;
}
