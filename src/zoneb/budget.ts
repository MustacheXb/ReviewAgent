/**
 * 预算层：Zone B 与预取各层的字符预算（POC1 无 tokenizer，以字符数为确定性代理）。
 *
 * 纪律（spec #1 工单 #4）：超限截断必须留痕——
 * - 截断发生在条目（block）边界，不切断条目内部；
 * - 截断时在内容末尾追加确定性提示行（可见于请求字节与审计）；
 * - 每层产出结构化 PrefetchLayerRecord 进审计，杜绝静默丢弃。
 */

export interface BlockBudgetResult {
  /** 各 block 的行（含截断提示行，若发生截断） */
  readonly lines: readonly string[];
  readonly totalBlocks: number;
  readonly shownBlocks: number;
  readonly truncated: boolean;
}

/**
 * 在预算内尽可能多地保留 block（每 block 为一组行）。
 * 计入预算的是 block 以空行相连后的总字符数（与最终渲染一致）。
 */
export function applyBlockBudget(
  blocks: readonly (readonly string[])[],
  budgetChars: number,
  buildNotice: (shown: number, total: number) => string,
): BlockBudgetResult {
  if (blocks.length === 0) {
    return { lines: [], totalBlocks: 0, shownBlocks: 0, truncated: false };
  }
  let shown = 0;
  for (let count = 1; count <= blocks.length; count++) {
    const candidate = joinBlocks(blocks.slice(0, count));
    if (candidate.length > budgetChars) {
      break;
    }
    shown = count;
  }
  if (shown === blocks.length) {
    return {
      lines: blocks.flatMap((block) => [...block]),
      totalBlocks: blocks.length,
      shownBlocks: blocks.length,
      truncated: false,
    };
  }
  const kept = blocks.slice(0, shown);
  const notice = buildNotice(shown, blocks.length);
  return {
    lines: [...kept.flatMap((block) => [...block]), notice],
    totalBlocks: blocks.length,
    shownBlocks: shown,
    truncated: true,
  };
}

function joinBlocks(blocks: readonly (readonly string[])[]): string {
  return blocks.map((block) => block.join("\n")).join("\n\n");
}
