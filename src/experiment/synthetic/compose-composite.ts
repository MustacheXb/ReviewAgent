import { type SourceSnapshot, applyUnifiedDiff } from "../../dataset/diff/apply-unified-diff.js";
import { measureDiffBoundary } from "../../dataset/mr-boundary-filter.js";
import { type Result, DatasetError, err, ok } from "../../dataset/diff/types.js";
import { parseUnifiedDiff } from "../../dataset/diff/parse-unified-diff.js";
import type { CaseLabels, MRCase, TruthLocation } from "../../contracts/mr-case.js";
import {
  generateBenignFill,
  validateFillTargets,
  type FillEdit,
  type FillResult,
} from "./benign-fill.js";

/**
 * 合成组合构造器（spec #48 实现决策 14，ticket #52）：把同仓多案例重组为
 * 一个超界合成 MR——锚定 fix commit 最新者的物化快照为 base；其余案例的
 * 逆补丁按输入序逐个尝试干净套用（文件级不相交硬校验，套用冲突即弃并留
 * 构造痕，不人工解冲突）；真值 = 入选案例真值并集（文件不相交 ⇒ 行号不
 * 漂移）；良性填充撑到目标规模档位。全部构造参数落 manifest，确定性可复现。
 */

/** 组合候选：案例 + 其 fix commit 时间（ISO 8601）+ 该提交点的物化快照 */
export interface CompositeCandidate {
  readonly mrCase: MRCase;
  readonly fixCommitAt: string;
  readonly snapshot: SourceSnapshot;
}

/** 规模档位目标（对合成 MR 整体：案例部分 + 填充部分） */
export interface CompositeFillParams {
  /** 合成 MR 应触碰的文件数下限 */
  readonly targetFiles: number;
  /** 合成 MR 的变更行数（新增 + 删除口径）下限 */
  readonly targetDiffLines: number;
}

export interface ComposeCompositeInput {
  /** 合成案例 id（亦为填充种子与 manifest 主键） */
  readonly compositeId: string;
  /** 候选案例（≥2；输入序即非锚案例的尝试序） */
  readonly candidates: readonly CompositeCandidate[];
  readonly fill: CompositeFillParams;
}

export type CompositeDropReason = "file-overlap" | "apply-conflict";

/** 弃用案例构造痕（决策 14：冲突即弃并留痕，不人工解冲突） */
export interface CompositeDropTrace {
  readonly caseId: string;
  readonly reason: CompositeDropReason;
  readonly detail: string;
}

export interface CompositeManifest {
  readonly compositeId: string;
  readonly anchorCaseId: string;
  readonly anchorFixCommitAt: string;
  /** 原始输入案例 id 序（非锚案例的尝试序依据；includedCaseIds 才是入选结果序） */
  readonly inputCaseIds: readonly string[];
  readonly includedCaseIds: readonly string[];
  readonly droppedCases: readonly CompositeDropTrace[];
  /** 填充参数（原样回显，重放上下文）与实际产出 */
  readonly fill: {
    readonly targetFiles: number;
    readonly targetDiffLines: number;
    readonly seed: string;
    readonly edits: readonly FillEdit[];
    readonly filesTouched: readonly string[];
    readonly diffLines: number;
  };
  /** 合成 MR 总规模（案例部分 + 填充部分） */
  readonly composite: {
    readonly files: number;
    readonly diffLines: number;
  };
}

/** 产出：合成 MRCase + 构造 manifest */
export interface CompositeMr {
  readonly mrCase: MRCase;
  readonly manifest: CompositeManifest;
}

/** 入选决策结果：锚 + 入选序（锚在前，其余按输入序）+ 弃用痕 + 填充禁改集（全部候选触碰文件） */
interface Acceptance {
  readonly anchor: CompositeCandidate;
  readonly accepted: readonly CompositeCandidate[];
  readonly dropped: readonly CompositeDropTrace[];
  readonly forbiddenFiles: ReadonlySet<string>;
}

export function composeComposite(input: ComposeCompositeInput): Result<CompositeMr> {
  const inputError = validateInput(input);
  if (inputError !== undefined) {
    return err(inputError);
  }
  const acceptance = acceptCandidates(input.candidates);
  if (!acceptance.ok) {
    return acceptance;
  }
  const { anchor, accepted, forbiddenFiles } = acceptance.value;

  // 案例部分规模（文件不相交 ⇒ 各案例行号不漂移，diff 可直接拼接）
  const caseDiff = accepted.map((candidate) => candidate.mrCase.diff).join("");
  const caseMetrics = measureDiffBoundary(caseDiff);
  if (!caseMetrics.ok) {
    return err(caseMetrics.error);
  }

  // 良性填充：禁改集 = 全部候选案例文件（保守含弃用案例——填充不得触碰任何案例文件）
  const fill = generateBenignFill(
    anchor.snapshot,
    forbiddenFiles,
    {
      targetFiles: Math.max(0, input.fill.targetFiles - caseMetrics.value.files),
      targetDiffLines: Math.max(0, input.fill.targetDiffLines - caseMetrics.value.changedLines),
    },
    input.compositeId,
  );
  if (!fill.ok) {
    return err(fill.error);
  }

  // labels 合并：source 须一致；riskClass 取最强；allowedConfigs 交集非空
  const labels = mergeLabels(accepted);
  if (!labels.ok) {
    return labels;
  }

  const compositeDiff = caseDiff + fill.value.diff;
  const compositeMetrics = measureDiffBoundary(compositeDiff);
  if (!compositeMetrics.ok) {
    return err(compositeMetrics.error);
  }
  return ok({
    mrCase: buildMrCase(input, acceptance.value, compositeDiff, labels.value),
    manifest: buildManifest(input, acceptance.value, fill.value, compositeMetrics.value),
  });
}

/** 锚定（fix commit 最新者）+ 非锚案例逐个入选决策：文件级不相交硬校验 → 干净套用，任一失败弃案例留痕 */
function acceptCandidates(candidates: readonly CompositeCandidate[]): Result<Acceptance> {
  // 锚定规则：fix commit 时间最新者为锚（同刻 caseId 大者，确定性 tie-break）
  const anchor = candidates.reduce((best, candidate) =>
    isAnchorAfter(candidate, best) ? candidate : best,
  );
  // 锚案例：自身逆补丁必须干净套用到自己的快照（套用即还原 buggy 态）
  const anchorApply = applyUnifiedDiff(anchor.snapshot, anchor.mrCase.diff);
  if (!anchorApply.ok) {
    return err(
      new DatasetError(
        "COMPOSITE_ANCHOR_APPLY_FAILED",
        `锚案例 ${anchor.mrCase.caseId} 的逆补丁无法干净套用到其自身快照：${anchorApply.error.message}`,
      ),
    );
  }
  const acceptedFiles = new Set<string>(diffFiles(anchor.mrCase.diff));
  const accepted: CompositeCandidate[] = [anchor];
  const dropped: CompositeDropTrace[] = [];
  const forbiddenFiles = new Set<string>(acceptedFiles);
  // 非锚案例按输入序：文件级不相交硬校验 → 干净套用；任一失败即弃该案例留痕
  for (const candidate of candidates) {
    if (candidate === anchor) {
      continue;
    }
    const files = diffFiles(candidate.mrCase.diff);
    for (const path of files) {
      forbiddenFiles.add(path);
    }
    const overlap = files.filter((path) => acceptedFiles.has(path));
    if (overlap.length > 0) {
      dropped.push({
        caseId: candidate.mrCase.caseId,
        reason: "file-overlap",
        detail: `触碰已入选案例文件：${overlap.join("、")}`,
      });
      continue;
    }
    const applied = applyUnifiedDiff(anchor.snapshot, candidate.mrCase.diff);
    if (!applied.ok) {
      dropped.push({
        caseId: candidate.mrCase.caseId,
        reason: "apply-conflict",
        detail: applied.error.message,
      });
      continue;
    }
    accepted.push(candidate);
    for (const path of files) {
      acceptedFiles.add(path);
    }
  }
  return ok({ anchor, accepted, dropped, forbiddenFiles });
}

/** 组装合成 MRCase（diff / 描述拼接 / 真值并集 / labels / extensions 构造痕） */
function buildMrCase(
  input: ComposeCompositeInput,
  acceptance: Acceptance,
  compositeDiff: string,
  labels: CaseLabels,
): MRCase {
  const { anchor, accepted, dropped } = acceptance;
  const truthLocations: TruthLocation[] = [];
  const fixPatches: string[] = [];
  for (const candidate of accepted) {
    // validateInput 已保证 truth 非 null
    truthLocations.push(...candidate.mrCase.truth!.locations);
    fixPatches.push(candidate.mrCase.truth!.fixPatch);
  }
  return {
    caseId: input.compositeId,
    repoPath: anchor.mrCase.repoPath,
    diff: compositeDiff,
    issueDescription: accepted
      .map((candidate) => candidate.mrCase.issueDescription)
      .filter((text) => text.length > 0)
      .join("\n\n"),
    truth: {
      locations: truthLocations,
      fixPatch: fixPatches.join(""),
    },
    labels,
    extensions: {
      ...anchor.mrCase.extensions,
      composite: "true",
      anchorCaseId: anchor.mrCase.caseId,
      includedCaseIds: accepted.map((candidate) => candidate.mrCase.caseId).join(","),
      ...(dropped.length > 0
        ? { droppedCaseIds: dropped.map((drop) => drop.caseId).join(",") }
        : {}),
    },
  };
}

/** 组装 manifest（全部构造参数 + 实际产出，同输入确定性重放的完整依据） */
function buildManifest(
  input: ComposeCompositeInput,
  acceptance: Acceptance,
  fill: FillResult,
  metrics: { readonly files: number; readonly changedLines: number },
): CompositeManifest {
  const { anchor, accepted, dropped } = acceptance;
  return {
    compositeId: input.compositeId,
    anchorCaseId: anchor.mrCase.caseId,
    anchorFixCommitAt: anchor.fixCommitAt,
    inputCaseIds: input.candidates.map((candidate) => candidate.mrCase.caseId),
    includedCaseIds: accepted.map((candidate) => candidate.mrCase.caseId),
    droppedCases: dropped,
    fill: {
      targetFiles: input.fill.targetFiles,
      targetDiffLines: input.fill.targetDiffLines,
      seed: input.compositeId,
      edits: fill.edits,
      filesTouched: fill.filesTouched,
      diffLines: fill.diffLines,
    },
    composite: { files: metrics.files, diffLines: metrics.changedLines },
  };
}

/**
 * ISO 8601 时间戳（日期必选；时间 / 秒 / 毫秒 / 时区偏移可选）。Date.parse 会
 * 宽恕「06/15/2024」等非 ISO 形态，故先格式校验再解析。
 */
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function validateInput(input: ComposeCompositeInput): DatasetError | undefined {
  if (typeof input.compositeId !== "string" || input.compositeId.length === 0) {
    return new DatasetError("COMPOSITE_INPUT_INVALID", "compositeId 必须为非空字符串");
  }
  if (!Array.isArray(input.candidates) || input.candidates.length < 2) {
    return new DatasetError("COMPOSITE_INPUT_INVALID", "合成组合至少需要 2 个候选案例");
  }
  const seen = new Set<string>();
  for (const candidate of input.candidates) {
    if (candidate === null || typeof candidate !== "object") {
      return new DatasetError("COMPOSITE_INPUT_INVALID", "候选必须为 CompositeCandidate 对象");
    }
    const { mrCase, fixCommitAt, snapshot } = candidate;
    if (typeof mrCase?.caseId !== "string" || mrCase.caseId.length === 0) {
      return new DatasetError("COMPOSITE_INPUT_INVALID", "候选 mrCase.caseId 必须为非空字符串");
    }
    if (seen.has(mrCase.caseId)) {
      return new DatasetError("COMPOSITE_INPUT_INVALID", `候选 caseId 重复：${mrCase.caseId}`);
    }
    seen.add(mrCase.caseId);
    if (mrCase.truth === null) {
      return new DatasetError("COMPOSITE_INPUT_INVALID", `候选 ${mrCase.caseId} 缺少真值（truth）`);
    }
    if (
      typeof fixCommitAt !== "string" ||
      !ISO_8601_RE.test(fixCommitAt) ||
      !Number.isFinite(Date.parse(fixCommitAt))
    ) {
      return new DatasetError(
        "COMPOSITE_INPUT_INVALID",
        `候选 ${mrCase.caseId} 的 fixCommitAt 必须为 ISO 8601 时间（got ${String(fixCommitAt)}）`,
      );
    }
    if (typeof mrCase.repoPath !== "string" || mrCase.repoPath.length === 0) {
      return new DatasetError(
        "COMPOSITE_INPUT_INVALID",
        `候选 ${mrCase.caseId} 的 repoPath 必须为非空字符串`,
      );
    }
    if (snapshot === null || typeof snapshot !== "object" || Object.keys(snapshot).length === 0) {
      return new DatasetError("COMPOSITE_INPUT_INVALID", `候选 ${mrCase.caseId} 的 snapshot 不能为空`);
    }
    if (typeof mrCase.diff !== "string" || mrCase.diff.length === 0) {
      return new DatasetError("COMPOSITE_INPUT_INVALID", `候选 ${mrCase.caseId} 的 diff 不能为空`);
    }
    const parsed = parseUnifiedDiff(mrCase.diff);
    if (!parsed.ok) {
      return new DatasetError(
        "COMPOSITE_INPUT_INVALID",
        `候选 ${mrCase.caseId} 的 diff 不可解析：${parsed.error.message}`,
      );
    }
  }
  // 合成组合限同仓案例：跨仓快照 / diff 无法在同一 base 上重组
  const repoPaths = new Set(input.candidates.map((candidate) => candidate.mrCase.repoPath));
  if (repoPaths.size > 1) {
    return new DatasetError(
      "COMPOSITE_INPUT_INVALID",
      `候选案例 repoPath 不一致（合成组合限同仓案例）：${[...repoPaths].join("、")}`,
    );
  }
  if (input.fill === null || typeof input.fill !== "object") {
    return new DatasetError("COMPOSITE_INPUT_INVALID", "fill 必须为 { targetFiles, targetDiffLines } 对象");
  }
  const fillError = validateFillTargets(input.fill);
  if (fillError !== undefined) {
    return fillError;
  }
  return undefined;
}

/**
 * 锚判定：candidate 晚于 best（时间戳数值比较；同刻按 caseId 码元序大者）。
 * 结构类型参数——编排层（validation-driver）同规则复用（单一事实源，防
 * tie-break 单侧改动漂移）；CompositeCandidate 结构上满足本签名。
 */
export function isAnchorAfter(
  candidate: { readonly mrCase: { readonly caseId: string }; readonly fixCommitAt: string },
  best: { readonly mrCase: { readonly caseId: string }; readonly fixCommitAt: string },
): boolean {
  const candidateAt = Date.parse(candidate.fixCommitAt);
  const bestAt = Date.parse(best.fixCommitAt);
  if (candidateAt !== bestAt) {
    return candidateAt > bestAt;
  }
  return candidate.mrCase.caseId > best.mrCase.caseId;
}

/** 案例 diff 触碰的文件集（old ∪ new 路径；validateInput 已保证可解析） */
function diffFiles(diff: string): string[] {
  const parsed = parseUnifiedDiff(diff);
  if (!parsed.ok) {
    return [];
  }
  const files = new Set<string>();
  for (const file of parsed.value) {
    if (file.oldPath !== null) {
      files.add(file.oldPath);
    }
    if (file.newPath !== null) {
      files.add(file.newPath);
    }
  }
  return [...files];
}

/** labels 合并：source 全体一致；riskClass 取最强；allowedConfigs 交集非空 */
function mergeLabels(accepted: readonly CompositeCandidate[]): Result<CaseLabels> {
  const sources = new Set(accepted.map((candidate) => candidate.mrCase.labels.source));
  if (sources.size > 1) {
    return err(
      new DatasetError("COMPOSITE_INPUT_INVALID", `入选案例 source 不一致：${[...sources].join("、")}`),
    );
  }
  const rank: Record<string, number> = { Low: 0, Medium: 1, High: 2 };
  const riskClass = accepted
    .map((candidate) => candidate.mrCase.labels.riskClass)
    .reduce((strongest, current) => (rank[current]! > rank[strongest]! ? current : strongest));
  const ordered = accepted[0]!.mrCase.labels.allowedConfigs;
  const allowedConfigs = ordered.filter((config) =>
    accepted.every((candidate) => candidate.mrCase.labels.allowedConfigs.includes(config)),
  );
  if (allowedConfigs.length === 0) {
    return err(new DatasetError("COMPOSITE_INPUT_INVALID", "入选案例 allowedConfigs 交集为空，无法组合"));
  }
  return ok({ source: accepted[0]!.mrCase.labels.source, riskClass, allowedConfigs });
}
