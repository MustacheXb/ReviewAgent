import type { GithubPullRequest } from "./pr-records.js";
import {
  collectRevertedPrNumbers,
  containsJavaFile,
  extractResolvedIssues,
  isDependencyOnlyPaths,
  isMergedPr,
  isRevertPr,
  issueLinkInputOf,
} from "./mining-rules.js";
import {
  type BoundaryMetrics,
  type MrBoundary,
  DEFAULT_MR_BOUNDARY,
  checkBoundary,
} from "../mr-boundary-filter.js";
import { measureDiffBoundary } from "../mr-boundary-filter.js";
import { parseUnifiedDiff } from "../diff/parse-unified-diff.js";

/**
 * 候选 PR 的全量评估与确定性选取（Ticket 09，纯函数）。
 *
 * 评估规则链固定顺序（先廉价后昂贵、先核心后附加），任一环节不通过即拒绝并留痕：
 * not-merged → issue-linked → revert-pr → reverted-later →
 * dependency-bump → no-java-file → 边界（too-many-files / diff-too-large / malformed-diff）。
 *
 * 选取：按输入的仓库顺序与候选顺序，每仓最多取前 quota 条通过评估的候选；
 * 同输入必得同输出（零随机性），清单可复现。
 */

export type CleanMrRejectReason =
  | "not-merged"
  | "issue-linked"
  | "revert-pr"
  | "reverted-later"
  | "dependency-bump"
  | "no-java-file"
  | "too-many-files"
  | "diff-too-large"
  | "malformed-diff";

export const CLEAN_MR_REJECT_REASONS: readonly CleanMrRejectReason[] = Object.freeze([
  "not-merged",
  "issue-linked",
  "revert-pr",
  "reverted-later",
  "dependency-bump",
  "no-java-file",
  "too-many-files",
  "diff-too-large",
  "malformed-diff",
]);

/** 挖掘规则开关（核心三规则默认开；附加规则显式化，可关闭以复现不同口径） */
export interface CleanMrRuleConfig {
  readonly excludeIssueLinked: boolean;
  readonly excludeRevertPrs: boolean;
  readonly excludeRevertedByLaterPr: boolean;
  readonly excludeDependencyBumps: boolean;
  readonly requireJavaFile: boolean;
}

export const DEFAULT_CLEAN_MR_RULES: CleanMrRuleConfig = Object.freeze({
  excludeIssueLinked: true,
  excludeRevertPrs: true,
  excludeRevertedByLaterPr: true,
  excludeDependencyBumps: true,
  requireJavaFile: true,
});

/** 评估所需全部材料：PR 元数据 + 提交消息 + diff（采集脚本负责抓取） */
export interface CleanMrCandidate {
  readonly pr: GithubPullRequest;
  readonly commitMessages: readonly string[];
  readonly diff: string;
}

export interface CleanMrEvaluation {
  readonly prNumber: number;
  readonly accepted: boolean;
  readonly reason: CleanMrRejectReason | null;
  /** issue-linked 拒绝时的关联 issue 号（留痕） */
  readonly issueNumbers: readonly number[];
  readonly metrics: BoundaryMetrics | null;
}

/** 单条候选的规则链评估（不修改输入；malformed diff 以 malformed-diff 拒绝） */
export function evaluateCleanMrCandidate(
  candidate: CleanMrCandidate,
  revertedPrNumbers: ReadonlySet<number>,
  rules: CleanMrRuleConfig = DEFAULT_CLEAN_MR_RULES,
  boundary: MrBoundary = DEFAULT_MR_BOUNDARY,
): CleanMrEvaluation {
  const { pr, commitMessages, diff } = candidate;
  const base = { prNumber: pr.number, metrics: null as BoundaryMetrics | null };
  if (!isMergedPr(pr)) {
    return { ...base, accepted: false, reason: "not-merged", issueNumbers: [] };
  }
  const linkInput = issueLinkInputOf(pr, commitMessages);
  if (rules.excludeIssueLinked) {
    const issueNumbers = extractResolvedIssues(linkInput);
    if (issueNumbers.length > 0) {
      return { ...base, accepted: false, reason: "issue-linked", issueNumbers, metrics: null };
    }
  }
  if (rules.excludeRevertPrs && isRevertPr(linkInput)) {
    return { ...base, accepted: false, reason: "revert-pr", issueNumbers: [] };
  }
  if (rules.excludeRevertedByLaterPr && revertedPrNumbers.has(pr.number)) {
    return { ...base, accepted: false, reason: "reverted-later", issueNumbers: [] };
  }
  const metrics = measureDiffBoundary(diff);
  const paths = parseUnifiedDiff(diff);
  if (!metrics.ok || !paths.ok) {
    return { ...base, accepted: false, reason: "malformed-diff", issueNumbers: [] };
  }
  const touchedPaths = paths.value.map((file) => file.newPath ?? file.oldPath ?? "");
  if (rules.excludeDependencyBumps && isDependencyOnlyPaths(touchedPaths)) {
    return {
      ...base,
      accepted: false,
      reason: "dependency-bump",
      issueNumbers: [],
      metrics: metrics.value,
    };
  }
  if (rules.requireJavaFile && !containsJavaFile(touchedPaths)) {
    return { ...base, accepted: false, reason: "no-java-file", issueNumbers: [], metrics: metrics.value };
  }
  const outcome = checkBoundary(metrics.value, boundary);
  if (!outcome.accepted) {
    return {
      ...base,
      accepted: false,
      reason: outcome.reason,
      issueNumbers: [],
      metrics: metrics.value,
    };
  }
  return { ...base, accepted: true, reason: null, issueNumbers: [], metrics: metrics.value };
}

/** 一个仓库的扫描输入：全部已列举 PR（供 revert 引用提取）+ 全量抓取的候选（扫描顺序） */
export interface RepoCandidateScan {
  readonly org: string;
  readonly repo: string;
  /** 已列举页内的全部 closed PR（含未全量抓取的；用于 reverted-by-later 判定） */
  readonly scannedPrs: readonly GithubPullRequest[];
  /** 按扫描顺序（新→旧）全量抓取的候选 */
  readonly candidates: readonly CleanMrCandidate[];
}

export interface SelectedCleanMr {
  readonly candidate: CleanMrCandidate;
  readonly metrics: BoundaryMetrics;
}

export interface RepoSelectionStats {
  readonly org: string;
  readonly repo: string;
  readonly scannedPrs: number;
  readonly evaluated: number;
  readonly accepted: number;
  readonly selected: number;
  readonly quota: number;
  readonly rejectedByReason: Readonly<Record<CleanMrRejectReason, number>>;
  /** 通过评估但超出每仓配额、未入选的候选号（留痕） */
  readonly overflowPrNumbers: readonly number[];
}

export interface CleanMrSelectionConfig {
  readonly perRepoQuota: number;
  /**
   * 全局目标（可选）：每仓配额取满后总数不足时，按仓库顺序做一轮
   * 补位（每仓至多 spillPerRepo 条），从该仓通过评估的剩余候选中依序补足。
   * 用于部分仓库（如纯 Ruby 期 / dependabot 期）无法满配额时凑齐 ~50。
   */
  readonly targetTotal?: number;
  readonly spillPerRepo?: number;
  readonly rules: CleanMrRuleConfig;
  readonly boundary: MrBoundary;
}

export const DEFAULT_CLEAN_MR_SELECTION: CleanMrSelectionConfig = Object.freeze({
  perRepoQuota: 6,
  targetTotal: 50,
  spillPerRepo: 4,
  rules: DEFAULT_CLEAN_MR_RULES,
  boundary: DEFAULT_MR_BOUNDARY,
});

export interface CleanMrSelectionResult {
  readonly selected: readonly SelectedCleanMr[];
  readonly repos: readonly RepoSelectionStats[];
  readonly total: number;
}

/**
 * 批量选取（确定性）：
 * ① 每仓按候选顺序取前 quota 条通过评估者；
 * ② （配置 targetTotal 时）总数不足则按仓库顺序做一轮补位，每仓至多
 *    spillPerRepo 条、不超过该仓通过评估的剩余候选，直至达到目标。
 * 全量评估留痕（含未入选项），不修改输入。
 */
export function selectCleanMrCases(
  scans: readonly RepoCandidateScan[],
  config: CleanMrSelectionConfig = DEFAULT_CLEAN_MR_SELECTION,
): CleanMrSelectionResult {
  if (!Number.isInteger(config.perRepoQuota) || config.perRepoQuota < 1) {
    throw new RangeError("perRepoQuota 必须为 ≥1 的整数");
  }
  if (config.targetTotal !== undefined && (!Number.isInteger(config.targetTotal) || config.targetTotal < 1)) {
    throw new RangeError("targetTotal 若提供必须为 ≥1 的整数");
  }
  const selected: SelectedCleanMr[] = [];
  const pools: { readonly chosen: SelectedCleanMr[]; readonly surplus: SelectedCleanMr[]; readonly stats: RepoSelectionStats }[] = [];
  for (const scan of scans) {
    const reverted = collectRevertedPrNumbers(scan.scannedPrs);
    const acceptedPool: SelectedCleanMr[] = [];
    const rejectedByReason = emptyReasonCounts();
    for (const candidate of scan.candidates) {
      const evaluation = evaluateCleanMrCandidate(candidate, reverted, config.rules, config.boundary);
      if (evaluation.accepted) {
        acceptedPool.push({ candidate, metrics: evaluation.metrics ?? zeroMetrics() });
      } else if (evaluation.reason !== null) {
        rejectedByReason[evaluation.reason] += 1;
      }
    }
    const chosen = acceptedPool.slice(0, config.perRepoQuota);
    selected.push(...chosen);
    pools.push({
      chosen,
      surplus: acceptedPool.slice(config.perRepoQuota),
      stats: {
        org: scan.org,
        repo: scan.repo,
        scannedPrs: scan.scannedPrs.length,
        evaluated: scan.candidates.length,
        accepted: acceptedPool.length,
        selected: chosen.length,
        quota: config.perRepoQuota,
        rejectedByReason,
        overflowPrNumbers: acceptedPool.slice(config.perRepoQuota).map((item) => item.candidate.pr.number),
      },
    });
  }

  // ② 补位：仅当目标已配置且未达成；按仓库顺序单轮补位，确定性
  const spillByRepo = new Map<number, readonly SelectedCleanMr[]>();
  if (config.targetTotal !== undefined && selected.length < config.targetTotal) {
    const spillPerRepo = config.spillPerRepo ?? 0;
    let remaining = config.targetTotal - selected.length;
    for (let i = 0; i < pools.length && remaining > 0; i += 1) {
      const extra = pools[i]!.surplus.slice(0, Math.min(spillPerRepo, remaining));
      spillByRepo.set(i, extra);
      remaining -= extra.length;
    }
  }

  const repos: RepoSelectionStats[] = [];
  for (let i = 0; i < pools.length; i += 1) {
    const pool = pools[i]!;
    const extra = spillByRepo.get(i) ?? [];
    selected.push(...extra);
    const taken = new Set(extra.map((item) => item.candidate.pr.number));
    repos.push({
      ...pool.stats,
      selected: pool.stats.selected + extra.length,
      overflowPrNumbers: pool.stats.overflowPrNumbers.filter((n) => !taken.has(n)),
    });
  }
  return { selected, repos, total: selected.length };
}

function emptyReasonCounts(): Record<CleanMrRejectReason, number> {
  const counts = {} as Record<CleanMrRejectReason, number>;
  for (const reason of CLEAN_MR_REJECT_REASONS) {
    counts[reason] = 0;
  }
  return counts;
}

function zeroMetrics(): BoundaryMetrics {
  return { files: 0, addedLines: 0, removedLines: 0, changedLines: 0, totalDiffLines: 0 };
}
