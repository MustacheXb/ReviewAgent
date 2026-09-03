/**
 * 工具结果预算层：超长结果在行边界截断并显式留痕（不静默丢弃）。
 *
 * 纪律（与 zoneb/budget.ts 一致）：截断时在内容末尾追加确定性提示行，
 * 提示行携带预算与截断规模，可见于请求字节与审计 toolCallLog。
 * 预算以字符数为代理（POC1 无 tokenizer；字符计数跨平台确定）。
 */

/** 单次工具结果的默认字符预算（≈2K tokens @4 chars/token） */
export const DEFAULT_TOOL_RESULT_BUDGET_CHARS = 8_000;

export interface LineBudgetResult {
  /** 保留的行（含截断提示行，若发生截断） */
  readonly lines: readonly string[];
  readonly truncated: boolean;
  readonly shownLines: number;
  readonly totalLines: number;
}

/**
 * 在预算内保留最长的行前缀（行边界截断，不切断行内部）。
 * 计入预算的是保留行以 "\n" 连接后的总字符数；截断提示行不计入。
 */
export function applyLineBudget(
  lines: readonly string[],
  budgetChars: number,
  buildNotice: (shown: number, total: number) => string,
): LineBudgetResult {
  if (lines.length === 0) {
    return { lines: [], truncated: false, shownLines: 0, totalLines: 0 };
  }
  let shown = 0;
  let used = 0;
  for (const line of lines) {
    const candidate = shown === 0 ? line.length : used + 1 + line.length;
    if (candidate > budgetChars) {
      break;
    }
    used = candidate;
    shown++;
  }
  if (shown === lines.length) {
    return { lines: [...lines], truncated: false, shownLines: shown, totalLines: lines.length };
  }
  const notice = buildNotice(shown, lines.length);
  return {
    lines: [...lines.slice(0, shown), notice],
    truncated: true,
    shownLines: shown,
    totalLines: lines.length,
  };
}
