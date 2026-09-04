import type { LlmResponse } from "../../src/contracts/llm-client.js";
import { reply, usage } from "./llm-script.js";

/**
 * config A 快乐路径的六阶段脚本化回复（一轮完成）。
 * 每次调用的 usage 互不相同，用于断言 usage 记账求和正确。
 */

export const HAPPY_PATH_FINDING = {
  id: "F001",
  severity: "P1",
  category: "CORRECTNESS",
  file: "src/main/java/com/example/math/MathUtils.java",
  line: 20,
  title: "Off-by-one loop bound reads one element beyond the requested range",
  description:
    "The loop condition 'i <= count' accesses values[count]; when count equals values.length this throws an ArrayIndexOutOfBoundsException.",
  evidence: [
    "Diff replaces 'for (int i = 0; i < count; i++)' with 'for (int i = 0; i <= count; i++)' at src/main/java/com/example/math/MathUtils.java line 20",
    "Calculator.total passes readings with count without clamping, so count can equal readings.length",
  ],
  rule: "CORRECTNESS-001",
  confidence: 0.95,
} as const;

export const HAPPY_PATH_RESPONSES: readonly LlmResponse[] = [
  reply(
    JSON.stringify({
      summary:
        "The MR modifies MathUtils.sumFirst in src/main/java/com/example/math/MathUtils.java, changing the loop bound from 'i < count' to 'i <= count', which reads one element beyond the requested range.",
    }),
    usage(100, 10),
  ),
  reply(
    JSON.stringify({
      riskClass: "Medium",
      reason: "The change alters core arithmetic logic in a helper used by Calculator.",
    }),
    usage(110, 20, { cacheReadTokens: 50 }),
  ),
  reply(
    JSON.stringify({
      neededContext: ["Callers of MathUtils.sumFirst", "Whether count can equal values.length"],
      reason: "To assess the off-by-one impact, callers and array length usage must be known.",
    }),
    usage(120, 30, { cacheReadTokens: 60 }),
  ),
  reply(
    JSON.stringify({
      notes: "No tools are available in this configuration; the diff and the conversation context are the only available evidence.",
    }),
    usage(130, 40, { cacheReadTokens: 70 }),
  ),
  reply(
    JSON.stringify({ candidates: [HAPPY_PATH_FINDING] }),
    usage(140, 50, { cacheReadTokens: 80 }),
  ),
  reply(
    JSON.stringify({
      verdicts: [
        {
          id: "F001",
          pass: true,
          reason: "The diff excerpt directly shows the loop bound change; the off-by-one is real.",
        },
      ],
      complete: true,
    }),
    usage(150, 60, { cacheReadTokens: 90, cacheWriteTokens: 40 }),
  ),
];

/** 快乐路径 usage 总账（六次调用求和） */
export const HAPPY_PATH_TOTAL_USAGE = {
  inputTokens: 750,
  outputTokens: 210,
  cacheReadTokens: 350,
  cacheWriteTokens: 40,
} as const;
