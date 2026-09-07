import { type FileDiff, type Hunk, type Result, DatasetError, err, ok } from "./types.js";

/**
 * 将结构化 FileDiff 列表序列化为 unified diff 文本。
 * 输出为 diff -u 风格（--- / +++ + @@ hunk），路径为仓库相对路径（无 a/ b/ 前缀），
 * 与 parseUnifiedDiff 互为逆操作（round-trip 稳定）。
 */
export function serializeUnifiedDiff(files: readonly FileDiff[]): Result<string> {
  if (files.length === 0) {
    return err(new DatasetError("EMPTY_DIFF", "无可序列化的文件变更块"));
  }
  const blocks: string[] = [];
  for (const file of files) {
    const blockError = validateFileForSerialize(file);
    if (blockError !== undefined) {
      return err(blockError);
    }
    blocks.push(serializeFile(file));
  }
  return ok(blocks.join(""));
}

function validateFileForSerialize(file: FileDiff): DatasetError | undefined {
  if (file.hunks.length === 0) {
    return new DatasetError("EMPTY_FILE_DIFF", `文件 ${file.newPath ?? file.oldPath} 不含 hunk`);
  }
  if (file.oldPath === null && file.hunks.some((h) => h.oldCount !== 0)) {
    return new DatasetError("INVALID_FILE_KIND", `新文件 ${file.newPath} 的 hunk 旧侧计数必须为 0`);
  }
  if (file.newPath === null && file.hunks.some((h) => h.newCount !== 0)) {
    return new DatasetError("INVALID_FILE_KIND", `删除文件 ${file.oldPath} 的 hunk 新侧计数必须为 0`);
  }
  return undefined;
}

function serializeFile(file: FileDiff): string {
  const header =
    `--- ${file.oldPath ?? "/dev/null"}\n` + `+++ ${file.newPath ?? "/dev/null"}\n`;
  return header + file.hunks.map((h) => serializeHunk(h)).join("");
}

function serializeHunk(hunk: Hunk): string {
  const head = `@@ -${rangeText(hunk.oldStart, hunk.oldCount)} +${rangeText(hunk.newStart, hunk.newCount)} @@${hunk.section === undefined ? "" : ` ${hunk.section}`}\n`;
  const body = hunk.lines
    .map((line) => {
      const prefix = line.type === "context" ? " " : line.type === "remove" ? "-" : "+";
      const text = `${prefix}${line.text}\n`;
      return line.noNewlineAtEnd === true ? `${text}\\ No newline at end of file\n` : text;
    })
    .join("");
  return head + body;
}

/** unified diff 范围文本：count === 1 时省略 `,1`；count === 0 时必须显式 `,0` */
function rangeText(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}
