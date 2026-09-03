import { describe, expect, it } from "vitest";
import type { RunResult } from "../../src/contracts/run.js";
import { GptJudgeClient, OPENAI_API_KEY_ENV_VAR } from "../../src/judge/gpt-judge-client.js";
import { judgeRun } from "../../src/judge/orchestrate.js";
import { flattenJudgeRun } from "../../src/judge/report.js";
import { SAMPLE_MR_CASE } from "../fixtures/sample-mr-case.js";

/**
 * 冒烟 e2e（Ticket 11）：GPT 系 LLM-as-judge 真实 API × 样例 MR × 判定链双口径。
 *
 * 运行条件：环境变量 OPENAI_API_KEY 存在（key 只经环境变量注入，绝不回显/落盘）。
 * 无 key 时显式 SKIP——`pnpm test` 零网络，本文件仅在 `pnpm test:e2e` 中运行。
 */

const rawEnvKey = process.env[OPENAI_API_KEY_ENV_VAR];
const hasApiKey = typeof rawEnvKey === "string" && rawEnvKey.trim().length > 0;

if (!hasApiKey) {
  console.info(
    "[gpt-judge-smoke-e2e] OPENAI_API_KEY is not set: the real-API judge smoke e2e is SKIPPED. " +
      "Export OPENAI_API_KEY and run `pnpm test:e2e` to execute it.",
  );
}

/** 手工构造的检视输出：一条命中真值的 Finding + 一条误报（对齐样例 MR 真值） */
function sampleRunResult(): RunResult {
  return {
    caseId: SAMPLE_MR_CASE.caseId,
    configId: "C",
    findings: [
      {
        id: "F001",
        severity: "P1",
        category: "BOUNDARY",
        file: "src/main/java/com/example/math/MathUtils.java",
        line: 20,
        title: "Off-by-one loop bound reads one element past the array",
        description:
          "sumFirst uses 'i <= count' and reads values[count]; when count equals values.length this is an out-of-bounds read (ArrayIndexOutOfBoundsException).",
        evidence: ["src/main/java/com/example/math/MathUtils.java:20"],
        rule: "LOOP_BOUNDARY",
        confidence: 0.95,
      },
      {
        id: "F002",
        severity: "P3",
        category: "PERFORMANCE",
        file: "src/main/java/com/example/math/MathUtils.java",
        line: 19,
        title: "Method could be inlined for performance",
        description: "A tiny static helper adds call overhead; inlining may improve throughput.",
        evidence: ["src/main/java/com/example/math/MathUtils.java:19"],
        rule: "MICRO_PERF",
        confidence: 0.3,
      },
    ],
    usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0 },
    rounds: 2,
    toolCalls: 1,
    audit: {
      requests: [],
      toolCallLog: [],
      phaseLog: [],
      rejections: [],
      truncated: false,
      truncationReasons: [],
    },
  };
}

describe.skipIf(!hasApiKey)("smoke e2e: GPT judge × sample MR × 判定链双口径", () => {
  it(
    "adjudicates the sample run over the real OpenAI API and produces dual-mode metrics",
    async () => {
      const judge = new GptJudgeClient(); // key 从环境变量读取；缺失构造时 fail fast
      const result = await judgeRun(sampleRunResult(), SAMPLE_MR_CASE, judge);

      // 判定链完整走通：真实 judge 裁定归一为结构化 TP/FP + 理由
      expect(result.status).toBe("judged");
      expect(result.errorMessage).toBeNull();
      expect(result.judgeVerdicts).toHaveLength(2);

      // 双口径指标经 T10 纯函数重算并可直接投影进聚合管线
      const ruleFlat = flattenJudgeRun(result, "rule");
      const judgeFlat = flattenJudgeRun(result, "judge");
      expect(ruleFlat.lineTp).toBe(1);
      expect(ruleFlat.lineFp).toBe(1);
      expect((judgeFlat.lineTp ?? 0) + (judgeFlat.lineFp ?? 0)).toBe(2);

      // 真实 judge 对样例 MR 的预期：F001（真命中）应被确认为 TP
      const f001 = result.judgeVerdicts.find((verdict) => verdict.findingId === "F001");
      expect(f001?.outcome).toBe("TP");
      expect(f001?.matchConfidence).toMatch(/high|medium|low/);
      expect(typeof f001?.judgeReason).toBe("string");

      console.info(
        `[gpt-judge-smoke-e2e] status=${result.status} ` +
          `rule={tp:${result.ruleCounts.tp},fp:${result.ruleCounts.fp},fn:${result.ruleCounts.fn}} ` +
          `judge={tp:${result.judgeCounts.tp},fp:${result.judgeCounts.fp},fn:${result.judgeCounts.fn}} ` +
          `disagreements=${result.disagreements.length} anomalies=${result.anomalies.length} ` +
          `F001=${f001?.outcome}/${f001?.matchConfidence}`,
      );
    },
    360_000,
  );
});
