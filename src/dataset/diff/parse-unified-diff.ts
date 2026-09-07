import {
  type DiffLine,
  type DiffLineType,
  type FileDiff,
  type Hunk,
  type Result,
  DiffParseError,
  err,
  normalizeDiffPath,
  ok,
} from "./types.js";

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: (.*))?$/;
const NO_NEWLINE_MARKER = "\\ No newline at end of file";

interface HunkHeader {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly section?: string;
}

/**
 * 解析 unified diff 文本为结构化 FileDiff 列表。
 * 支持 git diff 与 diff -u 两种文件头；二进制与纯重命名文件显式报错（fail fast）。
 * 路径归一化：剥 `a/`、`b/` 前缀；`/dev/null` 归一为 null（创建/删除文件）。
 */
export function parseUnifiedDiff(text: string): Result<readonly FileDiff[]> {
  if (typeof text !== "string" || text.trim() === "") {
    return err(new DiffParseError("diff 文本为空", 0));
  }
  const lines = splitDiffLines(text);
  const files: FileDiff[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("diff --git") || line.startsWith("Index:")) {
      const skip = skipGitHeader(lines, i);
      if (skip.error !== undefined) {
        return err(skip.error);
      }
      i = skip.next;
      continue;
    }
    if (line.startsWith("--- ")) {
      const block = parseFileBlock(lines, i);
      if (!block.result.ok) {
        return block.result;
      }
      files.push(block.result.value);
      i = block.next;
      continue;
    }
    return err(new DiffParseError(`期望文件头（---）但得到: ${line.slice(0, 60)}`, i + 1));
  }
  if (files.length === 0) {
    return err(new DiffParseError("diff 不含任何文件变更块", 1));
  }
  return ok(files);
}

function splitDiffLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

/** 跳过 git 风格文件头噪音行（diff --git / index / mode）；返回下一有效位置 */
function skipGitHeader(
  lines: readonly string[],
  start: number,
): { readonly next: number; readonly error?: DiffParseError } {
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (
      line.startsWith("diff --git") ||
      line.startsWith("Index:") ||
      line.startsWith("index ") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("similarity index")
    ) {
      i += 1;
      continue;
    }
    if (line.startsWith("rename from") || line.startsWith("rename to")) {
      return { next: i, error: new DiffParseError("纯重命名文件不被支持", i + 1) };
    }
    if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
      return { next: i, error: new DiffParseError("二进制文件不被支持", i + 1) };
    }
    return { next: i };
  }
  return { next: i };
}

/** 解析一个 `--- / +++` 文件块（含其全部 hunk） */
function parseFileBlock(
  lines: readonly string[],
  start: number,
): { readonly next: number; readonly result: Result<FileDiff> } {
  const oldRaw = lines[start]!.slice(4);
  const plusLine = lines[start + 1];
  if (plusLine === undefined || !plusLine.startsWith("+++ ")) {
    return {
      next: start,
      result: err(new DiffParseError("文件头 --- 之后缺少 +++ 行", start + 2)),
    };
  }
  const oldPath = headerPathOrError(oldRaw, "旧", start + 1);
  if (oldPath instanceof DiffParseError) {
    return { next: start, result: err(oldPath) };
  }
  const newPath = headerPathOrError(plusLine.slice(4), "新", start + 2);
  if (newPath instanceof DiffParseError) {
    return { next: start, result: err(newPath) };
  }
  if (oldPath === null && newPath === null) {
    return {
      next: start,
      result: err(new DiffParseError("文件头新旧路径均为 /dev/null", start + 1)),
    };
  }
  const hunksRes = parseHunks(lines, start + 2);
  if (!hunksRes.result.ok) {
    return { next: start, result: hunksRes.result };
  }
  const hunks = hunksRes.result.value;
  const kindError = validateFileKind(oldPath, newPath, hunks, start + 1);
  if (kindError !== undefined) {
    return { next: start, result: err(kindError) };
  }
  const endFlags = deriveFileEndFlags(hunks);
  return {
    next: hunksRes.next,
    result: ok({
      oldPath,
      newPath,
      hunks,
      oldNoNewlineAtEnd: endFlags.oldNoNewline,
      newNoNewlineAtEnd: endFlags.newNoNewline,
    }),
  };
}

function headerPathOrError(
  raw: string,
  sideLabel: string,
  lineNo: number,
): string | null | DiffParseError {
  if (raw.trim() === "") {
    return new DiffParseError(`${sideLabel}侧文件头路径为空`, lineNo);
  }
  return normalizeDiffPath(raw);
}

/** 创建文件必须旧侧计数为 0；删除文件必须新侧计数为 0 */
function validateFileKind(
  oldPath: string | null,
  newPath: string | null,
  hunks: readonly Hunk[],
  lineNo: number,
): DiffParseError | undefined {
  if (oldPath === null && hunks.some((h) => h.oldCount !== 0 || h.oldStart !== 0)) {
    return new DiffParseError("新文件（--- /dev/null）的 hunk 旧侧计数必须为 0", lineNo);
  }
  if (newPath === null && hunks.some((h) => h.newCount !== 0 || h.newStart !== 0)) {
    return new DiffParseError("删除文件（+++ /dev/null）的 hunk 新侧计数必须为 0", lineNo);
  }
  return undefined;
}

interface FileEndFlags {
  readonly oldNoNewline: boolean;
  readonly newNoNewline: boolean;
}

/**
 * 从 hunk 行推导文件两侧「末尾无换行」标记。
 * no-newline 标记只可能作用于最后一个 hunk 两侧各自的最后一行。
 */
function deriveFileEndFlags(hunks: readonly Hunk[]): FileEndFlags {
  const last = hunks.at(-1);
  if (last === undefined) {
    return { oldNoNewline: false, newNoNewline: false };
  }
  const oldSide = last.lines.filter((l) => l.type !== "add");
  const newSide = last.lines.filter((l) => l.type !== "remove");
  return {
    oldNoNewline: oldSide.at(-1)?.noNewlineAtEnd === true,
    newNoNewline: newSide.at(-1)?.noNewlineAtEnd === true,
  };
}

/** 解析一个文件块内从 start 开始的连续 hunk */
function parseHunks(
  lines: readonly string[],
  start: number,
): { readonly next: number; readonly result: Result<readonly Hunk[]> } {
  const hunks: Hunk[] = [];
  let i = start;
  while (i < lines.length && lines[i]!.startsWith("@@ ")) {
    const header = parseHunkHeader(lines[i]!, i + 1);
    if (header instanceof DiffParseError) {
      return { next: start, result: err(header) };
    }
    const body = parseHunkBody(lines, i + 1, header, i + 1);
    if (!body.result.ok) {
      return { next: start, result: body.result };
    }
    hunks.push(body.result.value);
    i = body.next;
  }
  if (hunks.length === 0) {
    return { next: start, result: err(new DiffParseError("文件块不含任何 hunk", start + 1)) };
  }
  const overlap = checkOverlap(hunks);
  if (overlap !== undefined) {
    return { next: start, result: err(overlap) };
  }
  return { next: i, result: ok(hunks) };
}

function parseHunkHeader(line: string, lineNo: number): HunkHeader | DiffParseError {
  const match = HUNK_HEADER_RE.exec(line);
  if (match === null) {
    return new DiffParseError(`hunk 头格式非法: ${line.slice(0, 60)}`, lineNo);
  }
  const oldStart = Number(match[1]);
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  const oldInvalid =
    !Number.isInteger(oldStart) || !Number.isInteger(oldCount) || oldCount < 0 || (oldCount > 0 && oldStart < 1);
  const newInvalid =
    !Number.isInteger(newStart) || !Number.isInteger(newCount) || newCount < 0 || (newCount > 0 && newStart < 1);
  if (oldInvalid) {
    return new DiffParseError(`旧侧行号非法: -${oldStart},${oldCount}`, lineNo);
  }
  if (newInvalid) {
    return new DiffParseError(`新侧行号非法: +${newStart},${newCount}`, lineNo);
  }
  const section = match[5];
  return {
    oldStart,
    oldCount,
    newStart,
    newCount,
    ...(section !== undefined ? { section } : {}),
  };
}

/** 解析 hunk 体直到 old/new 计数耗尽；no-newline 标记可出现在体内（EOF 行之后） */
function parseHunkBody(
  lines: readonly string[],
  start: number,
  header: HunkHeader,
  headerLineNo: number,
): { readonly next: number; readonly result: Result<Hunk> } {
  const out: DiffLine[] = [];
  let oldNeed = header.oldCount;
  let newNeed = header.newCount;
  let i = start;
  while (oldNeed > 0 || newNeed > 0) {
    const line = lines[i];
    if (line === undefined) {
      return {
        next: start,
        result: err(
          new DiffParseError(
            `hunk 体不完整（第 ${headerLineNo} 行 hunk 头声明 ${header.oldCount}+${header.newCount} 行）`,
            i,
          ),
        ),
      };
    }
    if (line === NO_NEWLINE_MARKER) {
      const attach = attachNoNewline(out, i + 1);
      if (attach !== undefined) {
        return { next: start, result: err(attach) };
      }
      i += 1;
      continue;
    }
    const type = lineTypeOf(line, i + 1);
    if (type instanceof DiffParseError) {
      return { next: start, result: err(type) };
    }
    if (type === "context") {
      oldNeed -= 1;
      newNeed -= 1;
    } else if (type === "remove") {
      oldNeed -= 1;
    } else {
      newNeed -= 1;
    }
    if (oldNeed < 0 || newNeed < 0) {
      return {
        next: start,
        result: err(new DiffParseError(`hunk 体行数超出头部声明（第 ${headerLineNo} 行）`, i + 1)),
      };
    }
    out.push({ type, text: line.slice(1) });
    i += 1;
  }
  while (i < lines.length && lines[i] === NO_NEWLINE_MARKER) {
    const attach = attachNoNewline(out, i + 1);
    if (attach !== undefined) {
      return { next: start, result: err(attach) };
    }
    i += 1;
  }
  return {
    next: i,
    result: ok({
      oldStart: header.oldStart,
      oldCount: header.oldCount,
      newStart: header.newStart,
      newCount: header.newCount,
      ...(header.section !== undefined ? { section: header.section } : {}),
      lines: out,
    }),
  };
}

/** 将 no-newline 标记附加到 hunk 体前一行（不可重复附加） */
function attachNoNewline(out: DiffLine[], lineNo: number): DiffParseError | undefined {
  const prev = out.at(-1);
  if (prev === undefined || prev.noNewlineAtEnd === true) {
    return new DiffParseError("no-newline 标记位置非法（无前一行或重复标记）", lineNo);
  }
  out[out.length - 1] = { ...prev, noNewlineAtEnd: true };
  return undefined;
}

function lineTypeOf(line: string, lineNo: number): DiffLineType | DiffParseError {
  if (line.startsWith(" ")) {
    return "context";
  }
  if (line.startsWith("-")) {
    return "remove";
  }
  if (line.startsWith("+")) {
    return "add";
  }
  if (line.startsWith("@@ ") || line.startsWith("--- ") || line.startsWith("diff --git")) {
    return new DiffParseError(`hunk 体在计数耗尽前遇到新结构行: ${line.slice(0, 40)}`, lineNo);
  }
  return new DiffParseError(`hunk 体出现无法识别的行: ${line.slice(0, 40)}`, lineNo);
}

/** 校验 hunk 在旧/新两侧均不重叠（顺序游走 apply 的前提） */
function checkOverlap(hunks: readonly Hunk[]): DiffParseError | undefined {
  let prevOldEnd = 0;
  let prevNewEnd = 0;
  for (const h of hunks) {
    if (h.oldCount > 0 && h.oldStart < prevOldEnd) {
      return new DiffParseError(`旧侧 hunk 重叠: -${h.oldStart},${h.oldCount}`, 0);
    }
    if (h.newCount > 0 && h.newStart < prevNewEnd) {
      return new DiffParseError(`新侧 hunk 重叠: +${h.newStart},${h.newCount}`, 0);
    }
    prevOldEnd = h.oldStart + h.oldCount;
    prevNewEnd = h.newStart + h.newCount;
  }
  return undefined;
}
