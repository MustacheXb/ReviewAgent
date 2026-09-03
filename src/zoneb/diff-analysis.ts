/**
 * Diff 层分析（config B 固定管线第一层：Diff → Symbol → Reference → Call Chain）。
 *
 * 从 unified diff 提取：
 * - 变更文件清单（b 侧路径；删除文件回退 a 侧），POSIX 相对路径、排序去重；
 * - 每个 hunk 的旧侧行区间（仓库快照是 MR 前版本 = base，符号求交以旧侧行号为准）。
 *
 * 确定性：仅字符串解析，无环境依赖；同一 diff 永远同一结果。
 */

export interface DiffHunk {
  /** 旧侧（base 版本）起始行，1-based */
  readonly oldStart: number;
  readonly oldCount: number;
  /** 新侧起始行，1-based */
  readonly newStart: number;
  readonly newCount: number;
}

export interface FileDiff {
  readonly file: string;
  readonly hunks: readonly DiffHunk[];
}

export interface DiffAnalysis {
  /** 按路径排序的变更文件及其 hunk 列表 */
  readonly files: readonly FileDiff[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_HEADER = /^diff --git a\/(.+) b\/(.+)$/;

/** 解析 unified diff；无任何可识别文件头时显式抛错（fail fast，不静默空结果） */
export function analyzeDiff(diff: string): DiffAnalysis {
  const hunksByFile = new Map<string, DiffHunk[]>();
  let currentFile: string | undefined;
  for (const rawLine of diff.split("\n")) {
    const line = stripTrailingTimestamp(rawLine);
    const gitHeader = DIFF_GIT_HEADER.exec(line);
    if (gitHeader !== null) {
      const [, aPath, bPath] = gitHeader;
      currentFile = pickChangedPath(aPath, bPath);
      continue;
    }
    if (line.startsWith("--- a/")) {
      // --- 与 +++ 成对出现：先记 a 侧，随后 +++ b/ 覆盖（删除文件时 +++ 为 /dev/null，保留 a 侧）
      currentFile = line.slice("--- a/".length);
      continue;
    }
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice("+++ b/".length);
      continue;
    }
    if (line.startsWith("+++ /dev/null")) {
      continue; // currentFile 保持 a 侧路径
    }
    const hunk = HUNK_HEADER.exec(line);
    if (hunk !== null) {
      const file = currentFile;
      if (file === undefined) {
        throw new Error("diff hunk appeared before any file header");
      }
      const entry = hunksByFile.get(file) ?? [];
      entry.push({
        oldStart: parsePositiveInt(hunk[1]),
        oldCount: hunk[2] !== undefined ? parsePositiveInt(hunk[2]) : 1,
        newStart: parsePositiveInt(hunk[3]),
        newCount: hunk[4] !== undefined ? parsePositiveInt(hunk[4]) : 1,
      });
      hunksByFile.set(file, entry);
    }
  }
  if (hunksByFile.size === 0) {
    throw new Error(
      "diff contains no parsable file headers (expected \"diff --git\" or \"+++ b/<path>\" lines)",
    );
  }
  const files = [...hunksByFile.entries()]
    .map(([file, hunks]) => ({ file, hunks }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { files };
}

/** 变更文件的旧侧（base）行区间列表；纯新增（oldCount=0）以单行近似 */
export function oldSpansOf(fileDiff: FileDiff): readonly { readonly startLine: number; readonly endLine: number }[] {
  return fileDiff.hunks.map((hunk) => {
    const endLine = hunk.oldStart + Math.max(hunk.oldCount, 1) - 1;
    return { startLine: hunk.oldStart, endLine };
  });
}

function pickChangedPath(aPath: string | undefined, bPath: string | undefined): string {
  if (bPath !== undefined && bPath !== "/dev/null") {
    return bPath;
  }
  if (aPath !== undefined && aPath !== "/dev/null") {
    return aPath;
  }
  throw new Error("diff --git header carries no usable path");
}

function stripTrailingTimestamp(line: string): string {
  const tabIndex = line.indexOf("\t");
  return tabIndex >= 0 ? line.slice(0, tabIndex) : line;
}

function parsePositiveInt(value: string | undefined): number {
  if (value === undefined) {
    throw new Error("diff hunk header is missing a line number");
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`diff hunk header carries an invalid line number: ${JSON.stringify(value)}`);
  }
  return parsed;
}
