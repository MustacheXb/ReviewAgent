import type { ConfigId } from "../contracts/config.js";
import { CONFIGS } from "../contracts/config.js";
import type { MRCase } from "../contracts/mr-case.js";

/**
 * 实验计划（Ticket 12 / issue #13）：五配置 × 数据集 × 重复 的可编排放跑参数。
 *
 * 成本纪律（spec #1）：全量实验花真钱——计划显式携带 子集/限量（sources /
 * perSourceLimit / caseFilter / highRiskOnly）、配置过滤（configs）与消融开关
 * （verifier / model），断点续跑由运行器按 (source, caseId, configId, rep) 落盘实现。
 */

/** 四个数据源的规范名（与 MRCase.labels.source 的词表一致） */
export const EXPERIMENT_SOURCES = ["defects4j", "vul4j", "msb-java", "clean-mr"] as const;
export type ExperimentSource = (typeof EXPERIMENT_SOURCES)[number];

/**
 * 可编排放跑的模型（ADR-0002 主力锁定 deepseek-v4-flash；
 * deepseek-v4-pro 仅用于高险子集升级消融，spec #1 user story 15）。
 */
export const EXPERIMENT_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"] as const;
export type ExperimentModel = (typeof EXPERIMENT_MODELS)[number];

export const DEFAULT_EXPERIMENT_MODEL: ExperimentModel = "deepseek-v4-flash";

/** 二遍 Verifier 消融开关：off = 单遍自证（底线形态）；on = 二遍复核（token 计入 CARC） */
export type VerifierMode = "off" | "on";

/** 人工抽检种子（每轮基准固定并记录；缺省值即当前轮基准） */
export const DEFAULT_HUMAN_REVIEW_SEED = "poc1-human-review-2026";
export const DEFAULT_HUMAN_REVIEW_RATE = 0.1;
export const DEFAULT_REPS = 3;

export interface ExperimentPlan {
  /** 实验标识（runs/<experimentId>/ 的目录名） */
  readonly experimentId: string;
  /** 参与的数据源（非空子集） */
  readonly sources: readonly ExperimentSource[];
  /** 配置过滤（A–E 的非空子集；与每个 case 的 labels.allowedConfigs 求交） */
  readonly configs: readonly ConfigId[];
  /** 每条 MR 的重复运行次数（rep1 冷 / rep2+ 热分层的前提） */
  readonly reps: number;
  /** 二遍 Verifier 消融开关 */
  readonly verifier: VerifierMode;
  /** 检视模型（v4-pro 强制搭配 highRiskOnly，防误发全量矩阵） */
  readonly model: ExperimentModel;
  /** 仅跑 riskClass = High 的 case（高险子集消融的入样过滤） */
  readonly highRiskOnly: boolean;
  /** 每源 case 数上限（null = 不限量） */
  readonly perSourceLimit: number | null;
  /** 精确 caseId 过滤（空数组 = 不过滤） */
  readonly caseFilter: readonly string[];
  /** 是否执行判定链 judge 阶段（需要 OPENAI_API_KEY） */
  readonly judge: boolean;
  /** 人工抽检比例（0, 1] */
  readonly humanReviewRate: number;
  /** 人工抽检种子（固定并随报告落盘，可复现） */
  readonly humanReviewSeed: string;
}

/** 一次待执行的检视运行（断点续跑与审计落盘的键） */
export interface RunUnit {
  readonly source: ExperimentSource;
  readonly caseId: string;
  readonly configId: ConfigId;
  /** 重复运行序（1 起：rep1 = 冷启动单列，rep2+ = 热稳定主口径） */
  readonly rep: number;
}

/** expandPlan 对被排除 case 的留痕（不静默跳过） */
export interface SkippedCase {
  readonly source: ExperimentSource;
  readonly caseId: string;
  readonly reason: SkipReason;
}

export type SkipReason =
  | "SOURCE_NOT_SELECTED"
  | "CASE_FILTERED_OUT"
  | "SOURCE_LIMIT_REACHED"
  | "RISK_CLASS_FILTERED_OUT"
  | "NO_CONFIG_OVERLAP";

export interface ExpandedPlan {
  /** 全部计划运行单元（顺序：case → config(A–E) → rep 1..N） */
  readonly units: readonly RunUnit[];
  /** 入样的 case（按源分组保持输入顺序） */
  readonly cases: readonly MRCase[];
  /** 被排除的 case 及原因 */
  readonly skipped: readonly SkippedCase[];
}

const CONFIG_ORDER: readonly ConfigId[] = Object.keys(CONFIGS) as ConfigId[];
const VALID_CONFIG_IDS = new Set<string>(CONFIG_ORDER);
const VALID_SOURCES = new Set<string>(EXPERIMENT_SOURCES);
const VALID_MODELS = new Set<string>(EXPERIMENT_MODELS);
const EXPERIMENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 计划校验（fail fast：错误指明字段与期望；不修改入参） */
export function validateExperimentPlan(plan: ExperimentPlan): void {
  if (typeof plan !== "object" || plan === null) {
    throw new Error("plan must be an ExperimentPlan object");
  }
  if (
    typeof plan.experimentId !== "string" ||
    !EXPERIMENT_ID_RE.test(plan.experimentId) ||
    plan.experimentId.length > 100
  ) {
    throw new Error(
      `plan.experimentId must match ${EXPERIMENT_ID_RE.source} and be at most 100 chars ` +
        `(got ${JSON.stringify(plan.experimentId)})`,
    );
  }
  validateSources(plan.sources);
  validateConfigs(plan.configs);
  if (!Number.isInteger(plan.reps) || plan.reps < 1) {
    throw new Error(`plan.reps must be an integer >= 1 (got ${JSON.stringify(plan.reps)})`);
  }
  if (plan.verifier !== "off" && plan.verifier !== "on") {
    throw new Error(`plan.verifier must be "off" or "on" (got ${JSON.stringify(plan.verifier)})`);
  }
  if (typeof plan.model !== "string" || !VALID_MODELS.has(plan.model)) {
    throw new Error(
      `plan.model must be one of ${[...VALID_MODELS].map((m) => JSON.stringify(m)).join(", ")} (got ${JSON.stringify(plan.model)})`,
    );
  }
  if (typeof plan.highRiskOnly !== "boolean") {
    throw new Error(`plan.highRiskOnly must be a boolean (got ${JSON.stringify(plan.highRiskOnly)})`);
  }
  if (plan.model === "deepseek-v4-pro" && !plan.highRiskOnly) {
    throw new Error(
      "plan.model deepseek-v4-pro requires highRiskOnly = true: the v4-pro ablation runs on the " +
        "high-risk subset only (spec #1 user story 15; full-matrix v4-pro runs are blocked as a cost guard)",
    );
  }
  if (plan.perSourceLimit !== null && (!Number.isInteger(plan.perSourceLimit) || plan.perSourceLimit < 1)) {
    throw new Error(
      `plan.perSourceLimit must be null or an integer >= 1 (got ${JSON.stringify(plan.perSourceLimit)})`,
    );
  }
  if (!Array.isArray(plan.caseFilter) || plan.caseFilter.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new Error("plan.caseFilter must be an array of non-empty caseId strings");
  }
  if (new Set(plan.caseFilter).size !== plan.caseFilter.length) {
    throw new Error("plan.caseFilter must not contain duplicates");
  }
  if (typeof plan.judge !== "boolean") {
    throw new Error(`plan.judge must be a boolean (got ${JSON.stringify(plan.judge)})`);
  }
  if (
    typeof plan.humanReviewRate !== "number" ||
    !Number.isFinite(plan.humanReviewRate) ||
    plan.humanReviewRate <= 0 ||
    plan.humanReviewRate > 1
  ) {
    throw new Error(
      `plan.humanReviewRate must be a number in (0, 1] (got ${JSON.stringify(plan.humanReviewRate)})`,
    );
  }
  if (typeof plan.humanReviewSeed !== "string" || plan.humanReviewSeed.trim() === "") {
    throw new Error("plan.humanReviewSeed must be a non-empty string");
  }
}

/** 计划 → 运行单元展开（纯函数：入样过滤 → allowedConfigs 求交 → rep 展开） */
export function expandPlan(
  plan: ExperimentPlan,
  cases: readonly MRCase[],
): ExpandedPlan {
  validateExperimentPlan(plan);
  if (!Array.isArray(cases)) {
    throw new Error("cases must be an array of MRCase");
  }
  const selectedSources = new Set<string>(plan.sources);
  const caseFilter = new Set(plan.caseFilter);
  const perSourceTaken = new Map<string, number>();
  const units: RunUnit[] = [];
  const selected: MRCase[] = [];
  const skipped: SkippedCase[] = [];
  for (const mrCase of cases) {
    const source = mrCase.labels.source as ExperimentSource;
    const skip = skipReasonOf(mrCase, source, { selectedSources, caseFilter, perSourceTaken, plan });
    if (skip !== null) {
      skipped.push({ source, caseId: mrCase.caseId, reason: skip });
      continue;
    }
    perSourceTaken.set(source, (perSourceTaken.get(source) ?? 0) + 1);
    selected.push(mrCase);
    for (const configId of configsForCase(plan, mrCase)) {
      for (let rep = 1; rep <= plan.reps; rep++) {
        units.push({ source, caseId: mrCase.caseId, configId, rep });
      }
    }
  }
  return { units, cases: selected, skipped };
}

function skipReasonOf(
  mrCase: MRCase,
  source: ExperimentSource,
  context: {
    readonly selectedSources: ReadonlySet<string>;
    readonly caseFilter: ReadonlySet<string>;
    readonly perSourceTaken: ReadonlyMap<string, number>;
    readonly plan: ExperimentPlan;
  },
): SkipReason | null {
  if (!context.selectedSources.has(source)) {
    return "SOURCE_NOT_SELECTED";
  }
  if (context.caseFilter.size > 0 && !context.caseFilter.has(mrCase.caseId)) {
    return "CASE_FILTERED_OUT";
  }
  if (context.plan.highRiskOnly && mrCase.labels.riskClass !== "High") {
    return "RISK_CLASS_FILTERED_OUT";
  }
  if (
    context.plan.perSourceLimit !== null &&
    (context.perSourceTaken.get(source) ?? 0) >= context.plan.perSourceLimit
  ) {
    return "SOURCE_LIMIT_REACHED";
  }
  if (configsForCase(context.plan, mrCase).length === 0) {
    return "NO_CONFIG_OVERLAP";
  }
  return null;
}

/** case 实际入样配置 = 计划配置 ∩ labels.allowedConfigs（按 A–E 序） */
export function configsForCase(plan: ExperimentPlan, mrCase: MRCase): readonly ConfigId[] {
  const allowed = new Set<string>(mrCase.labels.allowedConfigs);
  return plan.configs.filter((configId) => allowed.has(configId));
}

function validateSources(sources: readonly ExperimentSource[]): void {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error("plan.sources must be a non-empty array of source names");
  }
  for (const source of sources) {
    if (typeof source !== "string" || !VALID_SOURCES.has(source)) {
      throw new Error(
        `plan.sources entries must be one of ${[...VALID_SOURCES].map((s) => JSON.stringify(s)).join(", ")} (got ${JSON.stringify(source)})`,
      );
    }
  }
  if (new Set(sources).size !== sources.length) {
    throw new Error("plan.sources must not contain duplicates");
  }
}

function validateConfigs(configs: readonly ConfigId[]): void {
  if (!Array.isArray(configs) || configs.length === 0) {
    throw new Error("plan.configs must be a non-empty array of config ids");
  }
  for (const configId of configs) {
    if (typeof configId !== "string" || !VALID_CONFIG_IDS.has(configId)) {
      throw new Error(
        `plan.configs entries must be one of "A"-"E" (got ${JSON.stringify(configId)})`,
      );
    }
  }
  if (new Set(configs).size !== configs.length) {
    throw new Error("plan.configs must not contain duplicates");
  }
}

/** 单元键的稳定字符串形式（runs/<source>/<caseId>/<configId>/rep-<rep> 的目录骨架） */
export function runUnitKeyPath(unit: RunUnit): string {
  const safeCaseId = unit.caseId.replace(/[^A-Za-z0-9_.-]/g, "_");
  return `${unit.source}/${safeCaseId}/${unit.configId}/rep-${unit.rep}`;
}
