import type { MRCase } from "../contracts/mr-case.js";
import { type Result, err, ok } from "./diff/types.js";
import { parseUnifiedDiff } from "./diff/parse-unified-diff.js";
import { DatasetError } from "./diff/types.js";

/**
 * MR 边界过滤（Ticket 02）：≤10 文件、diff ≤2K 行（spec #1：聚焦中小 MR，大 MR 切分非目标）。
 *
 * 口径（在过滤报告中显式声明，供实验报告复述）：
 * - files：diff 触碰的文件数（含新增/删除文件）；
 * - diffLines：变更行数 = 新增行 + 删除行（不含 context 行与文件头/hunk 头）；
 *   fixPatch 与其逆 diff 的该口径数值恒等（两侧增删互换）。
 * 纯函数，零 IO；被过滤的 case 全量留痕于 FilterReport。
 */
export interface MrBoundary {
  readonly maxFiles: number;
  readonly maxDiffLines: number;
}

export const DEFAULT_MR_BOUNDARY: MrBoundary = Object.freeze({
  maxFiles: 10,
  maxDiffLines: 2000,
});

export interface BoundaryMetrics {
  readonly files: number;
  readonly addedLines: number;
  readonly removedLines: number;
  readonly changedLines: number;
  readonly totalDiffLines: number;
}

export type FilterReason = "too-many-files" | "diff-too-large" | "malformed-diff";

export interface BoundaryOutcome {
  readonly accepted: boolean;
  readonly reason: FilterReason | null;
  readonly metrics: BoundaryMetrics | null;
}

/** 从 MRCase.diff 度量边界指标（diff 不可解析时返回错误，由上层以 malformed-diff 留痕） */
export function measureDiffBoundary(diff: string): Result<BoundaryMetrics> {
  const parsed = parseUnifiedDiff(diff);
  if (!parsed.ok) {
    return err(new DatasetError("MALFORMED_DIFF", `diff 解析失败: ${parsed.error.message}`));
  }
  let added = 0;
  let removed = 0;
  for (const file of parsed.value) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type === "add") {
          added += 1;
        } else if (line.type === "remove") {
          removed += 1;
        }
      }
    }
  }
  return ok({
    files: parsed.value.length,
    addedLines: added,
    removedLines: removed,
    changedLines: added + removed,
    totalDiffLines: countTextLines(diff),
  });
}

function countTextLines(diff: string): number {
  const lines = diff.split(/\r?\n/);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

export function checkBoundary(metrics: BoundaryMetrics, boundary: MrBoundary): BoundaryOutcome {
  if (metrics.files > boundary.maxFiles) {
    return { accepted: false, reason: "too-many-files", metrics };
  }
  if (metrics.changedLines > boundary.maxDiffLines) {
    return { accepted: false, reason: "diff-too-large", metrics };
  }
  return { accepted: true, reason: null, metrics };
}

export function filterMrCase(
  mrCase: MRCase,
  boundary: MrBoundary = DEFAULT_MR_BOUNDARY,
): BoundaryOutcome {
  const metrics = measureDiffBoundary(mrCase.diff);
  if (!metrics.ok) {
    return { accepted: false, reason: "malformed-diff", metrics: null };
  }
  return checkBoundary(metrics.value, boundary);
}

export interface RejectedCase {
  readonly caseId: string;
  readonly source: string;
  readonly reason: FilterReason;
  readonly metrics: BoundaryMetrics | null;
  readonly message: string;
}

export interface FilterReport {
  readonly boundary: MrBoundary;
  readonly total: number;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly rejectedByReason: Readonly<Record<FilterReason, number>>;
  /** 全量被拒记录（留痕），保持输入顺序 */
  readonly rejected: readonly RejectedCase[];
}

export interface FilterResult {
  readonly accepted: readonly MRCase[];
  readonly report: FilterReport;
}

/** 批量过滤：不修改输入、不抛异常；逐条留痕（含解析失败项） */
export function filterMrCases(
  cases: readonly MRCase[],
  boundary: MrBoundary = DEFAULT_MR_BOUNDARY,
): FilterResult {
  const accepted: MRCase[] = [];
  const rejected: RejectedCase[] = [];
  for (const mrCase of cases) {
    const outcome = filterMrCase(mrCase, boundary);
    if (outcome.accepted) {
      accepted.push(mrCase);
      continue;
    }
    rejected.push(toRejected(mrCase, outcome));
  }
  return {
    accepted,
    report: {
      boundary,
      total: cases.length,
      acceptedCount: accepted.length,
      rejectedCount: rejected.length,
      rejectedByReason: countByReason(rejected),
      rejected,
    },
  };
}

function toRejected(mrCase: MRCase, outcome: BoundaryOutcome): RejectedCase {
  const reason = outcome.reason ?? "malformed-diff";
  return {
    caseId: mrCase.caseId,
    source: mrCase.labels.source,
    reason,
    metrics: outcome.metrics,
    message: rejectionMessage(mrCase.caseId, outcome),
  };
}

function rejectionMessage(caseId: string, outcome: BoundaryOutcome): string {
  if (outcome.reason === "too-many-files") {
    return `${caseId}: 文件数 ${outcome.metrics?.files} 超过上限`;
  }
  if (outcome.reason === "diff-too-large") {
    return `${caseId}: 变更行数 ${outcome.metrics?.changedLines} 超过上限`;
  }
  if (outcome.reason === "malformed-diff") {
    return `${caseId}: diff 无法解析`;
  }
  return `${caseId}: 未知拒绝原因`;
}

function countByReason(rejected: readonly RejectedCase[]): Record<FilterReason, number> {
  const counts: Record<FilterReason, number> = {
    "too-many-files": 0,
    "diff-too-large": 0,
    "malformed-diff": 0,
  };
  for (const item of rejected) {
    counts[item.reason] += 1;
  }
  return counts;
}
