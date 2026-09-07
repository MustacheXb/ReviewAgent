import {
  type DiffLine,
  type FileDiff,
  type Hunk,
  type Result,
} from "./types.js";
import { parseUnifiedDiff } from "./parse-unified-diff.js";
import { serializeUnifiedDiff } from "./serialize-unified-diff.js";

/**
 * 逆补丁法核心（Ticket 02）：生成 unified diff 的语义反向。
 *
 * 对每个 hunk：新旧范围互换（行号即原新侧/旧侧行号，无需重算偏移——
 * unified diff 的两侧行号各自单调递增，互换后仍满足顺序 apply 的前提）；
 * 行前缀 `-`/`+` 互换，context 保留。文件头 ---/+++ 路径互换（创建↔删除）。
 *
 * 语义保证：apply(reverse(patch), fixed) === buggy，
 * 即「将逆 diff 应用于修复后版本得到历史真实 buggy 版本」。
 * 这正是 patch -R / git apply -R 的等价变换，但以纯函数实现并可序列化。
 */
export function reverseUnifiedDiff(diffText: string): Result<string> {
  const parsed = parseUnifiedDiff(diffText);
  if (!parsed.ok) {
    return parsed;
  }
  const reversed = parsed.value.map(reverseFileDiff);
  return serializeUnifiedDiff(reversed);
}

export function reverseFileDiff(file: FileDiff): FileDiff {
  return {
    oldPath: file.newPath,
    newPath: file.oldPath,
    hunks: file.hunks.map(reverseHunk),
    oldNoNewlineAtEnd: file.newNoNewlineAtEnd,
    newNoNewlineAtEnd: file.oldNoNewlineAtEnd,
  };
}

function reverseHunk(hunk: Hunk): Hunk {
  return {
    oldStart: hunk.newStart,
    oldCount: hunk.newCount,
    newStart: hunk.oldStart,
    newCount: hunk.oldCount,
    ...(hunk.section !== undefined ? { section: hunk.section } : {}),
    lines: hunk.lines.map(reverseLine),
  };
}

function reverseLine(line: DiffLine): DiffLine {
  if (line.type === "add") {
    return { ...line, type: "remove" };
  }
  if (line.type === "remove") {
    return { ...line, type: "add" };
  }
  return line;
}
