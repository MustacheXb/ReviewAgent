/**
 * Loop 硬上界（spec #1 / 主文档第 3 章）。
 * 硬上界不可通过 options 覆盖——"单次检视成本有界"是骨架的约束，不是配置项。
 */
export const MAX_ROUNDS = 5;
export const MAX_TOOL_CALLS = 6;

/** 截断原因常量（写入 RunAudit.truncationReasons） */
export const TRUNCATION_MAX_ROUNDS = "MAX_ROUNDS_REACHED";
export const TRUNCATION_TOOL_BUDGET = "TOOL_BUDGET_EXHAUSTED";
