/**
 * Unified diff 结构化模型与错误类型（Ticket 02）。
 *
 * 所有 diff 模块（parse / serialize / reverse / apply）共享本模型。
 * 输入一律为 unified diff 文本（git diff 或 diff -u 风格），
 * 路径支持 `a/`、`b/` 前缀，解析后归一化为仓库相对路径。
 */

/** 数据集侧统一错误：带稳定错误码，便于上游过滤报告留痕 */
export class DatasetError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DatasetError";
    this.code = code;
  }
}

/** diff 解析错误：附 1 起始行号，便于定位坏输入 */
export class DiffParseError extends DatasetError {
  readonly line: number;

  constructor(message: string, line: number) {
    super("DIFF_PARSE_ERROR", `line ${line}: ${message}`);
    this.name = "DiffParseError";
    this.line = line;
  }
}

/** diff 应用错误：hunk 上下文与目标文件不匹配等 */
export class DiffApplyError extends DatasetError {
  constructor(message: string) {
    super("DIFF_APPLY_ERROR", message);
    this.name = "DiffApplyError";
  }
}

/** 单行 diff 内容：context 保留行 / remove 旧侧删除行 / add 新侧新增行 */
export type DiffLineType = "context" | "remove" | "add";

export interface DiffLine {
  readonly type: DiffLineType;
  /** 行文本（不含前缀符与行终止符） */
  readonly text: string;
  /** 本行为所在侧文件最后一行且该侧文件末尾无换行符（`\ No newline at end of file`） */
  readonly noNewlineAtEnd?: boolean;
}

export interface Hunk {
  /** 旧侧（--- 对应文件）起始行号，1 起始 */
  readonly oldStart: number;
  /** 旧侧行数（context + remove） */
  readonly oldCount: number;
  /** 新侧（+++ 对应文件）起始行号，1 起始 */
  readonly newStart: number;
  /** 新侧行数（context + add） */
  readonly newCount: number;
  /** hunk 头 `@@ ... @@` 之后的段落标记（原样保留） */
  readonly section?: string;
  /** hunk 体：按出现顺序排列的行 */
  readonly lines: readonly DiffLine[];
}

/** 文件级 diff：一个 `--- / +++` 块 */
export interface FileDiff {
  /** 归一化旧路径（无 a/ 前缀）；新文件为 /dev/null 占位之外的创建场景见 oldPath === null */
  readonly oldPath: string | null;
  /** 归一化新路径（无 b/ 前缀）；删除文件时为 null */
  readonly newPath: string | null;
  readonly hunks: readonly Hunk[];
  /** 旧侧文件末尾无换行符 */
  readonly oldNoNewlineAtEnd: boolean;
  /** 新侧文件末尾无换行符 */
  readonly newNoNewlineAtEnd: boolean;
}

/** 纯函数结果：不抛异常，错误显式传递 */
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DatasetError };

export const ok = <T>(value: T): { readonly ok: true; readonly value: T } => ({
  ok: true,
  value,
});

export const err = <T>(error: DatasetError): Result<T> => ({ ok: false, error });

export const DEV_NULL = "/dev/null";

/** 归一化 diff 头路径：剥 a/ b/ 前缀与时间戳尾巴；/dev/null 归一为 null */
export function normalizeDiffPath(raw: string): string | null {
  const stripped = raw.split("\t")[0]!.trim();
  if (stripped === DEV_NULL || stripped === "") {
    return null;
  }
  const unquoted = stripped.startsWith('"') && stripped.endsWith('"')
    ? stripped.slice(1, -1)
    : stripped;
  if (unquoted.startsWith("a/") || unquoted.startsWith("b/")) {
    return unquoted.slice(2);
  }
  return unquoted;
}
