import {
  type FileDiff,
  type Hunk,
  type Result,
  DiffApplyError,
  err,
  ok,
} from "./types.js";
import { parseUnifiedDiff } from "./parse-unified-diff.js";

/** 源码快照：仓库相对路径 → 文件内容（纯数据，无 IO） */
export type SourceSnapshot = Readonly<Record<string, string>>;

export interface AppliedChange {
  /** 变更后的文件快照（仅含被本 diff 触碰的文件；删除的文件不在其中） */
  readonly sources: Readonly<Record<string, string>>;
  /** 被删除的文件路径 */
  readonly deletedPaths: readonly string[];
}

/**
 * 将 unified diff 应用到源码快照（严格模式：context 与 remove 行必须逐字匹配，
 * 无模糊匹配）。纯函数，零 IO；应用于逆 diff 即得 buggy 版本（逆补丁法语义）。
 */
export function applyUnifiedDiff(
  sources: SourceSnapshot,
  diffText: string,
): Result<AppliedChange> {
  const parsed = parseUnifiedDiff(diffText);
  if (!parsed.ok) {
    return parsed;
  }
  const out: Record<string, string> = {};
  const deleted: string[] = [];
  for (const file of parsed.value) {
    const applied = applyFileDiff(sources, file);
    if (!applied.ok) {
      return applied;
    }
    if (applied.value === null) {
      deleted.push(file.oldPath!);
    } else {
      out[file.newPath!] = applied.value;
    }
  }
  return ok({ sources: out, deletedPaths: deleted });
}

/** 应用单个文件 diff；删除文件返回 null（sentinel），创建文件要求目标不存在 */
function applyFileDiff(sources: SourceSnapshot, file: FileDiff): Result<string | null> {
  if (file.newPath === null) {
    return applyDeletion(sources, file.oldPath!);
  }
  const oldContent = file.oldPath === null ? undefined : sources[file.oldPath];
  if (file.oldPath !== null && oldContent === undefined) {
    return err(
      new DiffApplyError(`文件 ${file.oldPath} 不在源码快照中（diff 与快照路径不一致）`),
    );
  }
  if (file.oldPath === null && sources[file.newPath] !== undefined) {
    return err(
      new DiffApplyError(`新文件 ${file.newPath} 已存在于源码快照中`),
    );
  }
  const oldFile = splitFileLines(oldContent ?? "");
  const newLines: string[] = [];
  let oldPos = 1;
  for (const hunk of file.hunks) {
    const step = applyHunk(hunk, oldFile.lines, oldPos, file.newPath!);
    if (!step.ok) {
      return step;
    }
    newLines.push(...step.value.copied);
    newLines.push(...step.value.added);
    oldPos = step.value.nextOldPos;
  }
  if (oldPos <= oldFile.lines.length) {
    newLines.push(...oldFile.lines.slice(oldPos - 1));
  }
  const endsWithNewline = resolveNewlineAtEnd(file, oldFile, oldPos, newLines);
  return ok(joinFileLines(newLines, endsWithNewline));
}

function applyDeletion(sources: SourceSnapshot, oldPath: string): Result<null> {
  if (sources[oldPath] === undefined) {
    return err(new DiffApplyError(`待删除文件 ${oldPath} 不在源码快照中`));
  }
  return ok(null);
}

interface HunkApplyStep {
  /** hunk 之前需原样复制的旧行 */
  readonly copied: readonly string[];
  /** hunk 产生的新行（context + add） */
  readonly added: readonly string[];
  /** hunk 消费后的旧文件游标（1 起始） */
  readonly nextOldPos: number;
}

function applyHunk(
  hunk: Hunk,
  oldLines: readonly string[],
  oldPos: number,
  displayPath: string,
): Result<HunkApplyStep> {
  // oldCount === 0 表示纯插入：oldStart 为插入点之前的行号（0 = 文件开头）
  const effectiveStart = hunk.oldCount === 0 ? hunk.oldStart + 1 : hunk.oldStart;
  if (effectiveStart < oldPos) {
    return err(
      new DiffApplyError(
        `文件 ${displayPath} 的 hunk（-${hunk.oldStart},${hunk.oldCount}）与已应用内容重叠`,
      ),
    );
  }
  if (effectiveStart - 1 > oldLines.length) {
    return err(
      new DiffApplyError(
        `文件 ${displayPath} 的 hunk 起始行 ${effectiveStart} 超出文件长度 ${oldLines.length}`,
      ),
    );
  }
  const copied = oldLines.slice(oldPos - 1, effectiveStart - 1);
  const added: string[] = [];
  let cursor = effectiveStart;
  for (const line of hunk.lines) {
    if (line.type === "add") {
      added.push(line.text);
      continue;
    }
    const oldLine = oldLines[cursor - 1];
    if (oldLine === undefined || oldLine !== line.text) {
      return err(
        new DiffApplyError(
          `文件 ${displayPath} 第 ${cursor} 行与 diff 不匹配：期望 ${JSON.stringify(line.text)}，实际 ${JSON.stringify(oldLine ?? "<EOF>")}`,
        ),
      );
    }
    if (line.type === "context") {
      added.push(line.text);
    }
    cursor += 1;
  }
  if (cursor - 1 > oldLines.length) {
    return err(
      new DiffApplyError(`文件 ${displayPath} 的 hunk 超出文件末尾（长度 ${oldLines.length}）`),
    );
  }
  return { ok: true, value: { copied, added, nextOldPos: cursor } };
}

interface SplitFile {
  readonly lines: readonly string[];
  readonly endsWithNewline: boolean;
}

function splitFileLines(content: string): SplitFile {
  if (content === "") {
    return { lines: [], endsWithNewline: false };
  }
  const endsWithNewline = content.endsWith("\n");
  const body = endsWithNewline ? content.slice(0, -1) : content;
  return { lines: body.split("\n"), endsWithNewline };
}

function joinFileLines(lines: readonly string[], endsWithNewline: boolean): string {
  if (lines.length === 0) {
    return "";
  }
  return lines.join("\n") + (endsWithNewline ? "\n" : "");
}

/**
 * 新文件末尾换行状态：
 * - 末个 hunk 消费完所有旧行（新文件末行来自 hunk）→ 由该行 no-newline 标记决定；
 * - 否则新文件末行是 hunk 之外的旧尾行 → 沿用旧文件状态。
 */
function resolveNewlineAtEnd(
  file: FileDiff,
  oldFile: SplitFile,
  nextOldPos: number,
  newLines: readonly string[],
): boolean {
  const consumedAll = nextOldPos > oldFile.lines.length;
  if (!consumedAll) {
    return oldFile.endsWithNewline;
  }
  const lastHunk = file.hunks.at(-1)!;
  const lastNewSide = lastHunk.lines.filter((l) => l.type !== "remove").at(-1);
  if (lastNewSide === undefined) {
    return newLines.length > 0 ? false : oldFile.endsWithNewline;
  }
  return lastNewSide.noNewlineAtEnd !== true;
}
