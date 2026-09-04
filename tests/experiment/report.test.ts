import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Finding } from "../../src/contracts/finding.js";
import type { ToolCallRecord, RunResult } from "../../src/contracts/run.js";
import { FakeJudgeClient } from "../../src/judge/fake-judge-client.js";
import { FakeLlmClient } from "../../src/fake/fake-llm-client.js";
import { FAILURES_FILE, loadPersistedCases, loadPersistedPlan, runExperiment } from "../../src/experiment/runner.js";
import {
  JudgeStore,
  buildExperimentReport,
  persistExperimentReport,
  rebuildExperimentOutcome,
} from "../../src/experiment/report.js";
import type { ExperimentReport } from "../../src/experiment/report.js";
import { toRunSnapshot } from "../../src/experiment/run-store.js";
import type { RunRecord } from "../../src/experiment/run-store.js";
import type { ExperimentSource } from "../../src/experiment/plan.js";
import { HAPPY_PATH_FINDING, HAPPY_PATH_RESPONSES, HAPPY_PATH_TOTAL_USAGE } from "../helpers/happy-path-script.js";
import {
  experimentCleanCase,
  experimentMainCase,
  experimentPlan,
  judgeAdjudication,
  scriptedLlmClient,
} from "./helpers.js";

/**
 * 实验报告装配（Ticket 12 / issue #13 验收）：
 * 分层指标（rep1 冷单列 / rep2+ 热主口径）+ S/A/B 判定（锚 C）+ 阴性对照 +
 * Verifier 消融（token 计入 CARC）+ Ledger 去重 + judge 判定链（断点续跑）+
 * 10% 人工抽检（种子确定性）+ 报告落盘 + --report-only 重建。
 * 零网络：FakeLlmClient / FakeJudgeClient。
 */

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "review-agent-report-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const REPORT_PLAN = experimentPlan({
  experimentId: "report-integration",
  configs: ["A", "C"],
  reps: 3,
  verifier: "on",
  judge: true,
});

/** 集成夹具：1 主集 case + 1 clean MR × {A, C} × 3 rep（verifier on） */
async function runIntegrationFixture(): Promise<{
  readonly report: ExperimentReport;
  readonly experimentRoot: string;
}> {
  const cases = [experimentMainCase("rep-main-1"), experimentCleanCase("rep-clean-1")];
  const experimentRoot = path.join(workDir, "integration");
  const outcome = await runExperiment(REPORT_PLAN, cases, {
    llmClient: scriptedLlmClient(12, "on"),
  }, { experimentRoot });
  expect(outcome.failures).toEqual([]);
  const judgeClient = FakeJudgeClient.fromAdjudications(
    Array.from({ length: 6 }, () => judgeAdjudication()),
  );
  const report = await buildExperimentReport(outcome, { judgeClient }, { experimentRoot });
  return { report, experimentRoot };
}

describe("buildExperimentReport（集成：指标 / 判定 / 阴性对照 / 消融）", () => {
  let report: ExperimentReport;
  let judgeCallCount: number;

  beforeAll(async () => {
    const cases = [experimentMainCase("rep-main-1"), experimentCleanCase("rep-clean-1")];
    const experimentRoot = path.join(workDir, "integration");
    const outcome = await runExperiment(REPORT_PLAN, cases, {
      llmClient: scriptedLlmClient(12, "on"),
    }, { experimentRoot });
    expect(outcome.failures).toEqual([]);
    judgeClientRef = FakeJudgeClient.fromAdjudications(
      Array.from({ length: 6 }, () => judgeAdjudication()),
    );
    report = await buildExperimentReport(outcome, { judgeClient: judgeClientRef }, { experimentRoot });
    judgeCallCount = judgeClientRef.callCount;
  });

  it("主集/clean 分箱与基础计数", () => {
    expect(report.caseCount).toBe(1); // 主集
    expect(report.negativeControlCaseCount).toBe(1); // clean MR
    expect(report.executed).toBe(12);
    expect(report.failed).toBe(0);
  });

  it("分层指标：rep1 冷单列、rep2+ 热主口径（config A 与 C 都有）", () => {
    expect(report.metrics).not.toBeNull();
    const perConfig = report.metrics?.perConfig ?? {};
    for (const configId of ["A", "C"] as const) {
      const summary = perConfig[configId];
      expect(summary, `config ${configId} summary`).toBeDefined();
      expect(summary?.caseCount).toBeGreaterThan(0);
      expect(summary?.cold).not.toBeNull(); // rep1 单列
      expect(summary?.hot).not.toBeNull(); // rep2+（case 级聚合：1 个 case 的热均值 = 1 个样本）
      expect(summary?.hot?.sampleCount).toBe(1);
      // 快乐路径 Finding 命中唯一真值位置 → recall = 1（热口径均值）
      const hotRecall = summary?.hot?.values.lineRecall ?? null;
      expect(hotRecall?.mean).toBe(1);
      expect(hotRecall?.std).toBe(0);
    }
  });

  it("S/A/B 判定：锚 = config C（热口径）；判据明细齐全", () => {
    expect(report.verdicts).not.toBeNull();
    expect(report.verdicts?.anchorConfigId).toBe("C");
    expect(report.verdicts?.anchorAvailable).toBe(true);
    const verdicts = report.verdicts?.verdicts ?? [];
    expect(verdicts.map((verdict) => verdict.configId)).toEqual(["A", "C"]);
    for (const verdict of verdicts) {
      expect(verdict.criteria).toHaveLength(9); // 3 档 × 3 判据
      expect(verdict.anchor.configId).toBe("C");
    }
    // 脚本化 usage：A 与 C 的 token 相同 → Token ≤ C×30% 不可能通过 → BELOW_B（可复现的算术）
    expect(verdicts[0]?.outcome).toBe("BELOW_B");
  });

  it("阴性对照：clean MR 每 Finding 计 1 FP（不进主指标）", () => {
    expect(report.negativeControl).not.toBeNull();
    expect(report.negativeControl?.caseCount).toBe(1);
    for (const entry of report.negativeControl?.perConfig ?? []) {
      expect(["A", "C"]).toContain(entry.configId);
      expect(entry.caseCount).toBe(1);
      expect(entry.totalFalsePositives).toBe(3); // 3 rep × 1 finding
      const stat = entry.falsePositivesPerCase.values.lineFp;
      expect(stat?.mean).toBe(1);
      expect(stat?.std).toBe(0);
    }
    expect(report.negativeControl?.perConfig).toHaveLength(2);
  });

  it("Verifier 消融：off 档 = 基线（单遍自证）、on 档 = 复核后 + 合并 usage（token 计入 CARC）", () => {
    const ablation = report.verifierAblation;
    expect(ablation).not.toBeNull();
    for (const entry of ablation?.perConfig ?? []) {
      expect(["A", "C"]).toContain(entry.configId);
      // verifier 每单元 +50 输入 / +5 输出；config A/C 各 6 单元（主集 3 rep + clean MR 3 rep）
      expect(entry.verifierTokens).toEqual({ input: 300, output: 30 });
      expect(entry.removedFindings).toBe(0); // 复核全部 pass
      const offTokens = entry.off?.totalTokens ?? null;
      const onTokens = entry.on?.totalTokens ?? null;
      expect(offTokens).toBe(HAPPY_PATH_TOTAL_USAGE.inputTokens + (HAPPY_PATH_TOTAL_USAGE.cacheReadTokens ?? 0) + (HAPPY_PATH_TOTAL_USAGE.cacheWriteTokens ?? 0) + HAPPY_PATH_TOTAL_USAGE.outputTokens);
      expect(onTokens).toBe((offTokens ?? 0) + 50 + 5);
    }
    expect(ablation?.perConfig).toHaveLength(2);
  });

  it("judge 判定链：主集 judged、clean MR skipped-clean-mr、repIndex 回填", () => {
    const judge = report.judge;
    expect(judge).not.toBeNull();
    expect(judge?.runCount).toBe(12);
    expect(judge?.judgedCount).toBe(6); // 主集 A×3 + C×3
    expect(judge?.skippedCleanMrCount).toBe(6); // clean MR 不经 judge
    expect(judge?.skippedNoFindingsCount).toBe(0);
    expect(judge?.errorCount).toBe(0);
    expect(judgeCallCount).toBe(6); // fake judge 恰好 6 次调用
    const mainResults = (judge?.results ?? []).filter(
      (result) => result.caseId === "rep-main-1",
    );
    expect(mainResults.map((result) => result.repIndex).sort()).toEqual([0, 0, 1, 1, 2, 2]);
    for (const configId of ["A", "C"] as const) {
      const entry = judge?.perConfig.find((candidate) => candidate.configId === configId);
      expect(entry?.runCount).toBe(6); // 主集 3 + clean 3
      expect(entry?.rule.values.lineRecall?.mean).toBe(1);
      expect(entry?.judge.values.lineRecall?.mean).toBe(1); // judge 裁定命中
    }
  });

  it("人工抽检：种子确定性 + 比例覆盖", () => {
    const humanReview = report.humanReview;
    expect(humanReview).not.toBeNull();
    expect(humanReview?.seed).toBe(REPORT_PLAN.humanReviewSeed);
    expect(humanReview?.rate).toBe(0.1);
    expect(humanReview?.totalUnits).toBe(12); // 主集 6 + clean 6
    expect(humanReview?.selectedUnits.length).toBeGreaterThanOrEqual(1);
    expect(humanReview?.forms).toHaveLength(humanReview?.selectedUnits.length ?? 0);
    for (const form of humanReview?.forms ?? []) {
      expect(form.protocolVersion).toBe("1");
      expect(humanReview?.selectedUnits).toContain(form.unitKey);
      expect(form.items.length).toBeGreaterThan(0);
    }
  });
});

let judgeClientRef: FakeJudgeClient;

describe("judge 判定链断点续跑（JudgeStore 落盘）", () => {
  it("同实验重建报告：judge 结果全部命中缓存（零 judge 调用）", async () => {
    const cases = [experimentMainCase("rep-main-1"), experimentCleanCase("rep-clean-1")];
    const experimentRoot = path.join(workDir, "integration");
    const outcome = await runExperiment(REPORT_PLAN, cases, {
      llmClient: new FakeJudgeClient([]) as never, // 不会被调用：检视记录全部续跑
    }, { experimentRoot });
    expect(outcome.resumed).toBe(12);
    expect(outcome.executed).toBe(0);
    // 空 steps 的 fake judge：任何真实调用都会抛 JudgeScriptExhaustedError → error 口径；
    // 缓存命中则零调用
    const emptyJudge = FakeJudgeClient.fromAdjudications([]);
    const rebuilt = await buildExperimentReport(
      outcome,
      { judgeClient: emptyJudge },
      { experimentRoot },
    );
    expect(emptyJudge.callCount).toBe(0);
    expect(rebuilt.judge?.judgedCount).toBe(6);
    expect(rebuilt.judge?.runCount).toBe(12);
    expect(rebuilt.judge?.errorCount).toBe(0);
  });

  it("JudgeStore 落盘路径与形状（judge/<source>/<caseId>/<configId>/rep-<rep>.json）", async () => {
    const store = new JudgeStore(path.join(workDir, "integration", "judge"));
    const filePath = store.pathOf({
      source: "defects4j",
      caseId: "rep-main-1",
      configId: "A",
      rep: 1,
    });
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as {
      readonly status: string;
      readonly repIndex: number;
    };
    expect(parsed.status).toBe("judged");
    expect(parsed.repIndex).toBe(0);
  });
});

describe("报告落盘与重建", () => {
  it("persistExperimentReport：report.json + human-review/forms.json", async () => {
    const { report, experimentRoot } = await runIntegrationFixture();
    await persistExperimentReport(experimentRoot, report);
    const persisted = JSON.parse(
      await readFile(path.join(experimentRoot, "report.json"), "utf8"),
    ) as { readonly experimentId: string; readonly metrics: unknown };
    expect(persisted.experimentId).toBe("report-integration");
    expect(persisted.metrics).toBeDefined();
    const forms = JSON.parse(
      await readFile(path.join(experimentRoot, "human-review", "forms.json"), "utf8"),
    ) as { readonly seed: string; readonly forms: readonly unknown[] };
    expect(forms.seed).toBe(REPORT_PLAN.humanReviewSeed);
    expect(forms.forms).toHaveLength(report.humanReview?.forms.length ?? 0);
  });

  it("rebuildExperimentOutcome：从落盘产物重建（--report-only 数据面）", async () => {
    const { report, experimentRoot } = await runIntegrationFixture();
    await persistExperimentReport(experimentRoot, report);
    const outcome = await rebuildExperimentOutcome(
      experimentRoot,
      () => loadPersistedPlan(experimentRoot),
      () => loadPersistedCases(experimentRoot),
    );
    expect(outcome.plan.experimentId).toBe("report-integration");
    expect(outcome.cases.map((mrCase) => mrCase.caseId)).toEqual(["rep-main-1", "rep-clean-1"]);
    expect(outcome.records).toHaveLength(12);
    expect(outcome.resumed).toBe(12);
    expect(outcome.executed).toBe(0);
    expect(outcome.failures).toEqual([]);
    // 重建 outcome 可再次装配出等价的报告
    const rebuilt = await buildExperimentReport(outcome, {}, { experimentRoot });
    expect(rebuilt.caseCount).toBe(report.caseCount);
    expect(rebuilt.judge).toBeNull(); // 未提供 judgeClient
    expect(rebuilt.humanReview).not.toBeNull(); // 抽检仍可基于规则口径构建
  });

  it("重建读取 failures.json 留痕", async () => {
    const experimentRoot = path.join(workDir, "with-failures");
    const cases = [experimentMainCase("fail-main-1"), experimentMainCase("fail-main-2")];
    const client = new FakeLlmClient([
      ...HAPPY_PATH_RESPONSES.map((response) => ({ kind: "reply" as const, response })),
      { kind: "fail" as const, error: new Error("boom") },
    ]);
    const outcome = await runExperiment(
      experimentPlan({ experimentId: "with-failures" }),
      cases,
      { llmClient: client },
      { experimentRoot },
    );
    expect(outcome.failures).toHaveLength(1);
    const failures = JSON.parse(
      await readFile(path.join(experimentRoot, FAILURES_FILE), "utf8"),
    ) as readonly { readonly caseId: string }[];
    expect(failures).toHaveLength(1);
    const rebuilt = await rebuildExperimentOutcome(
      experimentRoot,
      () => loadPersistedPlan(experimentRoot),
      () => loadPersistedCases(experimentRoot),
    );
    expect(rebuilt.failures.map((failure) => failure.caseId)).toEqual(["fail-main-2"]);
  });
});

// ===== 手工记录（无需 LLM 的定向断言：Ledger 去重 / verifier off / 边界） =====

function craftRecord(
  unit: { readonly source: ExperimentSource; readonly caseId: string; readonly configId: "A" | "B" | "C" | "D" | "E"; readonly rep: number },
  findings: readonly Finding[],
  toolCallLog: readonly ToolCallRecord[],
): RunRecord {
  const result: RunResult = {
    caseId: unit.caseId,
    configId: unit.configId,
    findings,
    usage: { inputTokens: 100, outputTokens: 10 },
    rounds: 1,
    toolCalls: toolCallLog.length,
    audit: {
      requests: [],
      toolCallLog,
      phaseLog: [],
      rejections: [],
      cacheBreaks: [],
      truncated: false,
      truncationReasons: [],
    },
    auditPath: "unused.json",
  };
  return {
    source: unit.source,
    caseId: unit.caseId,
    configId: unit.configId,
    rep: unit.rep,
    model: "deepseek-v4-flash",
    verifier: "off",
    completedAt: "2026-09-04T00:00:00.000Z",
    baseline: toRunSnapshot(result),
    effective: null,
    verifierPass: null,
  };
}

describe("Ledger 去重统计（toolCallLog 前缀口径）", () => {
  it("dedupCalls 计 \"Already loaded: ctx#\" 前缀调用，ratio = dedup/toolCalls", async () => {
    const case_ = experimentMainCase("dedup-main-1");
    const records = [
      craftRecord(
        { source: "defects4j", caseId: "dedup-main-1", configId: "E", rep: 1 },
        [HAPPY_PATH_FINDING],
        [
          { name: "review.get_file", argumentsJson: "{}", resultSummary: "Loaded src/Foo.java (30 lines)." },
          { name: "review.get_file", argumentsJson: "{}", resultSummary: "Already loaded: ctx#001" },
          { name: "review.get_symbol", argumentsJson: "{}", resultSummary: "Already loaded: ctx#002" },
        ],
      ),
      craftRecord(
        { source: "defects4j", caseId: "dedup-main-1", configId: "E", rep: 2 },
        [HAPPY_PATH_FINDING],
        [{ name: "review.get_file", argumentsJson: "{}", resultSummary: "Loaded src/Bar.java (10 lines)." }],
      ),
    ];
    const report = await buildExperimentReport(
      {
        plan: experimentPlan({ experimentId: "dedup-craft", configs: ["E"] }),
        records,
        cases: [case_],
        executed: records.length,
        resumed: 0,
        failures: [],
      },
      {},
      { experimentRoot: path.join(workDir, "dedup-craft") },
    );
    expect(report.dedup).toHaveLength(1);
    expect(report.dedup[0]).toMatchObject({ configId: "E", toolCalls: 4, dedupCalls: 2 });
    expect(report.dedup[0]?.dedupRatio).toBe(0.5);
    expect(report.verifierAblation).toBeNull(); // verifier off → 无消融对照
    expect(report.negativeControl).toBeNull(); // 无 clean case
  });

  it("clean MR 零 Finding：FP=0 计入阴性对照（零 finding ≠ 无记录）", async () => {
    const clean = experimentCleanCase("dedup-clean-1");
    const records = [
      craftRecord({ source: "clean-mr", caseId: "dedup-clean-1", configId: "A", rep: 1 }, [], []),
      craftRecord({ source: "clean-mr", caseId: "dedup-clean-1", configId: "A", rep: 2 }, [], []),
    ];
    const report = await buildExperimentReport(
      {
        plan: experimentPlan({ experimentId: "clean-zero", configs: ["A"] }),
        records,
        cases: [clean],
        executed: records.length,
        resumed: 0,
        failures: [],
      },
      {},
      { experimentRoot: path.join(workDir, "clean-zero") },
    );
    expect(report.metrics).toBeNull(); // 无主集 case
    expect(report.verdicts).toBeNull();
    expect(report.negativeControl?.perConfig[0]).toMatchObject({
      configId: "A",
      caseCount: 1,
      totalFalsePositives: 0,
    });
    // 零 finding 的主集判定链场景由 judge 阶段覆盖（skipped-no-findings）
  });
});
