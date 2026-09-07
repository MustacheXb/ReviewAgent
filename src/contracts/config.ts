/**
 * 实验配置契约（spec #1「五个实验配置 A–E」）。
 *
 * 共享契约：工单实现者可扩展字段，但不得破坏既有字段语义；
 * 若必须变更，须在工单完成报告中声明。
 */

export type ConfigId = "A" | "B" | "C" | "D" | "E";

/**
 * 外部参照配置键（Ticket 13 / issue #14）：Claude Code 跨模型外部参照在指标层的
 * 单列伪配置位。永不进入 ExperimentPlan.configs / labels.allowedConfigs / S-A-B
 * 判定（CONFIGS 仍是 A–E 主矩阵宇宙）——仅作为 RunResult.configId 与指标
 * 分组键，让归一化后的参照 Finding 走同一 evaluateRun / buildMetricsReport 管线。
 */
export const REFERENCE_CONFIG_ID = "claude-code" as const;
export type ReferenceConfigId = typeof REFERENCE_CONFIG_ID;

/** 指标层配置键全集 = A–E 主矩阵 + 外部参照单列（T13） */
export type MetricsConfigId = ConfigId | ReferenceConfigId;

export interface ReviewConfig {
  readonly configId: ConfigId;
  /** A/B = false（零工具）；C/D/E = true（同一套 7 个 review.* 工具，schema 字节一致） */
  readonly toolsEnabled: boolean;
  /** B = true：固定管线确定性预取（Diff → Symbol → Reference → Call Chain） */
  readonly prefetch: boolean;
  /** C = true：全仓注入（效果上限，带预算守卫） */
  readonly fullRepo: boolean;
  /** D/E = true：Zone A 稳定前缀纪律 */
  readonly stablePrefix: boolean;
  /** E = true：Context Ledger + Append-only（完整形态） */
  readonly ledger: boolean;
}

export const CONFIGS: Readonly<Record<ConfigId, ReviewConfig>> = {
  A: { configId: "A", toolsEnabled: false, prefetch: false, fullRepo: false, stablePrefix: false, ledger: false },
  B: { configId: "B", toolsEnabled: false, prefetch: true, fullRepo: false, stablePrefix: false, ledger: false },
  C: { configId: "C", toolsEnabled: true, prefetch: false, fullRepo: true, stablePrefix: false, ledger: false },
  D: { configId: "D", toolsEnabled: true, prefetch: false, fullRepo: false, stablePrefix: true, ledger: false },
  E: { configId: "E", toolsEnabled: true, prefetch: false, fullRepo: false, stablePrefix: true, ledger: true },
};
