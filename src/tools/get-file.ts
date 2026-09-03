import path from "node:path";
import { applyLineBudget } from "./result-budget.js";
import type { ReviewToolDefinition } from "./registry.js";
import { optionalPositiveIntArg, requireStringArg } from "./registry.js";
import type { RepoContext } from "../zoneb/repo-context.js";

/**
 * review.get_file：读取仓库快照中的文件（支持行区间读取）。
 *
 * - 路径为仓库相对 POSIX 路径；反斜杠归一化，拒绝绝对路径与 ".." 越界（防路径逃逸）；
 * - 读取经 RepoContext（CRLF→LF 归一化、确定性）；文件缺失/不可读为显式有界错误，
 *   错误信息不泄漏仓库绝对路径（请求字节可跨环境复现）；
 * - 行区间：start 超出文件尾为显式错误；end 超出文件尾截断到文件尾并留痕；
 * - 输出行带行号（证据引用需要行号）；超预算在行边界截断并留痕。
 */

export const GET_FILE_TOOL: ReviewToolDefinition = {
  name: "review.get_file",
  description:
    "Read a file from the repository snapshot. Supports an optional 1-based inclusive line range (startLine/endLine).",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Repository-relative POSIX path of the file to read.",
      },
      startLine: {
        type: "integer",
        description: "First line to read (1-based, inclusive). Optional; defaults to 1.",
      },
      endLine: {
        type: "integer",
        description: "Last line to read (1-based, inclusive). Optional; defaults to end of file.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  execute: async (args, context): Promise<string> => {
    const rawPath = requireStringArg("review.get_file", args, "path");
    const startLine = optionalPositiveIntArg("review.get_file", args, "startLine");
    const endLine = optionalPositiveIntArg("review.get_file", args, "endLine");
    if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
      throw new Error(
        `review.get_file: argument "startLine" (${startLine}) must not exceed "endLine" (${endLine})`,
      );
    }

    const posixPath = normalizeRepoPath("review.get_file", rawPath);
    const repo = await context.repo();
    const source = await readSourceSafe(repo, posixPath);
    const lines = splitFileLines(source);
    return renderFileSlice(posixPath, lines, { startLine, endLine }, context.resultBudgetChars);
  },
};

/** 仓库相对 POSIX 路径归一化与校验（拒绝绝对路径与 ".." 越界段） */
export function normalizeRepoPath(toolName: string, rawPath: string): string {
  const posix = rawPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) {
    throw new Error(`${toolName}: path must be repository-relative, got absolute path "${posix}"`);
  }
  const segments = posix.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.includes("..")) {
    throw new Error(`${toolName}: path "${posix}" must stay inside the repository snapshot`);
  }
  return segments.join("/");
}

/** 读取 + 边界守卫：仓库根外或缺失/不可读一律归为有界错误（不泄漏绝对路径） */
async function readSourceSafe(repo: RepoContext, posixPath: string): Promise<string> {
  const absolute = path.resolve(repo.repoPath, ...posixPath.split("/"));
  const root = path.resolve(repo.repoPath);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error(`review.get_file: path "${posixPath}" must stay inside the repository snapshot`);
  }
  try {
    return await repo.readSource(posixPath);
  } catch {
    throw new Error(
      `review.get_file: file "${posixPath}" cannot be read from the repository snapshot (not found or unreadable)`,
    );
  }
}

/** 行拆分（文件尾换行不产生伪行；空文件为 0 行） */
function splitFileLines(source: string): readonly string[] {
  if (source.length === 0) {
    return [];
  }
  const body = source.endsWith("\n") ? source.slice(0, -1) : source;
  return body.split("\n");
}

interface FileSlice {
  readonly startLine: number | undefined;
  readonly endLine: number | undefined;
}

function renderFileSlice(
  posixPath: string,
  lines: readonly string[],
  slice: FileSlice,
  budgetChars: number,
): string {
  const totalLines = lines.length;
  if (totalLines === 0) {
    return [`File: ${posixPath}`, "Lines 0-0 of 0 (empty file)"].join("\n");
  }
  const requestedStart = slice.startLine ?? 1;
  if (requestedStart > totalLines) {
    throw new Error(
      `review.get_file: requested start line ${requestedStart} is beyond end of file "${posixPath}" (${totalLines} lines)`,
    );
  }
  const clampedEnd =
    slice.endLine !== undefined && slice.endLine > totalLines ? totalLines : (slice.endLine ?? totalLines);
  const clampedNote =
    slice.endLine !== undefined && slice.endLine > totalLines
      ? ` (requested end line ${slice.endLine} clamped to end of file)`
      : "";

  const selected = lines.slice(requestedStart - 1, clampedEnd);
  const header = [
    `File: ${posixPath}`,
    `Lines ${requestedStart}-${clampedEnd} of ${totalLines}${clampedNote}`,
  ];
  const numbered = numberLines(selected, requestedStart);
  const budget = applyLineBudget(
    [...header, ...numbered],
    budgetChars,
    (shown, total) =>
      `Tool result truncated: showing ${shown} of ${total} result lines (tool result budget ${budgetChars} chars exceeded); request a narrower range with startLine/endLine.`,
  );
  return budget.lines.join("\n");
}

/** 行号右对齐前缀（宽度按展示区间内最大行号） */
function numberLines(lines: readonly string[], firstLineNumber: number): readonly string[] {
  const width = String(firstLineNumber + lines.length - 1).length;
  return lines.map((line, index) => {
    const lineNumber = String(firstLineNumber + index).padStart(width, " ");
    return `${lineNumber} | ${line}`;
  });
}
