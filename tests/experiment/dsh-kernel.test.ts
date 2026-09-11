/**
 * #27 验收（实验面 e2e）：experiment runner 接 DSH 内核。
 *
 * 小批冒烟（票面：≥3 单元 × ≥1 配置）：3 case × configs A,B × rep1 = 6 单元，
 * 全部经**单一长驻 host 进程**（agent-per-unit）执行——llmClient 注入空脚本
 * FakeLlmClient（任何调用即抛），证明 DSH 分支不触碰 POC1 进程内客户端
 * （隐式变异护栏：分支翻回 runReview 会立刻烧穿脚本）。产物断言走全链路：
 * RunRecord 落盘（断点续跑面）→ 报告 / dashboard 直接消费（零改动管线）。
 *
 * 另：模型门——内核路由锁死 deepseek-v4-flash，plan.model 不符启动即报错
 * （防「计划以为跑 pro、内核实际跑 flash」的口径漂移）。
 *
 * LLM 端点 = 本地 stub（127.0.0.1，零外网）；凭据经环境变量注入，哨兵 key
 * 不出现在任何断言输出里。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { renderDashboardMarkdown } from "../../src/experiment/dashboard.js";
import { createDshKernelDriver, type DshKernelDriver } from "../../src/experiment/dsh-kernel.js";
import { buildExperimentReport } from "../../src/experiment/report.js";
import { runExperiment } from "../../src/experiment/runner.js";
import { FakeLlmClient } from "../../src/fake/fake-llm-client.js";
import { configAResponses } from "../helpers/dsh-replies.js";
import { startStubLlmServer } from "../helpers/stub-llm-server.js";
import { experimentMainCase, experimentPlan } from "./helpers.js";

const E2E_TIMEOUT_MS = 300_000;

const workDirs: string[] = [];

afterAll(async () => {
  await Promise.all(workDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeExperimentRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  workDirs.push(dir);
  return dir;
}

describe("实验 runner 接 DSH 内核（#27）", () => {
  it(
    "e2e 小批冒烟：3 case × A,B × rep1 = 6 单元经单一 host 进程；报告 / dashboard 直接消费",
    async () => {
      // 6 单元 × 6 阶段 = 36 条脚本回复（无 fallback：多发的请求 500 → 单元失败可察）
      const stub = await startStubLlmServer(
        Array.from({ length: 6 }, () => configAResponses()).flat(),
      );
      const experimentRoot = await makeExperimentRoot("dsh-kernel-e2e-");
      const driver = createDshKernelDriver({
        env: { ...process.env, DEEPSEEK_URL: stub.url, DEEPSEEK_API_KEY: "sk-e2e-sentinel" },
      });
      try {
        const outcome = await runExperiment(
          experimentPlan({ experimentId: "dsh-e2e", configs: ["A", "B"], reps: 1 }),
          [
            experimentMainCase("dsh-e2e-001"),
            experimentMainCase("dsh-e2e-002"),
            experimentMainCase("dsh-e2e-003"),
          ],
          {
            // 空脚本 = 任何进程内 LLM 调用即抛（verifier off 时 DSH 路径零调用）
            llmClient: FakeLlmClient.fromResponses([]),
            dshKernel: driver,
          },
          { experimentRoot },
        );

        // —— 批量执行：6 单元全部完成，零失败，零续跑
        expect(outcome.failures).toEqual([]);
        expect(outcome.executed).toBe(6);
        expect(outcome.resumed).toBe(0);
        expect(outcome.records).toHaveLength(6);
        // —— 记录形状与薄 harness 同构：按 (case → config) 展开序对齐
        expect(
          outcome.records.map((record) => `${record.caseId}/${record.configId}`),
        ).toEqual([
          "dsh-e2e-001/A",
          "dsh-e2e-001/B",
          "dsh-e2e-002/A",
          "dsh-e2e-002/B",
          "dsh-e2e-003/A",
          "dsh-e2e-003/B",
        ]);
        for (const record of outcome.records) {
          expect(record.model).toBe("deepseek-v4-flash");
          expect(record.baseline.findings.map((finding) => finding.id)).toEqual(["F001"]);
          expect(record.baseline.rounds).toBe(1);
          expect(record.baseline.toolCalls).toBe(0);
        }
        // B 单元带确定性预取留痕（A 合法缺席）——preset 经请求参数逐单元切换
        for (const record of outcome.records.filter((entry) => entry.configId === "B")) {
          expect(record.baseline.audit.prefetch).toBeDefined();
        }
        // —— 审计文件（host 落盘）：可重读、6 请求全部携带 wireBody（真实适配器来源）
        const firstAudit = JSON.parse(
          await readFile(outcome.records[0]?.baseline.auditPath ?? "", "utf8"),
        ) as {
          readonly configId: string;
          readonly requests: readonly { readonly wireBody?: string }[];
        };
        expect(firstAudit.configId).toBe("A");
        expect(firstAudit.requests).toHaveLength(6);
        expect(firstAudit.requests.every((request) => request.wireBody !== undefined)).toBe(true);

        // —— 既有报告 / dashboard 管线零改动直接消费
        const report = await buildExperimentReport(outcome, {}, { experimentRoot });
        expect(report.executed).toBe(6);
        expect(report.failed).toBe(0);
        const markdown = renderDashboardMarkdown(report);
        expect(markdown).toContain("# Experiment Dashboard: dsh-e2e");
        expect(markdown).toContain("deepseek-v4-flash");
        expect(markdown).toContain("executed 6, resumed 0, failed 0");
      } finally {
        await driver.close();
        await stub.close();
      }
    },
    E2E_TIMEOUT_MS,
  );

  it("模型门：dshKernel 在场且 plan.model ≠ flash → 启动即报错（不烧任何单元）", async () => {
    const experimentRoot = await makeExperimentRoot("dsh-kernel-model-gate-");
    const neverCalledDriver: DshKernelDriver = {
      runUnit: () => {
        throw new Error("dsh-kernel model gate must reject before any unit runs");
      },
      close: async () => {},
    };

    await expect(
      runExperiment(
        // v4-pro 的既有成本护栏要求 highRiskOnly（先于内核门）；配齐后由内核门接住
        experimentPlan({
          experimentId: "dsh-model-gate",
          model: "deepseek-v4-pro",
          highRiskOnly: true,
        }),
        [experimentMainCase("dsh-model-gate", { labels: { riskClass: "High" } })],
        { llmClient: FakeLlmClient.fromResponses([]), dshKernel: neverCalledDriver },
        { experimentRoot },
      ),
    ).rejects.toThrow(/deepseek-v4-flash/);
  });
});
