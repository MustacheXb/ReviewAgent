import type { LlmMessage } from "../contracts/llm-client.js";
import type { FullRepoRecord } from "../contracts/run.js";
import type { RepoContext } from "./repo-context.js";

/**
 * config C 全仓注入（spec #1 工单 #6；主文档第 6 章配置 C「Full Repository 效果上限」）。
 *
 * - 注入范围 = 仓库快照的全部 Java 源文件（排序路径序），复用 RepoContext 确定性读取层
 *   （CRLF→LF 归一化；同仓状态 → 字节级相同输出）；
 * - 预算守卫：超限截断必须留痕——整文件优先装满，装不下整文件时行级截断并显式标记，
 *   末尾追加确定性总提示行（可见于请求字节与审计），杜绝静默丢弃；
 * - 产出 FullRepoRecord 进审计（RunAudit.fullRepo）。
 *
 * 非 Zone B：config C 的全仓注入是 run 级上下文（随 diff 之后追加，Zone C 起点），
 * 不参与「同仓多次检视字节稳定」的 Zone B 纪律。
 */

/** 默认字符预算（≈20K tokens @4 chars/token，主文档第 6 章 Context Budget 上限） */
export const DEFAULT_FULL_REPO_BUDGET_CHARS = 80_000;

/** 截断提示中最多列出的未注入文件路径数 */
const MAX_LISTED_OMITTED_FILES = 20;

const INTRO_LINES: readonly string[] = [
  "Full repository context (config C). Deterministically injected from the repository snapshot",
  "(zero-build, no LLM). Java source files are listed in sorted path order; budget truncation is explicit.",
];

export interface FullRepoInjectionInput {
  readonly repo: RepoContext;
  readonly budgetChars: number;
}

export interface FullRepoInjection {
  readonly message: LlmMessage;
  readonly record: FullRepoRecord;
}

export async function buildFullRepoInjection(
  input: FullRepoInjectionInput,
): Promise<FullRepoInjection> {
  const budget = input.budgetChars;
  if (input.repo.javaFiles.length === 0) {
    const content = [...INTRO_LINES, "No Java files found in the repository snapshot."].join("\n");
    return {
      message: { role: "user", content },
      record: { budgetChars: budget, contentChars: content.length, truncated: false, totalFiles: 0, shownFiles: 0 },
    };
  }

  const fill = await fillFilesInBudget(input.repo, budget);
  const parts = [INTRO_LINES.join("\n"), ...fill.blocks];
  if (fill.shownFiles < input.repo.javaFiles.length) {
    parts.push(buildTruncationNotice(input.repo.javaFiles, fill, budget));
  }

  const content = parts.join("\n\n");
  return {
    message: { role: "user", content },
    record: {
      budgetChars: budget,
      contentChars: content.length,
      truncated: fill.shownFiles < input.repo.javaFiles.length,
      totalFiles: input.repo.javaFiles.length,
      shownFiles: fill.shownFiles,
    },
  };
}

interface BudgetFillResult {
  /** 已装入的文件块（整文件或行级截断尾块） */
  readonly blocks: readonly string[];
  readonly shownFiles: number;
  /** 最后一个装入的文件是否被行级截断 */
  readonly lastFilePartial: boolean;
  /** 第一个未装入文件的索引（= 文件总数 表示全部装入） */
  readonly stopIndex: number;
}

/**
 * 前锋装填：按排序路径序逐个装整文件；装不下整文件时行级截断装尾块，然后停止
 * （保持注入文件为排序清单的连续前缀，截断规模最小化且有界）。
 */
async function fillFilesInBudget(repo: RepoContext, budgetChars: number): Promise<BudgetFillResult> {
  const blocks: string[] = [];
  let used = INTRO_LINES.join("\n").length;
  let shownFiles = 0;
  let lastFilePartial = false;

  for (let index = 0; index < repo.javaFiles.length; index++) {
    const file = repo.javaFiles[index];
    if (file === undefined) {
      break;
    }
    const source = await repo.readSource(file);
    const lines = splitFileLines(source);
    const header = `## File: ${file} (${lines.length} lines)`;
    const blockText = [header, ...lines].join("\n");
    if (used + 2 + blockText.length <= budgetChars) {
      blocks.push(blockText);
      used += 2 + blockText.length;
      shownFiles++;
      continue;
    }
    const partial = buildPartialBlock(header, lines, budgetChars - used - 2);
    if (partial !== undefined) {
      blocks.push(partial);
      shownFiles++;
      lastFilePartial = true;
      return { blocks, shownFiles, lastFilePartial, stopIndex: index + 1 };
    }
    return { blocks, shownFiles, lastFilePartial, stopIndex: index };
  }
  return { blocks, shownFiles, lastFilePartial, stopIndex: repo.javaFiles.length };
}

function buildTruncationNotice(
  javaFiles: readonly string[],
  fill: BudgetFillResult,
  budgetChars: number,
): string {
  const partialNote = fill.lastFilePartial
    ? " The last included file is line-truncated (full-repo budget exceeded)."
    : "";
  const omitted = listOmitted(javaFiles.slice(fill.stopIndex));
  return `Full repository context truncated: showing ${fill.shownFiles} of ${javaFiles.length} files (budget ${budgetChars} chars exceeded).${partialNote} Files not included: ${omitted}`;
}

/** 行级截断的尾块（装不下整文件时，保留头部 + 能装下的行数 + 留痕行）；装不下任何行则 undefined */
function buildPartialBlock(
  header: string,
  lines: readonly string[],
  remainingChars: number,
): string | undefined {
  const notice = "(file truncated; full-repo budget exceeded)";
  const fixed = header.length + 1 + notice.length;
  if (remainingChars < fixed) {
    return undefined;
  }
  let shown = 0;
  let used = fixed;
  for (const line of lines) {
    if (used + 1 + line.length > remainingChars) {
      break;
    }
    used += 1 + line.length;
    shown++;
  }
  if (shown === 0) {
    return undefined;
  }
  return [header, ...lines.slice(0, shown), notice].join("\n");
}

function listOmitted(files: readonly string[]): string {
  const listed = files.slice(0, MAX_LISTED_OMITTED_FILES);
  const rest = files.length - listed.length;
  const names = listed.length > 0 ? listed.join(", ") : "(none)";
  return rest > 0 ? `${names} (+${rest} more)` : names;
}

function splitFileLines(source: string): readonly string[] {
  if (source.length === 0) {
    return [];
  }
  const body = source.endsWith("\n") ? source.slice(0, -1) : source;
  return body.split("\n");
}
