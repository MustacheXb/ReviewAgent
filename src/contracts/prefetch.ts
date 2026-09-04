/**
 * config B 预取契约（spec #1 工单 #4）：
 * Zone B 静态构造 + 固定管线确定性预取（Diff → Symbol → Reference → Call Chain）。
 *
 * 预算以字符数为代理（POC1 无 tokenizer；字符计数跨平台确定）。
 * 默认值参考主文档第 6 章 Budget（Zone B ≈ 4K tokens、Symbol ≈ 2K、Impact ≈ 3K，按 ~4 chars/token 折算）。
 */

/** 预取注入层名（固定管线顺序） */
export type PrefetchLayerName = "zone-b" | "symbol" | "reference" | "call-chain";

/** 一层的注入记录（留痕：截断与否、预算、条目数） */
export interface PrefetchLayerRecord {
  readonly layer: PrefetchLayerName;
  readonly budgetChars: number;
  /** 最终注入内容的字符数（含截断提示行） */
  readonly contentChars: number;
  readonly truncated: boolean;
  /** 条目总数（截断前） */
  readonly totalEntries: number;
  /** 实际注入条目数 */
  readonly shownEntries: number;
}

export interface PrefetchOptions {
  /** Zone B（Repo Map + Symbol Index）字符预算，默认 16000 */
  readonly zoneBBudgetChars?: number;
  /** 预取 Symbol 层字符预算，默认 8000 */
  readonly symbolLayerBudgetChars?: number;
  /** 预取 Reference 层字符预算，默认 6000 */
  readonly referenceLayerBudgetChars?: number;
  /** 预取 Call Chain 层字符预算，默认 6000 */
  readonly callChainLayerBudgetChars?: number;
}

export interface ResolvedPrefetchBudgets {
  readonly zoneBBudgetChars: number;
  readonly symbolLayerBudgetChars: number;
  readonly referenceLayerBudgetChars: number;
  readonly callChainLayerBudgetChars: number;
}

export const DEFAULT_PREFETCH_BUDGETS: ResolvedPrefetchBudgets = {
  zoneBBudgetChars: 16_000,
  symbolLayerBudgetChars: 8_000,
  referenceLayerBudgetChars: 6_000,
  callChainLayerBudgetChars: 6_000,
};

export function resolvePrefetchBudgets(options: PrefetchOptions | undefined): ResolvedPrefetchBudgets {
  if (options === undefined) {
    return DEFAULT_PREFETCH_BUDGETS;
  }
  return {
    zoneBBudgetChars: options.zoneBBudgetChars ?? DEFAULT_PREFETCH_BUDGETS.zoneBBudgetChars,
    symbolLayerBudgetChars: options.symbolLayerBudgetChars ?? DEFAULT_PREFETCH_BUDGETS.symbolLayerBudgetChars,
    referenceLayerBudgetChars: options.referenceLayerBudgetChars ?? DEFAULT_PREFETCH_BUDGETS.referenceLayerBudgetChars,
    callChainLayerBudgetChars: options.callChainLayerBudgetChars ?? DEFAULT_PREFETCH_BUDGETS.callChainLayerBudgetChars,
  };
}
