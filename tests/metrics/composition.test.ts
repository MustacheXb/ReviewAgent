import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONFIGS } from "../../src/contracts/config.js";
import { FakeLlmClient } from "../../src/fake/fake-llm-client.js";
import {
  buildMetricsReport,
  evaluateCase,
  evaluateRun,
} from "../../src/metrics/aggregate.js";
import { judgeAllVerdicts } from "../../src/metrics/verdict.js";
import { runReview } from "../../src/run/run-review.js";
import { SAMPLE_MR_CASE } from "../fixtures/sample-mr-case.js";
import { HAPPY_PATH_RESPONSES } from "../helpers/happy-path-script.js";
import { usage } from "../helpers/llm-script.js";
import { makeFinding, makeRunResult, makeTruth, makeTruthLocation } from "./helpers.js";

/**
 * 组合链路（供 Ticket 12 运行器复用的完整弹道，纯函数旁路直测、不经 LLM 判定）：
 * runReview(主 seam) → evaluateRun/evaluateCase/buildMetricsReport → judgeAllVerdicts。
 */

let auditDir: string;

beforeAll(async () => {
  auditDir = await mkdtemp(path.join(tmpdir(), "review-agent-metrics-"));
});

afterAll(async () => {
  await rm(auditDir, { recursive: true, force: true });
});

describe("metrics composition — runReview output feeds the evaluation bypass", () => {
  it("screens the real harness RunResult against the sample MR truth", async () => {
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    const run = await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, { auditDir });
    const metrics = evaluateRun(run, SAMPLE_MR_CASE);

    expect(metrics.lineCounts).toEqual({ tp: 1, fp: 0, fn: 0 });
    expect(metrics.fileCounts).toEqual({ tp: 1, fp: 0, fn: 0 });
    expect(metrics.lineLevel).toEqual({ recall: 1, precision: 1, f1: 1 });
    expect(metrics.screening.verdicts[0]).toMatchObject({
      outcome: "TP",
      matchedTruthIndex: 0,
      lineOffset: 0,
    });
    // HAPP_PATH 总账：750 输入 + 350 缓存读 + 40 缓存写 + 210 输出
    expect(metrics.tokens.totalTokens).toBe(1350);
    expect(metrics.tokens.cacheHitRate).toBeCloseTo(350 / 1140, 12);
    expect(metrics.efficiency.carc).toBe(750 + 40 + 210);
    expect(metrics.efficiency.rie).toBeCloseTo(1 / 1.35, 12);
  });

  it("runs the full chain: reps → layered report → S/A/B verdict with anchor C", async () => {
    const fake1 = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    const fake2 = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    const rep1 = await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake1, { auditDir });
    const rep2 = await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake2, { auditDir });

    const caseReport = evaluateCase({
      mrCase: SAMPLE_MR_CASE,
      runsByConfig: { A: [rep1, rep2] },
    });
    expect(caseReport.perConfig.A?.repCount).toBe(2);
    expect(caseReport.perConfig.A?.hot?.values.lineRecall?.mean).toBe(1);

    // 锚 C（全仓）+ 主力 E（Minimal + Ledger）：E 以约 30% token 达到同 Recall、热命中率 ≥ 85%
    const tpRun = (configId: "C" | "E", usageValue: ReturnType<typeof usage>) =>
      makeRunResult({
        caseId: SAMPLE_MR_CASE.caseId,
        configId,
        findings: [
          makeFinding({ file: "src/main/java/com/example/math/MathUtils.java", line: 20 }),
        ],
        usage: usageValue,
      });
    const anchorCase = {
      mrCase: SAMPLE_MR_CASE,
      runsByConfig: {
        C: [tpRun("C", usage(10000, 500)), tpRun("C", usage(10000, 500))],
        E: [tpRun("E", usage(3000, 300)), tpRun("E", usage(400, 300, { cacheReadTokens: 2400 }))],
      },
    };
    const report = buildMetricsReport([anchorCase]);
    const verdicts = judgeAllVerdicts(report);

    expect(verdicts.anchorAvailable).toBe(true);
    const eVerdict = verdicts.verdicts.find((v) => v.configId === "E");
    expect(eVerdict?.outcome).toBe("S");
    expect(eVerdict?.grade).toBe("S");
    expect(eVerdict?.basis).toContain("Grade S achieved");
    // 锚 C 自身：Token 比率 1.0 超限 → BELOW_B（机械判定，锚不豁免）
    const cVerdict = verdicts.verdicts.find((v) => v.configId === "C");
    expect(cVerdict?.outcome).toBe("BELOW_B");
  });
});

describe("screening against the inverse-patch truth shape", () => {
  it("matches a multi-location truth (minimal fix patch touching two files)", () => {
    const truth = makeTruth([
      makeTruthLocation({
        file: "src/main/java/com/example/math/MathUtils.java",
        lineStart: 20,
        lineEnd: 20,
        defectNature: "CORRECTNESS",
      }),
      makeTruthLocation({
        file: "src/main/java/com/example/math/Calculator.java",
        lineStart: 45,
        lineEnd: 47,
        defectNature: "NULL_SAFETY",
      }),
    ]);
    const mrCase = { ...SAMPLE_MR_CASE, truth };
    const run = makeRunResult({
      caseId: SAMPLE_MR_CASE.caseId,
      configId: "C",
      findings: [
        makeFinding({ id: "F1", file: "src/main/java/com/example/math/MathUtils.java", line: 20, category: "CORRECTNESS" }),
        makeFinding({ id: "F2", file: "src/main/java/com/example/math/Calculator.java", line: 46, category: "NULL_SAFETY" }),
        makeFinding({ id: "F3", file: "src/main/java/com/example/math/Calculator.java", line: 99, category: "SECURITY" }),
      ],
    });
    const metrics = evaluateRun(run, mrCase);
    expect(metrics.lineCounts).toEqual({ tp: 2, fp: 1, fn: 0 });
    expect(metrics.fileCounts).toEqual({ tp: 2, fp: 1, fn: 0 });
    expect(metrics.lineLevel.recall).toBe(1);
    expect(metrics.lineLevel.precision).toBeCloseTo(2 / 3, 12);
  });
});
