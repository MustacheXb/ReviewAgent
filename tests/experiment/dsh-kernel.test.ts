/**
 * #27 验收（实验面 e2e）：experiment runner 接 DSH 内核。
 *
 * 小批冒烟（票面：≥3 单元 × ≥1 配置）：3 case × configs A,B × rep1 = 6 单元，
 * 全部经**单一长驻 host 进程**（agent-per-unit）执行——llmClient 注入空脚本
 * FakeLlmClient（任何调用即抛），证明 DSH 分支不触碰 POC1 进程内客户端
 * （隐式变异护栏：分支翻回 runReview 会立刻烧穿脚本）。产物断言走全链路：
 * RunRecord 落盘（断点续跑面）→ 报告 / dashboard 直接消费（零改动管线）。
 *
 * 另：模型面（#45）——plan.model 经 runUnit 请求参数透传内核（自由 id 放行，
 * 不再锁死 flash）；退役 id 启动即报错（不烧任何单元）；内核回传 model 与
 * plan 漂移 → 单元失败留痕，不落假记录（口径诚实护栏）。
 *
 * LLM 端点 = 本地 stub（127.0.0.1，零外网）；凭据经环境变量注入，哨兵 key
 * 不出现在任何断言输出里。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { renderDashboardMarkdown } from "../../src/experiment/dashboard.js";
import { createDshKernelDriver, type DshKernelDriver, type DshKernelUnitRequest } from "../../src/experiment/dsh-kernel.js";
import type { RunResult } from "../../src/contracts/run.js";
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
        // plan.model 到达 wire（#45 透传）：请求体 model 字段与计划一致
        const firstWire = JSON.parse(String(firstAudit.requests[0]?.wireBody)) as Record<string, unknown>;
        expect(firstWire.model).toBe("deepseek-v4-flash");

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

  it("退役模型门：dshKernel 在场且 plan.model 为退役 id → 启动即报错（不烧任何单元）", async () => {
    const experimentRoot = await makeExperimentRoot("dsh-kernel-model-gate-");
    const neverCalledDriver: DshKernelDriver = {
      runUnit: () => {
        throw new Error("dsh-kernel model gate must reject before any unit runs");
      },
      close: async () => {},
    };

    await expect(
      runExperiment(
        experimentPlan({ experimentId: "dsh-model-gate", model: "deepseek-chat" }),
        [experimentMainCase("dsh-model-gate")],
        { llmClient: FakeLlmClient.fromResponses([]), dshKernel: neverCalledDriver },
        { experimentRoot },
      ),
    ).rejects.toThrow(/retired/);
  });

  it("model 透传：plan.model 自由 id 经 runUnit 请求参数下传内核（不再锁死 flash）", async () => {
    const experimentRoot = await makeExperimentRoot("dsh-kernel-model-passthrough-");
    const requests: DshKernelUnitRequest[] = [];
    const driver: DshKernelDriver = {
      runUnit: async (request) => {
        requests.push(request);
        return kernelRunResult(request, request.model ?? "deepseek-v4-flash");
      },
      close: async () => {},
    };

    const outcome = await runExperiment(
      experimentPlan({ experimentId: "dsh-model-passthrough", model: "glm-4.7" }),
      [experimentMainCase("dsh-model-passthrough")],
      { llmClient: FakeLlmClient.fromResponses([]), dshKernel: driver },
      { experimentRoot },
    );

    // 请求面：model 作为 review/run 参数下传（缺省值硬编码在内核侧，不在此）
    expect(outcome.failures).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe("glm-4.7");
    // 记录面：RunRecord.model 与内核回传一致（口径诚实）
    expect(outcome.records).toHaveLength(1);
    expect(outcome.records[0]?.model).toBe("glm-4.7");
  });

  it("回传漂移拒绝：内核实际 model ≠ plan.model → 单元失败留痕，不落假记录", async () => {
    const experimentRoot = await makeExperimentRoot("dsh-kernel-model-drift-");
    const driver: DshKernelDriver = {
      // 模拟内核答非所问：plan 要 glm-4.7，回传 flash——记录会撒谎，必须拒绝落盘
      runUnit: async (request) => kernelRunResult(request, "deepseek-v4-flash"),
      close: async () => {},
    };

    const outcome = await runExperiment(
      experimentPlan({ experimentId: "dsh-model-drift", model: "glm-4.7" }),
      [experimentMainCase("dsh-model-drift")],
      { llmClient: FakeLlmClient.fromResponses([]), dshKernel: driver },
      { experimentRoot },
    );

    expect(outcome.executed).toBe(0);
    expect(outcome.records).toHaveLength(0);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.message).toMatch(/model/u);
  });
});

/** 录制驱动器用的最小合法 RunResult（usage/审计零事件；model / outputLanguage 由调用方指定） */
function kernelRunResult(
  request: DshKernelUnitRequest,
  model: string,
  outputLanguage?: "en" | "zh",
): RunResult {
  return {
    caseId: request.caseId,
    configId: request.configId,
    model,
    ...(outputLanguage !== undefined ? { outputLanguage } : {}),
    findings: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    rounds: 1,
    toolCalls: 0,
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

describe("语言面（#58：outputLanguage 经 plan → runUnit 请求 → 运行记录）", () => {
  it("zh 透传：plan.outputLanguage 经 runUnit 的 language 参数下传；记录携带 zh", async () => {
    const experimentRoot = await makeExperimentRoot("dsh-kernel-language-zh-");
    const requests: DshKernelUnitRequest[] = [];
    const driver: DshKernelDriver = {
      runUnit: async (request) => {
        requests.push(request);
        return kernelRunResult(request, "deepseek-v4-flash", "zh");
      },
      close: async () => {},
    };

    const outcome = await runExperiment(
      experimentPlan({ experimentId: "dsh-language-zh", outputLanguage: "zh" }),
      [experimentMainCase("dsh-language-zh")],
      { llmClient: FakeLlmClient.fromResponses([]), dshKernel: driver },
      { experimentRoot },
    );

    // 请求面：language 作为 review/run 参数下传（缺省值硬编码在内核侧）
    expect(outcome.failures).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.language).toBe("zh");
    // 记录面：RunRecord 恒携带解析后的语言（manifest 留痕，读取端无缺席归一）
    expect(outcome.records).toHaveLength(1);
    expect(outcome.records[0]?.outputLanguage).toBe("zh");
  });

  it("缺省：plan 无 outputLanguage → 请求 language 字段缺席（en 走内核缺省）；记录携带 en", async () => {
    const experimentRoot = await makeExperimentRoot("dsh-kernel-language-default-");
    const requests: DshKernelUnitRequest[] = [];
    const driver: DshKernelDriver = {
      runUnit: async (request) => {
        requests.push(request);
        return kernelRunResult(request, "deepseek-v4-flash");
      },
      close: async () => {},
    };

    const outcome = await runExperiment(
      experimentPlan({ experimentId: "dsh-language-default" }),
      [experimentMainCase("dsh-language-default")],
      { llmClient: FakeLlmClient.fromResponses([]), dshKernel: driver },
      { experimentRoot },
    );

    expect(outcome.failures).toEqual([]);
    // 请求面：字段缺席（exactOptionalPropertyTypes：缺省 = 不传，非显式 undefined）
    expect(requests).toHaveLength(1);
    expect("language" in (requests[0] ?? {})).toBe(false);
    // 记录面：恒携带 en（新记录永远带语言字段）
    expect(outcome.records[0]?.outputLanguage).toBe("en");
  });

  it("回传漂移拒绝：plan zh、内核回传 en → 单元失败留痕，不落假记录", async () => {
    const experimentRoot = await makeExperimentRoot("dsh-kernel-language-drift-");
    const driver: DshKernelDriver = {
      // 模拟内核答非所问：plan 要 zh，回传 en——记录会撒谎，必须拒绝落盘
      runUnit: async (request) => kernelRunResult(request, "deepseek-v4-flash", "en"),
      close: async () => {},
    };

    const outcome = await runExperiment(
      experimentPlan({ experimentId: "dsh-language-drift", outputLanguage: "zh" }),
      [experimentMainCase("dsh-language-drift")],
      { llmClient: FakeLlmClient.fromResponses([]), dshKernel: driver },
      { experimentRoot },
    );

    expect(outcome.executed).toBe(0);
    expect(outcome.records).toHaveLength(0);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.message).toMatch(/outputLanguage/u);
  });

  it("POC1 基线护栏：plan zh 且无 dshKernel → 启动即报错（POC1 冻结 harness 是 en 锚定，zh 必须走 DSH 内核）", async () => {
    const experimentRoot = await makeExperimentRoot("dsh-kernel-language-poc1-");

    await expect(
      runExperiment(
        experimentPlan({ experimentId: "dsh-language-poc1", outputLanguage: "zh" }),
        [experimentMainCase("dsh-language-poc1")],
        { llmClient: FakeLlmClient.fromResponses([]) },
        { experimentRoot },
      ),
    ).rejects.toThrow(/outputLanguage.*zh.*DSH kernel/u);
  });

  it("断点续跑口径护栏：既有 zh 记录 + 缺省 en 计划 → 启动即报错（指标不跨语言混比）", async () => {
    const experimentRoot = await makeExperimentRoot("dsh-kernel-language-resume-");
    const zhDriver: DshKernelDriver = {
      runUnit: async (request) => kernelRunResult(request, "deepseek-v4-flash", "zh"),
      close: async () => {},
    };
    await runExperiment(
      experimentPlan({ experimentId: "dsh-language-resume", outputLanguage: "zh" }),
      [experimentMainCase("dsh-language-resume")],
      { llmClient: FakeLlmClient.fromResponses([]), dshKernel: zhDriver },
      { experimentRoot },
    );

    // 同 id 续跑但计划缺省 en：既有 zh 记录与新计划口径不符——启动即报错
    const enDriver: DshKernelDriver = {
      runUnit: async () => {
        throw new Error("language resume guard must reject before any unit runs");
      },
      close: async () => {},
    };
    await expect(
      runExperiment(
        experimentPlan({ experimentId: "dsh-language-resume" }),
        [experimentMainCase("dsh-language-resume")],
        { llmClient: FakeLlmClient.fromResponses([]), dshKernel: enDriver },
        { experimentRoot },
      ),
    ).rejects.toThrow(/outputLanguage/u);
  });
});
