/**
 * Context Ledger 契约（spec #1 工单 #8：config E 完整形态，T07）。
 *
 * 语义界定（主文档「Context Ledger」节 + T05 报告确立的分区纪律）：
 * - Ledger 登记本次 run 已加载的上下文单元，四类 kind 对应 spec 的
 *   loaded_files / loaded_ranges / loaded_symbols / loaded_evidence；
 * - 去重只发生在工具结果层（Zone C）：同一规范化请求的重复调用返回
 *   "Already loaded: ctx#NNN" 式引用而非原文——同时降低 Input Token
 *   并避免 Context Reorder（Token Optimization + Cache Optimization 双重价值）；
 * - 命中语义 = 规范化请求的精确重复（同 kind + 同 description）；不同参数
 *   （即使内容可能重叠，如整读后的子区间读取）不命中——子区间包含判定
 *   属 Phase 2+ 消融，POC1 保持最薄；
 * - 状态属 run 私有：每个 run 从空账本开始，跨 run 互不影响；
 * - 读取失败不登记（错误不是上下文），重试仍走真实读取路径；
 * - Zone A 不受影响：工具 schema 与 system prompt 字节不依赖 Ledger 状态。
 *
 * 工具 schema 属 Zone A（字节稳定），Ledger 只影响工具结果（Zone C append-only）。
 */

/** 条目种类：映射 loaded_files / loaded_ranges / loaded_symbols / loaded_evidence 四类登记 */
export type LedgerEntryKind = "file" | "range" | "symbol" | "evidence";

/** 一条已登记的上下文单元（审计留痕的最小形态） */
export interface LedgerEntry {
  /** 引用标识（ctx#001 起顺序编号；run 内唯一、按登记顺序确定） */
  readonly id: string;
  readonly kind: LedgerEntryKind;
  /** 规范化请求标识（含工具名与全部入参；同字节即同一上下文单元） */
  readonly description: string;
}

/**
 * 工具结果层去重账本（run 私有）。
 * 实现见 src/tools/ledger.ts（功能态 / 惰性态）；
 * ToolRunContext.ledger 持有其一，各工具在 execute 入口处接入。
 */
export interface ContextLedger {
  /**
   * 命中查询：已登记返回引用文本（"Already loaded: ctx#NNN (…)"），
   * 未登记返回 undefined。引用格式由实现统一保证（工具不各自拼装）。
   */
  referenceIfLoaded(kind: LedgerEntryKind, description: string): string | undefined;
  /** 读取成功后登记（调用方保证仅在未命中路径调用；失败的工具调用不登记） */
  register(kind: LedgerEntryKind, description: string): void;
  /** 当前快照（防御性拷贝；runReview 审计留痕用） */
  snapshot(): readonly LedgerEntry[];
}
