import { describe, expect, it } from "vitest";
import type { RunResult } from "../../src/contracts/run.js";
import { DEFAULT_JUDGE_MODEL, GptJudgeClient, OPENAI_API_KEY_ENV_VAR } from "../../src/judge/index.js";
import { judgeRun } from "../../src/judge/orchestrate.js";
import { flattenJudgeRun } from "../../src/judge/report.js";
import { SAMPLE_MR_CASE } from "../fixtures/sample-mr-case.js";

/**
 * 冒烟 e2e（Ticket 11）：LLM-as-judge（与被测模型不同源）真实 API × 样例 MR × 判定链双口径。
 *
 * 运行条件：环境变量 OPENAI_API_KEY 存在（key 只经环境变量注入，绝不回显/落盘）。
 * 可选 E2E_JUDGE_MODEL 覆盖判定模型（异构 id，如 glm-5-3-260814 @ 火山网关——
 * 配 OPENAI_URL 指向网关端点；#33 glm-5.3 冒烟即此形态）；缺省 gpt-5.2-pro。
 * 无 key 时显式 SKIP——`pnpm test` 零网络，本文件仅在 `pnpm test:e2e` 中运行。
 */

const rawEnvKey = process.env[OPENAI_API_KEY_ENV_VAR];
const hasApiKey = typeof rawEnvKey === "string" && rawEnvKey.trim().length > 0;
/** 覆盖判定模型（可选；null = DEFAULT_JUDGE_MODEL——与计划字段同哨兵） */
const e2eJudgeModel = process.env.E2E_JUDGE_MODEL?.trim() || null;

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
        // 规则粗筛的性质匹配：category 须与真值 defectNature 同词表归一
        // （样例真值 = CORRECTNESS；BOUNDARY 不经别名映射，会被记 NO_NATURE_MATCH）
        category: "CORRECTNESS",
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
      cacheBreaks: [],
      truncated: false,
      truncationReasons: [],
    },
  };
}

describe.skipIf(!hasApiKey)("smoke e2e: judge × sample MR × 判定链双口径", () => {
  it(
    "adjudicates the sample run over the real judge API and produces dual-mode metrics",
    async () => {
      // key/端点/模型均从环境变量读取；缺失构造时 fail fast（E2E_JUDGE_MODEL 可覆盖模型，#33）
      const judge = new GptJudgeClient(e2eJudgeModel === null ? {} : { model: e2eJudgeModel });
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
        `[gpt-judge-smoke-e2e] model=${e2eJudgeModel ?? `${DEFAULT_JUDGE_MODEL} (default)`} ` +
          `status=${result.status} ` +
          `rule={tp:${result.ruleCounts.tp},fp:${result.ruleCounts.fp},fn:${result.ruleCounts.fn}} ` +
          `judge={tp:${result.judgeCounts.tp},fp:${result.judgeCounts.fp},fn:${result.judgeCounts.fn}} ` +
          `disagreements=${result.disagreements.length} anomalies=${result.anomalies.length} ` +
          `F001=${f001?.outcome}/${f001?.matchConfidence}`,
      );
    },
    360_000,
  );
});
