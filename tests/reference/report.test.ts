import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Finding } from "../../src/contracts/finding.js";
import type { MRCase } from "../../src/contracts/mr-case.js";
import {
  buildClaudeCodeReferenceReport,
  persistReferenceReport,
  rebuildReferenceOutcome,
  renderReferenceDashboardMarkdown,
} from "../../src/reference/report.js";
import type { ReferenceOutcome } from "../../src/reference/runner.js";
import type { ReferenceRunRecord } from "../../src/reference/run-store.js";
import { CLAUDE_CODE_PROMPT_TEMPLATE_VERSION } from "../../src/reference/prompt.js";
import {
  claudeStdout,
  FakeClaudeCodeClient,
  findingJson,
  okRunOutput,
  referenceCleanCase,
  referenceMainCase,
  referencePlan,
} from "./helpers.js";
import { runClaudeCodeReference } from "../../src/reference/runner.js";

/**
 * 外部参照报告装配（Ticket 13 验收）：
 * - 「进同一 Metrics 管线」：fake 输出 → Finding[] → evaluateRun/buildMetricsReport
 *   （config 键 = "claude-code" 单列），指标与主实验同口径；
 * - 「不进 S/A/B」：verdicts 恒 null、excludedFromMainVerdict 恒 true，报告与
 *   Dashboard 双处显式标注，A–E 列恒缺省；
 * - 阴性对照（clean MR）每条 Finding 计 1 FP，单列汇总；
 * - 归一化留痕 / 运行环境留档汇总；--report-only 落盘重建。
 */

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "review-agent-ref-report-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const MAIN_FINDING: Finding = {
  id: "F001",
  severity: "P1",
  category: "CORRECTNESS",
  file: "src/main/java/com/example/math/MathUtils.java",
  line: 20,
  title: "Off-by-one loop bound reads values[count]",
  description: "Reads values[count], out of bounds when count equals values.length.",
  evidence: ["i <= count"],
  rule: "CORRECTNESS-001",
  confidence: 0.9,
};

function mainFinding(id: string, line = 20): Finding {
  return { ...MAIN_FINDING, id, line };
}

function makeRecord(overrides: Partial<ReferenceRunRecord> = {}): ReferenceRunRecord {
  return {
    source: "defects4j",
    caseId: "report-main-001",
    rep: 1,
    completedAt: "2026-09-01T00:00:00.000Z",
    requestedModel: "sonnet",
    actualModels: ["claude-sonnet-4-5"],
    claudeVersion: "2.1.241 (fake)",
    maxTurns: 5,
    promptTemplateVersion: CLAUDE_CODE_PROMPT_TEMPLATE_VERSION,
    status: "ok",
    findings: [MAIN_FINDING],
    rejections: [],
    usage: { inputTokens: 1000, outputTokens: 200 },
    numTurns: 3,
    totalCostUsd: 0.25,
    permissionDenials: 0,
    parseNotes: [],
    rawPath: "raw/defects4j/report-main-001/rep-1.json",
    ...overrides,
  };
}

function makeOutcome(overrides: Partial<ReferenceOutcome> = {}): ReferenceOutcome {
  const plan = referencePlan({ referenceId: "ref-report" });
  const cases: readonly MRCase[] = [
    referenceMainCase("report-main-001"),
    referenceCleanCase("report-clean-001"),
  ];
  return {
    referenceId: plan.referenceId,
    plan,
    expanded: { units: [], cases, skipped: [] },
    executed: 2,
    resumed: 0,
    failures: [],
    records: [
      makeRecord(),
      makeRecord({
        source: "clean-mr",
        caseId: "report-clean-001",
        status: "degraded",
        // 归一化后仅保留合法条目：1 条原生 + 1 条合法新检出处（第 3 条重复 id 已拦截）
        findings: [mainFinding("F001"), mainFinding("F002", 25)],
        rejections: [
          { candidateIndex: 2, stage: "DUPLICATE_ID" as const, reason: "duplicate finding id \"F002\"" },
        ],
        usage: { inputTokens: 800, outputTokens: 150, cacheReadTokens: 200 },
        totalCostUsd: 0.5,
        permissionDenials: 1,
        rawPath: "raw/clean-mr/report-clean-001/rep-1.json",
      }),
    ],
    cases,
    ...overrides,
  };
}

describe("buildClaudeCodeReferenceReport（单列纪律）", () => {
  it("不进 S/A/B：verdicts 恒 null、excludedFromMainVerdict 恒 true、双处标注", () => {
    const report = buildClaudeCodeReferenceReport(makeOutcome());
    expect(report.verdicts).toBeNull();
    expect(report.excludedFromMainVerdict).toBe(true);
    expect(report.kind).toBe("claude-code-external-reference");
    expect(report.mainVerdictNote).toContain("excluded from the S/A/B main verdict");
  });

  it("进同一 Metrics 管线：单列 claude-code，A–E 恒缺省；指标与 evaluateRun 同口径", () => {
    const report = buildClaudeCodeReferenceReport(makeOutcome());
    expect(report.metrics).not.toBeNull();
    const summary = report.metrics?.perConfig["claude-code"];
    expect(summary).toBeDefined();
    // 主集 1 case × 1 rep：rep1 冷口径单列（reps=1 → hot 为 null）
    expect(summary?.cold?.values.lineTp?.mean).toBe(1);
    expect(summary?.cold?.values.lineFn?.mean).toBe(0);
    expect(summary?.cold?.values.totalTokens?.mean).toBe(1200);
    expect(summary?.cold?.values.rounds?.mean).toBe(3);
    expect(summary?.cold?.values.toolCalls?.mean).toBe(0);
    // A–E 主矩阵列恒缺省（外部参照永不混入）
    for (const configId of ["A", "B", "C", "D", "E"] as const) {
      expect(report.metrics?.perConfig[configId]).toBeUndefined();
    }
  });

  it("阴性对照：clean MR 每条 Finding 计 1 FP（degraded 保留 2 条合法 + 1 条重复拦截）", () => {
    const report = buildClaudeCodeReferenceReport(makeOutcome());
    expect(report.negativeControl).not.toBeNull();
    expect(report.negativeControl?.caseCount).toBe(1);
    expect(report.negativeControl?.totalFalsePositives).toBe(2);
    expect(report.negativeControl?.falsePositivesPerCase.values.lineFp?.mean).toBe(2);
  });

  it("case 计数：主集与 clean MR 分列", () => {
    const report = buildClaudeCodeReferenceReport(makeOutcome());
    expect(report.caseCount).toBe(1);
    expect(report.negativeControlCaseCount).toBe(1);
    expect(report.executed).toBe(2);
    expect(report.failed).toBe(0);
  });

  it("归一化留痕汇总：ok/degraded 计数、条目与拦截数、按阶段分布", () => {
    const report = buildClaudeCodeReferenceReport(makeOutcome());
    expect(report.normalization).toEqual({
      runCount: 2,
      okRuns: 1,
      degradedRuns: 1,
      totalFindings: 3,
      rejectedFindings: 1,
      rejectionsByStage: {
        CLI_OUTPUT_UNPARSABLE: 0,
        FINDINGS_FIELD_INVALID: 0,
        ENTRY_SCHEMA_INVALID: 0,
        DUPLICATE_ID: 1,
      },
    });
  });

  it("运行环境留档汇总：请求/实际模型、CLI 版本、成本合计、权限拒绝运行数", () => {
    const report = buildClaudeCodeReferenceReport(makeOutcome());
    expect(report.runtime).toEqual({
      requestedModel: "sonnet",
      actualModels: ["claude-sonnet-4-5"],
      claudeVersions: ["2.1.241 (fake)"],
      totalCostUsd: 0.75,
      permissionDeniedRuns: 1,
    });
  });

  it("任一运行成本缺失：totalCostUsd 记 null（不谎报合计）", () => {
    const report = buildClaudeCodeReferenceReport(
      makeOutcome({
        records: [makeRecord({ totalCostUsd: null })],
      }),
    );
    expect(report.runtime.totalCostUsd).toBeNull();
  });

  it("空 outcome（零记录）：metrics 与阴性对照为 null，报告仍可产出", () => {
    const report = buildClaudeCodeReferenceReport(
      makeOutcome({ executed: 0, records: [] }),
    );
    expect(report.metrics).toBeNull();
    expect(report.negativeControl).toBeNull();
    expect(report.normalization.runCount).toBe(0);
    expect(report.runtime.totalCostUsd).toBe(0);
  });
});

describe("renderReferenceDashboardMarkdown", () => {
  it("显式标注外部参照不进主判定；单列 claude-code 表头；A–E 不出现为列", () => {
    const markdown = renderReferenceDashboardMarkdown(buildClaudeCodeReferenceReport(makeOutcome()));
    expect(markdown).toContain("EXTERNAL REFERENCE — NOT part of the S/A/B main verdict");
    expect(markdown).toContain("# Claude Code External Reference: ref-report");
    expect(markdown).toContain("| Metric | claude-code |");
    // 分组与核心指标行（与主 Dashboard 同风格）
    expect(markdown).toContain("**Review Quality**");
    expect(markdown).toContain("lineRecall");
    expect(markdown).toContain("**Cache Efficiency**");
    // 阴性对照 / 归一化 / 运行留档段
    expect(markdown).toContain("## Negative control");
    expect(markdown).toContain("## Normalization audit");
    expect(markdown).toContain("## Runtime provenance");
    expect(markdown).toContain("claude CLI version(s)");
    // 计划与单元概览行
    expect(markdown).toContain("model: `sonnet`");
    expect(markdown).toContain("maxTurns: 5");
  });

  it("空 outcome：指标段省略，标注仍在", () => {
    const markdown = renderReferenceDashboardMarkdown(
      buildClaudeCodeReferenceReport(makeOutcome({ executed: 0, records: [] })),
    );
    expect(markdown).toContain("NOT part of the S/A/B main verdict");
    expect(markdown).not.toContain("| Metric | claude-code |");
  });

  it("失败留痕段：单元失败列示", () => {
    const markdown = renderReferenceDashboardMarkdown(
      buildClaudeCodeReferenceReport(
        makeOutcome({
          failures: [{ source: "defects4j", caseId: "x", rep: 1, message: "boom" }],
        }),
      ),
    );
    expect(markdown).toContain("## Failures (1; isolated, run continued)");
    expect(markdown).toContain("`defects4j/x/rep-1`: boom");
  });
});

describe("端到端：runner → report → 落盘 → --report-only 重建", () => {
  it("fake 输出 → Finding[] → evaluateRun → 单列报告落盘 → 重建一致", async () => {
    const referenceRoot = path.join(workDir, "ref-e2e");
    const client = FakeClaudeCodeClient.fromOutputs([
      okRunOutput(claudeStdout({ findings: [findingJson("F001")] })),
      okRunOutput(
        claudeStdout({
          findings: [findingJson("F002", { line: 25 }), findingJson("F003", { line: 30 }), findingJson("F003", { line: 35 })],
        }),
      ),
    ]);
    const outcome = await runClaudeCodeReference(
      referencePlan({ referenceId: "ref-e2e" }),
      [referenceMainCase("e2e-main-001"), referenceCleanCase("e2e-clean-001")],
      { client },
      { referenceRoot },
    );
    const report = buildClaudeCodeReferenceReport(outcome);
    expect(report.caseCount).toBe(1);
    expect(report.negativeControlCaseCount).toBe(1);
    // 主集命中真值（findingJson 的 line 20 = 真值位置）
    expect(report.metrics?.perConfig["claude-code"]?.cold?.values.lineTp?.mean).toBe(1);
    // clean MR：3 条候选中 1 条重复（F003）被拦截，2 条合法全计 FP
    expect(report.negativeControl?.totalFalsePositives).toBe(2);
    // 阴性对照里的重复 id 被拦截 → degraded
    expect(report.normalization.degradedRuns).toBe(1);

    await persistReferenceReport(referenceRoot, report);
    const persistedReport = JSON.parse(
      await readFile(path.join(referenceRoot, "reference-report.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(persistedReport.kind).toBe("claude-code-external-reference");
    expect(persistedReport.verdicts).toBeNull();
    const dashboard = await readFile(path.join(referenceRoot, "reference-dashboard.md"), "utf8");
    expect(dashboard).toContain("NOT part of the S/A/B main verdict");

    // --report-only 重建：不再调用 claude（零脚本 fake），报告一致
    const rebuilt = await rebuildReferenceOutcome(
      referenceRoot,
      async () => {
        const { loadPersistedReferencePlan } = await import("../../src/reference/runner.js");
        return loadPersistedReferencePlan(referenceRoot);
      },
      async () => {
        const { loadPersistedReferenceCases } = await import("../../src/reference/runner.js");
        return loadPersistedReferenceCases(referenceRoot);
      },
    );
    const rebuiltReport = buildClaudeCodeReferenceReport(rebuilt);
    expect(rebuiltReport.caseCount).toBe(1);
    expect(rebuiltReport.negativeControlCaseCount).toBe(1);
    expect(rebuiltReport.normalization).toEqual(report.normalization);
    expect(rebuiltReport.metrics?.perConfig["claude-code"]?.cold?.values.lineTp?.mean).toBe(1);
    expect(rebuiltReport.negativeControl?.totalFalsePositives).toBe(2);
  });
});
