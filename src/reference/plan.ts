import type { MRCase } from "../contracts/mr-case.js";
import { EXPERIMENT_SOURCES, type ExperimentSource } from "../experiment/plan.js";

/**
 * 外部参照计划（Ticket 13 / issue #14）：Claude Code 跑批的可编排放跑参数。
 *
 * 与主实验计划（ExperimentPlan）的刻意差异：
 * - 无 configs / verifier / highRiskOnly——外部参照是单列（REFERENCE_CONFIG_ID），
 *   不是 A–E 矩阵成员，也没有二遍 Verifier 消融（参照测的是 Claude Code 原生形态）；
 * - model 为 Claude 系模型 id（CLI 别名或完整 id 均可，实际模型以 CLI 回报留档）；
 * - reps 缺省 1（单列定位是横向能力参照，不以重复统计为主口径；需要时可调高）。
 *
 * 成本纪律同 T12：perSourceLimit / caseFilter / 断点续跑（(source, caseId, rep)
 * 级落盘）；model / maxTurns / promptTemplateVersion 变更与既有记录冲突时启动即报错。
 */

/** 数据源词表复用主实验（四源：defects4j / vul4j / msb-java / clean-mr） */
export type ReferenceSource = ExperimentSource;
export const REFERENCE_SOURCES: readonly ExperimentSource[] = EXPERIMENT_SOURCES;

export interface ClaudeCodeReferencePlan {
  /** 参照运行标识（<runsRoot>/claude-code/<referenceId>/ 的目录名） */
  readonly referenceId: string;
  /** 参与的数据源（非空子集） */
  readonly sources: readonly ReferenceSource[];
  /** 每条 MR 的重复运行次数（rep1 冷 / rep2+ 热分层的输入顺序） */
  readonly reps: number;
  /** 请求的 Claude 系模型 id（锁定并留档） */
  readonly model: string;
  /** 轮数上界（--max-turns） */
  readonly maxTurns: number;
  /** 提示词模板版本（续跑兼容守卫之一） */
  readonly promptTemplateVersion: string;
  /** 每源 case 数上限（null = 不限量） */
  readonly perSourceLimit: number | null;
  /** 精确 caseId 过滤（空数组 = 不过滤） */
  readonly caseFilter: readonly string[];
}

/** 一次待执行的参照运行（断点续跑与留痕的键） */
export interface ReferenceRunUnit {
  readonly source: ReferenceSource;
  readonly caseId: string;
  /** 重复运行序（1 起，与主实验同口径） */
  readonly rep: number;
}

/** 被排除 case 的留痕（不静默跳过） */
export interface ReferenceSkippedCase {
  readonly source: string;
  readonly caseId: string;
  readonly reason: "SOURCE_NOT_SELECTED" | "CASE_FILTERED_OUT" | "SOURCE_LIMIT_REACHED";
}

export interface ExpandedReferencePlan {
  /** 全部计划运行单元（顺序：case → rep 1..N） */
  readonly units: readonly ReferenceRunUnit[];
  readonly cases: readonly MRCase[];
  readonly skipped: readonly ReferenceSkippedCase[];
}

export const DEFAULT_REFERENCE_REPS = 1;
export const DEFAULT_CLAUDE_CODE_MODEL = "sonnet";
export const DEFAULT_CLAUDE_CODE_MAX_TURNS = 5;

const VALID_SOURCES = new Set<string>(REFERENCE_SOURCES);
const REFERENCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/**
 * Claude 系模型 id 词表（外部参照的模型族约束）：`claude-*` 完整 id 或
 * sonnet / opus / haiku 别名。字符集本身排除 shell 元字符（注入防线）；
 * 非标准后端（本机代理把别名路由到自有模型）仍以别名请求，实际模型经
 * CLI 回报（modelUsage）照实归档对照。
 */
export const CLAUDE_MODEL_ID_RE = /^(?:claude-[A-Za-z0-9._-]{1,93}|sonnet|opus|haiku)$/;

/** 模型 id 是否为 Claude 系（计划校验与 client 参数构造共用） */
export function isClaudeCodeModelId(model: string): boolean {
  return CLAUDE_MODEL_ID_RE.test(model);
}

/** 计划校验（fail fast：错误指明字段与期望；不修改入参） */
export function validateReferencePlan(plan: ClaudeCodeReferencePlan): void {
  if (typeof plan !== "object" || plan === null) {
    throw new Error("plan must be a ClaudeCodeReferencePlan object");
  }
  if (
    typeof plan.referenceId !== "string" ||
    !REFERENCE_ID_RE.test(plan.referenceId) ||
    plan.referenceId.length > 100
  ) {
    throw new Error(
      `plan.referenceId must match ${REFERENCE_ID_RE.source} and be at most 100 chars ` +
        `(got ${JSON.stringify(plan.referenceId)})`,
    );
  }
  if (!Array.isArray(plan.sources) || plan.sources.length === 0) {
    throw new Error("plan.sources must be a non-empty array of source names");
  }
  for (const source of plan.sources) {
    if (typeof source !== "string" || !VALID_SOURCES.has(source)) {
      throw new Error(
        `plan.sources entries must be one of ${[...VALID_SOURCES].map((s) => JSON.stringify(s)).join(", ")} (got ${JSON.stringify(source)})`,
      );
    }
  }
  if (new Set(plan.sources).size !== plan.sources.length) {
    throw new Error("plan.sources must not contain duplicates");
  }
  if (!Number.isInteger(plan.reps) || plan.reps < 1) {
    throw new Error(`plan.reps must be an integer >= 1 (got ${JSON.stringify(plan.reps)})`);
  }
  if (typeof plan.model !== "string" || !isClaudeCodeModelId(plan.model)) {
    throw new Error(
      `plan.model must be a Claude-family model id (claude-* full id or sonnet/opus/haiku alias; ` +
        `external reference must not request other model families, got ${JSON.stringify(plan.model)})`,
    );
  }
  if (!Number.isInteger(plan.maxTurns) || plan.maxTurns < 1) {
    throw new Error(`plan.maxTurns must be an integer >= 1 (got ${JSON.stringify(plan.maxTurns)})`);
  }
  if (typeof plan.promptTemplateVersion !== "string" || plan.promptTemplateVersion.trim() === "") {
    throw new Error("plan.promptTemplateVersion must be a non-empty string");
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
}

/** 计划 → 运行单元展开（纯函数：入样过滤 → rep 展开；无 config 维度 = 单列） */
export function expandReferencePlan(
  plan: ClaudeCodeReferencePlan,
  cases: readonly MRCase[],
): ExpandedReferencePlan {
  validateReferencePlan(plan);
  if (!Array.isArray(cases)) {
    throw new Error("cases must be an array of MRCase");
  }
  const selectedSources = new Set<string>(plan.sources);
  const caseFilter = new Set(plan.caseFilter);
  const perSourceTaken = new Map<string, number>();
  const units: ReferenceRunUnit[] = [];
  const selected: MRCase[] = [];
  const skipped: ReferenceSkippedCase[] = [];
  for (const mrCase of cases) {
    const source = mrCase.labels.source;
    if (!selectedSources.has(source)) {
      skipped.push({ source, caseId: mrCase.caseId, reason: "SOURCE_NOT_SELECTED" });
      continue;
    }
    if (caseFilter.size > 0 && !caseFilter.has(mrCase.caseId)) {
      skipped.push({ source, caseId: mrCase.caseId, reason: "CASE_FILTERED_OUT" });
      continue;
    }
    if (
      plan.perSourceLimit !== null &&
      (perSourceTaken.get(source) ?? 0) >= plan.perSourceLimit
    ) {
      skipped.push({ source, caseId: mrCase.caseId, reason: "SOURCE_LIMIT_REACHED" });
      continue;
    }
    perSourceTaken.set(source, (perSourceTaken.get(source) ?? 0) + 1);
    selected.push(mrCase);
    for (let rep = 1; rep <= plan.reps; rep++) {
      units.push({ source: source as ReferenceSource, caseId: mrCase.caseId, rep });
    }
  }
  return { units, cases: selected, skipped };
}

/** 单元键的稳定字符串形式（runs/<source>/<caseId>/rep-<rep> 的目录骨架） */
export function referenceUnitKeyPath(unit: ReferenceRunUnit): string {
  const safe = unit.caseId.replace(/[^A-Za-z0-9_.-]/g, "_");
  // 恰为 "." / ".." 的段替换为 "_"（与 run-store safeSegment 同口径的路径防线）
  const safeCaseId = safe === "." || safe === ".." ? "_" : safe;
  return `${unit.source}/${safeCaseId}/rep-${unit.rep}`;
}
