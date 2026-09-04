import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeCliClient } from "../../src/reference/client.js";
import { buildClaudeCodePrompt } from "../../src/reference/prompt.js";
import { buildClaudeCodeReferenceReport, persistReferenceReport } from "../../src/reference/report.js";
import { runClaudeCodeReference } from "../../src/reference/runner.js";
import { referencePlan } from "../reference/helpers.js";
import { SAMPLE_MR_CASE } from "../fixtures/sample-mr-case.js";

/**
 * 冒烟 e2e（Ticket 13）：Claude Code 真实 CLI × 样例 MR × 单列外部参照管线。
 *
 * 运行条件（全部满足才执行，否则显式 SKIP 并打印原因）：
 * 1. 环境变量 CLAUDE_CODE_E2E=1（显式 opt-in：真实调用产生 API 成本）；
 * 2. 本机 PATH 可执行 claude CLI（认证沿用 CLI 自身配置）。
 * `pnpm test` 零网络零真实 claude 调用；本文件仅在 `pnpm test:e2e` 中运行。
 *
 * 模型选择：缺省 Claude 系别名 sonnet；非标准后端（本机代理把别名路由到
 * 自有模型，如 haiku → MiniMax-M3，且 sonnet 的映射不受支持）可用
 * CLAUDE_CODE_MODEL 覆盖。实际模型以 CLI 回报（modelUsage 键）留档对照。
 */

const OPT_IN_ENV_VAR = "CLAUDE_CODE_E2E";
const MODEL_ENV_VAR = "CLAUDE_CODE_MODEL";
const optIn = process.env[OPT_IN_ENV_VAR] === "1";
const smokeModel = process.env[MODEL_ENV_VAR]?.trim() || "sonnet";

if (!optIn) {
  console.info(
    `[claude-code-ref-smoke-e2e] ${OPT_IN_ENV_VAR}=1 is not set: the real-CLI reference ` +
      "smoke e2e is SKIPPED. Export CLAUDE_CODE_E2E=1 (real calls cost money) and run " +
      "`pnpm test:e2e` to execute it.",
  );
} else if (smokeModel !== "sonnet") {
  console.info(
    `[claude-code-ref-smoke-e2e] using ${MODEL_ENV_VAR}=${smokeModel} (non-default model alias)`,
  );
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!optIn)("smoke e2e: Claude Code reference × sample MR × 单列管线", () => {
  it(
    "runs one real claude CLI review, normalizes findings, and reports a single excluded column",
    async () => {
      // 前置：claude CLI 可执行（不可用 → 显式 SKIP 打印原因，不作失败）
      const client = new ClaudeCodeCliClient({ timeoutMs: 600_000 });
      let claudeVersion: string;
      try {
        claudeVersion = await client.version();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.info(
          `[claude-code-ref-smoke-e2e] claude CLI unavailable (${message}): SKIPPED. ` +
            "Install/authenticate the claude CLI and re-run.",
        );
        return;
      }
      console.info(`[claude-code-ref-smoke-e2e] claude CLI: ${claudeVersion}`);

      // 同仓同 diff 同目标：样例 MR（源标签改挂 defects4j 以入参照词表）
      const case_ = {
        ...SAMPLE_MR_CASE,
        labels: { ...SAMPLE_MR_CASE.labels, source: "defects4j" as const },
      };
      // 提示词与模板版本先行留档（复现材料）
      const promptPreview = buildClaudeCodePrompt(case_);
      expect(promptPreview).toContain(`Case ID: ${case_.caseId}`);

      const workDir = await mkdtemp(path.join(tmpdir(), "review-agent-ref-e2e-"));
      try {
        const plan = referencePlan({
          referenceId: "smoke-claude-code-e2e",
          sources: ["defects4j"],
          // 成本有界：单 case × 1 rep × 3 轮上界；模型可经 CLAUDE_CODE_MODEL 覆盖
          reps: 1,
          maxTurns: 3,
          model: smokeModel,
        });
        const outcome = await runClaudeCodeReference(
          plan,
          [case_],
          { client },
          { referenceRoot: workDir },
        );
        // 真实调用必须产出记录（失败则留痕完整打印供归因）
        expect(outcome.failures).toEqual([]);
        expect(outcome.records).toHaveLength(1);
        const record = outcome.records[0];
        expect(record).toBeDefined();
        if (record === undefined) {
          return;
        }
        // 归一化与记账：合法输出（ok）或部分非法（degraded）都可接受——
        // 有界失败设计；usage/版本/模型必须留档
        expect(record.status === "ok" || record.status === "degraded").toBe(true);
        expect(record.usage.inputTokens).toBeGreaterThanOrEqual(0);
        expect(record.usage.outputTokens).toBeGreaterThan(0);
        expect(record.claudeVersion).toBe(claudeVersion);
        expect(record.actualModels.length).toBeGreaterThan(0);
        expect(record.findings.every((f) => f.id.length > 0 && f.line >= 1)).toBe(true);
        // raw 档案落盘（提示词原文 = 完整复现材料）
        expect(await exists(path.join(workDir, record.rawPath))).toBe(true);

        // 单列报告：进同一 metrics 管线、不进 S/A/B
        const report = buildClaudeCodeReferenceReport(outcome);
        expect(report.verdicts).toBeNull();
        expect(report.excludedFromMainVerdict).toBe(true);
        expect(report.caseCount).toBe(1);
        const summary = report.metrics?.perConfig["claude-code"];
        expect(summary).toBeDefined();
        for (const configId of ["A", "B", "C", "D", "E"] as const) {
          expect(report.metrics?.perConfig[configId]).toBeUndefined();
        }
        await persistReferenceReport(workDir, report);
        const dashboard = await readFile(path.join(workDir, "reference-dashboard.md"), "utf8");
        expect(dashboard).toContain("NOT part of the S/A/B main verdict");

        console.info(
          `[claude-code-ref-smoke-e2e] status=${record.status} ` +
            `findings=${record.findings.length} rejections=${record.rejections.length} ` +
            `actualModels=${record.actualModels.join(",")} cost=$${record.totalCostUsd ?? "?"} ` +
            `turns=${record.numTurns ?? "?"} lineTp=${summary?.cold?.values.lineTp?.mean ?? "—"} ` +
            `lineRecall=${summary?.cold?.values.lineRecall?.mean ?? "—"}`,
        );
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    600_000,
  );
});
