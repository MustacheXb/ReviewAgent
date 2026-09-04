import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeLlmClient } from "../../src/fake/fake-llm-client.js";
import { HAPPY_PATH_TOTAL_USAGE, HAPPY_PATH_RESPONSES } from "../helpers/happy-path-script.js";
import { runExperiment } from "../../src/experiment/runner.js";
import { CASES_FILE, FAILURES_FILE, PLAN_FILE } from "../../src/experiment/runner.js";
import type { ExperimentOutcome } from "../../src/experiment/runner.js";
import {
  experimentCleanCase,
  experimentMainCase,
  experimentPlan,
  scriptedLlmClient,
} from "./helpers.js";

/**
 * 实验矩阵运行器（Ticket 12 / issue #13 验收）：
 * 数据集 → runReview → 审计落盘 → 记录落盘；断点续跑（已完成即跳过，不再花钱）；
 * 失败隔离（单单元失败留痕继续）；过期 model/verifier 配置启动即报错。
 * 全部 FakeLlmClient 脚本化回复，零网络零真实 LLM。
 */

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "review-agent-runner-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function rootOf(id: string): { readonly experimentRoot: string } {
  return { experimentRoot: path.join(workDir, id) };
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

describe("runExperiment（矩阵执行）", () => {
  it("单 case × config A × 1 rep：记录落盘 + plan/cases 留痕 + 审计文件", async () => {
    const case_ = experimentMainCase("runner-main-1");
    const outcome = await runExperiment(
      experimentPlan({ experimentId: "runner-happy" }),
      [case_],
      { llmClient: scriptedLlmClient(1) },
      rootOf("runner-happy"),
    );
    expect(outcome.executed).toBe(1);
    expect(outcome.resumed).toBe(0);
    expect(outcome.failures).toEqual([]);
    expect(outcome.records).toHaveLength(1);
    const record = outcome.records[0];
    expect(record).toMatchObject({
      source: "defects4j",
      caseId: "runner-main-1",
      configId: "A",
      rep: 1,
      model: "deepseek-v4-flash",
      verifier: "off",
    });
    expect(record?.baseline.findings).toHaveLength(1);
    expect(record?.baseline.usage).toEqual(HAPPY_PATH_TOTAL_USAGE);
    expect(record?.baseline.audit.requests).toBeUndefined();
    expect(record?.effective).toBeNull();
    expect(record?.verifierPass).toBeNull();
    // plan.json / cases.json 留痕（外部可复现实验配置与数据集选择）
    const plan = (await readJson(path.join(rootOf("runner-happy").experimentRoot, PLAN_FILE))) as {
      readonly experimentId: string;
      readonly caseIds: readonly string[];
    };
    expect(plan.experimentId).toBe("runner-happy");
    expect(plan.caseIds).toEqual(["runner-main-1"]);
    const cases = (await readJson(
      path.join(rootOf("runner-happy").experimentRoot, CASES_FILE),
    )) as readonly { readonly caseId: string }[];
    expect(cases.map((entry) => entry.caseId)).toEqual(["runner-main-1"]);
    // 审计可重放字节落在 audit/<source>/<caseId>/<configId>/rep-<rep>/
    const auditContent = (await readJson(
      path.join(
        rootOf("runner-happy").experimentRoot,
        "audit",
        "defects4j",
        "runner-main-1",
        "A",
        "rep-1",
        path.basename(record?.baseline.auditPath ?? "x"),
      ),
    )) as { readonly requests: readonly unknown[] };
    expect(auditContent.requests.length).toBeGreaterThan(0);
  });

  it("reps=2：记录按 rep 升序（rep1 冷 / rep2 热分层的输入顺序）", async () => {
    const outcome = await runExperiment(
      experimentPlan({ experimentId: "runner-reps", reps: 2 }),
      [experimentMainCase("runner-main-2")],
      { llmClient: scriptedLlmClient(2) },
      rootOf("runner-reps"),
    );
    expect(outcome.records.map((record) => record.rep)).toEqual([1, 2]);
    expect(outcome.executed).toBe(2);
  });

  it("多 case 混源：clean MR 与主集 case 同批执行", async () => {
    const main = experimentMainCase("runner-main-3");
    const clean = experimentCleanCase("runner-clean-3");
    const outcome = await runExperiment(
      experimentPlan({ experimentId: "runner-mixed" }),
      [main, clean],
      { llmClient: scriptedLlmClient(2) },
      rootOf("runner-mixed"),
    );
    expect(outcome.executed).toBe(2);
    expect(outcome.records.map((record) => `${record.source}/${record.caseId}`)).toEqual([
      "defects4j/runner-main-3",
      "clean-mr/runner-clean-3",
    ]);
    expect(outcome.cases.map((mrCase) => mrCase.caseId)).toEqual([
      "runner-main-3",
      "runner-clean-3",
    ]);
  });
});

describe("runExperiment（断点续跑）", () => {
  it("同计划重跑：已完成单元跳过（LLM 零调用），记录仍齐全", async () => {
    const case_ = experimentMainCase("runner-resume-1");
    const root = rootOf("runner-resume");
    const first = await runExperiment(
      experimentPlan({ experimentId: "runner-resume", reps: 2 }),
      [case_],
      { llmClient: scriptedLlmClient(2) },
      root,
    );
    expect(first.executed).toBe(2);
    const idleClient = new FakeLlmClient([]);
    const second = await runExperiment(
      experimentPlan({ experimentId: "runner-resume", reps: 2 }),
      [case_],
      { llmClient: idleClient },
      root,
    );
    expect(second.executed).toBe(0);
    expect(second.resumed).toBe(2);
    expect(idleClient.callCount).toBe(0); // 不再花钱
    expect(second.records).toHaveLength(2);
    expect(second.records.map((record) => record.rep)).toEqual([1, 2]);
  });

  it("model / verifier 与既有记录冲突：启动即报错（防静默重跑烧钱）", async () => {
    const case_ = experimentMainCase("runner-stale-1", { labels: { riskClass: "High" } });
    const root = rootOf("runner-stale");
    await runExperiment(
      experimentPlan({ experimentId: "runner-stale" }),
      [case_],
      { llmClient: scriptedLlmClient(1) },
      root,
    );
    await expect(
      runExperiment(
        experimentPlan({
          experimentId: "runner-stale",
          model: "deepseek-v4-pro",
          highRiskOnly: true,
        }),
        [case_],
        { llmClient: scriptedLlmClient(1) },
        root,
      ),
    ).rejects.toThrow(/different\s+model\/verifier configuration/);
    await expect(
      runExperiment(
        experimentPlan({ experimentId: "runner-stale", verifier: "on" }),
        [case_],
        { llmClient: scriptedLlmClient(1) },
        root,
      ),
    ).rejects.toThrow(/different\s+model\/verifier configuration/);
  });

  it("同 id 不同数据集选择：报错（防同目录混入异数据集记录）", async () => {
    const caseA = experimentMainCase("runner-case-a");
    const caseB = experimentMainCase("runner-case-b");
    const root = rootOf("runner-caseset");
    await runExperiment(
      experimentPlan({ experimentId: "runner-caseset" }),
      [caseA],
      { llmClient: scriptedLlmClient(1) },
      root,
    );
    await expect(
      runExperiment(
        experimentPlan({ experimentId: "runner-caseset" }),
        [caseA, caseB],
        { llmClient: scriptedLlmClient(2) },
        root,
      ),
    ).rejects.toThrow(/different case set/);
  });
});

describe("runExperiment（失败隔离）", () => {
  it("单单元 LLM 失败：留痕 failures + failures.json，其余单元继续", async () => {
    const plan = experimentPlan({ experimentId: "runner-isolation" });
    const cases = [experimentMainCase("runner-iso-1"), experimentMainCase("runner-iso-2")];
    // 单元 1 正常完成；单元 2 注入确定性失败（fail 步）→ 留痕后整批继续
    const client = new FakeLlmClient([
      ...HAPPY_PATH_RESPONSES.map((response) => ({ kind: "reply" as const, response })),
      { kind: "fail" as const, error: new Error("injected unit failure") },
    ]);
    const outcome = await runExperiment(plan, cases, { llmClient: client }, rootOf("runner-isolation"));
    expect(outcome.executed).toBe(1);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]).toMatchObject({
      source: "defects4j",
      caseId: "runner-iso-2",
      configId: "A",
      rep: 1,
    });
    expect(outcome.failures[0]?.message).toContain("injected unit failure");
    expect(outcome.records.map((record) => record.caseId)).toEqual(["runner-iso-1"]);
    // 失败留痕落盘（--report-only 重建报告的数据源）
    const persisted = (await readJson(
      path.join(rootOf("runner-isolation").experimentRoot, FAILURES_FILE),
    )) as readonly { readonly caseId: string }[];
    expect(persisted).toEqual(outcome.failures);
  });

  it("全部单元失败：failures 全留痕，records 为空", async () => {
    const client = new FakeLlmClient([{ kind: "fail", error: new Error("api down") }]);
    const outcome = await runExperiment(
      experimentPlan({ experimentId: "runner-all-fail" }),
      [experimentMainCase("runner-af-1")],
      { llmClient: client },
      rootOf("runner-all-fail"),
    );
    expect(outcome.executed).toBe(0);
    expect(outcome.records).toEqual([]);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.message).toContain("api down");
  });
});

describe("runExperiment（Verifier 消融开关）", () => {
  it("verifier=on：effective = 复核后 Finding + 合并 usage；verifierPass 留痕", async () => {
    const outcome = await runExperiment(
      experimentPlan({ experimentId: "runner-verifier", verifier: "on" }),
      [experimentMainCase("runner-vf-1")],
      { llmClient: scriptedLlmClient(1, "on") },
      rootOf("runner-verifier"),
    );
    const record = outcome.records[0];
    expect(record?.verifier).toBe("on");
    expect(record?.verifierPass?.status).toBe("verified");
    expect(record?.verifierPass?.usage).toEqual({ inputTokens: 50, outputTokens: 5 });
    expect(record?.effective).not.toBeNull();
    // 合并 usage = 基线 + verifier（token 计入 CARC 的口径）
    expect(record?.effective?.usage).toEqual({
      inputTokens: HAPPY_PATH_TOTAL_USAGE.inputTokens + 50,
      outputTokens: HAPPY_PATH_TOTAL_USAGE.outputTokens + 5,
      cacheReadTokens: HAPPY_PATH_TOTAL_USAGE.cacheReadTokens,
      cacheWriteTokens: HAPPY_PATH_TOTAL_USAGE.cacheWriteTokens,
    });
    expect(record?.effective?.findings).toEqual(record?.baseline.findings);
  });

  it("verifier=on 复核剔除：effective.findings 为空（基线保留对照）", async () => {
    const outcome = await runExperiment(
      experimentPlan({ experimentId: "runner-verifier-remove", verifier: "on" }),
      [experimentMainCase("runner-vf-2")],
      { llmClient: scriptedLlmClient(1, "on", { verifierPass: false }) },
      rootOf("runner-verifier-remove"),
    );
    const record = outcome.records[0];
    expect(record?.baseline.findings).toHaveLength(1);
    expect(record?.effective?.findings).toEqual([]);
    expect(record?.verifierPass?.removedFindingIds).toEqual(["F001"]);
  });
});

describe("runExperiment（进度回调）", () => {
  it("onUnit 依次派发 completed/resumed/failed（回调异常不拖垮实验）", async () => {
    const case_ = experimentMainCase("runner-events-1");
    const root = rootOf("runner-events");
    const events: string[] = [];
    await runExperiment(
      experimentPlan({ experimentId: "runner-events" }),
      [case_],
      { llmClient: scriptedLlmClient(1), onUnit: (event) => events.push(event.kind) },
      root,
    );
    await runExperiment(
      experimentPlan({ experimentId: "runner-events" }),
      [case_],
      {
        llmClient: new FakeLlmClient([]),
        onUnit: (event) => {
          events.push(event.kind);
          throw new Error("observer crash must not stop the experiment");
        },
      },
      root,
    );
    expect(events).toEqual(["completed", "resumed"]);
  });
});

describe("runExperiment（ExperimentOutcome 形状）", () => {
  it("expanded 携带展开结果（units/skipped 可审计）", async () => {
    const outcome: ExperimentOutcome = await runExperiment(
      experimentPlan({ experimentId: "runner-shape" }),
      [experimentMainCase("runner-shape-1"), experimentCleanCase("runner-shape-c")],
      { llmClient: scriptedLlmClient(2) },
      rootOf("runner-shape"),
    );
    expect(outcome.experimentId).toBe("runner-shape");
    expect(outcome.expanded.units).toHaveLength(2);
    expect(outcome.expanded.skipped).toEqual([]);
  });
});
