import { readThroughLedger } from "./ledger.js";
import { applyLineBudget } from "./result-budget.js";
import type { ReviewToolDefinition } from "./registry.js";

/**
 * review.get_diff：返回本次 MR 的 unified diff（检视对象本体）。
 *
 * 输出确定性：同一 MRCase → 同一字节；超预算在行边界截断并留痕。
 * T07 Context Ledger：diff 登记为 evidence（Evidence Policy：diff 即首要证据源），
 * 重复读取返回 "Already loaded: ctx#NNN" 引用而非原文（config E 功能态）。
 */

/** Ledger 登记标识（无入参，请求本身即标识） */
const GET_DIFF_LEDGER_DESCRIPTION = "review.get_diff";

export const GET_DIFF_TOOL: ReviewToolDefinition = {
  name: "review.get_diff",
  description: "Return the unified diff of the merge request under review.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  execute: async (_args, context): Promise<string> =>
    readThroughLedger(context.ledger, "evidence", GET_DIFF_LEDGER_DESCRIPTION, async () => {
      const lines = ["MR unified diff:", ...context.diff.split("\n")];
      const budget = applyLineBudget(
        lines,
        context.resultBudgetChars,
        (shown, total) =>
          `Tool result truncated: showing ${shown} of ${total} diff lines (tool result budget ${context.resultBudgetChars} chars exceeded).`,
      );
      return budget.lines.join("\n");
    }),
};
