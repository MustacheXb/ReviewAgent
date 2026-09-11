/**
 * POC1 工具箱 → DSH ToolDefinition 适配层（#20：review-context 工具接线）。
 *
 * 零重写纪律：7 个 review.* 工具的 schema 与执行语义全部来自冻结 harness 的
 * buildReviewToolkit（codeintel / zoneb / Ledger / 结果预算 1:1 复用），本层只做
 * 注册面形状转换：
 * - parameters：注册表 canonical 串 → object（JSON round-trip 保持键序，
 *   wire 序列化字节与 POC1 parametersJson 逐字节一致——wire.test 锁线）；
 * - execute：DSH 解析后的参数对象 → argumentsJson → 冻结 executor（含
 *   readThroughLedger 与未知工具 / 非法入参的有界失败）；
 * - output：canonical value = 工具结果字符串本身（POC1 工具契约即裸字符串），
 *   render 投影为单一 text 块；
 * - isConcurrencySafe 省略 = 独占串行（对齐 POC1 串行执行循环与 run 私有 Ledger）。
 */

import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { ToolDefinition, ToolGuard } from "@deepseek-ai/dsh-tools";

import type { ToolSchema as Poc1ToolSchema } from "../../../../src/contracts/llm-client.js";
import type { ToolExecutor } from "../../../../src/loop/tools.js";
import type { ReviewToolkit } from "../../../../src/tools/toolkit.js";

/** 预算拒绝理由（POC1 SKIPPED 文案去前缀；DSH 物化为 "Error: <reason>" 工具错误结果） */
const TOOL_BUDGET_EXHAUSTED_REASON = "tool call budget exhausted";

/**
 * 预算拒绝的物化结果文本（dsh-tools 拒绝路径固定为 `Error: ${reason}` 且
 * isError=true）——runtime 据此从事件流辨识预算拒绝，归因 phaseLog note。
 */
export const TOOL_BUDGET_DENIED_TEXT = `Error: ${TOOL_BUDGET_EXHAUSTED_REASON}`;

/**
 * POC1 工具箱 → 7 个 DSH ToolDefinition（顺序 = toolkit.tools = REVIEW_TOOL_ORDER）。
 * run 私有：每个检视会话用独立 toolkit（独立 Ledger）构建，闭包持有其 executor。
 */
export function toDshToolDefinitions(toolkit: ReviewToolkit): readonly ToolDefinition[] {
  return toolkit.tools.map((tool) => toDshToolDefinition(tool, toolkit.executor));
}

function toDshToolDefinition(tool: Poc1ToolSchema, executor: ToolExecutor): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: JSON.parse(tool.parametersJson) as Record<string, unknown>,
    output: {
      schema: { type: "string" },
      render: (_args: unknown, value: unknown): ContentBlock[] => [{ type: "text", text: String(value) }],
    },
    execute: (args: unknown, exec) =>
      executor.execute({
        id: exec.callId,
        name: tool.name,
        // 注册表工具统一消费 argumentsJson（解析失败的入参经 executor 有界报错）
        argumentsJson: JSON.stringify(args ?? {}),
      }),
  };
}

/** max_tool_calls 预算守卫句柄：guard 注册进 DSH 注册面，闭包计数供审计读取 */
export interface ToolBudgetGuard {
  /** 预分发守卫：放行 = undefined；拒绝 = 拒绝理由 */
  readonly guard: ToolGuard;
  /** 已放行（实际发生）的调用数：POC1 toolCalls 语义（执行 + 失败计入，恒 ≤ max） */
  allowedCount(): number;
  /** 被拒次数（预算耗尽后仍尝试的调用：只进 toolCallLog，不计入 toolCalls） */
  deniedCount(): number;
}

/**
 * max_tool_calls 守卫（POC1 上界语义的 DSH 注册面形态）：每次放行计数 +1，
 * 达到上界后每次尝试拒绝。守卫在预分发阶段同步运行——同回复内并行组也不可能
 * 超限（JS 单线程下计数自增原子）。
 */
export function createToolBudgetGuard(maxToolCalls: number): ToolBudgetGuard {
  let allowed = 0;
  let denied = 0;
  return {
    guard: (): string | undefined => {
      if (allowed >= maxToolCalls) {
        denied += 1;
        return TOOL_BUDGET_EXHAUSTED_REASON;
      }
      allowed += 1;
      return undefined;
    },
    allowedCount: () => allowed,
    deniedCount: () => denied,
  };
}
