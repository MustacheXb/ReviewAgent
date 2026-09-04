import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClaudeCodeRunOutput } from "../../src/reference/contracts.js";
import { CLAUDE_CODE_ALLOWED_TOOLS } from "../../src/reference/client.js";
import { CLAUDE_CODE_PROMPT_TEMPLATE_VERSION } from "../../src/reference/prompt.js";
import {
  REFERENCE_CASES_FILE,
  REFERENCE_PLAN_FILE,
  runClaudeCodeReference,
} from "../../src/reference/runner.js";
import { ReferenceRunStore } from "../../src/reference/run-store.js";
import {
  claudeStdout,
  FakeClaudeCodeClient,
  failedRunOutput,
  findingJson,
  okRunOutput,
  referenceCleanCase,
  referenceMainCase,
  referencePlan,
} from "./helpers.js";

/**
 * 外部参照运行器（Ticket 13 验收）：数据集 → 无头调用 → 归一化 → 记录/raw
 * 留档 → 断点续跑。失败隔离（exit≠0 / is_error / client 抛错）不拖垮整批；
 * 过期配置启动即报错（防混跑烧钱）。全部 FakeClaudeCodeClient 脚本化，零网络。
 */

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "review-agent-ref-runner-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function rootOf(id: string): { readonly referenceRoot: string } {
  return { referenceRoot: path.join(workDir, id) };
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("runClaudeCodeReference（执行与留档）", () => {
  it("单 case × 1 rep：记录 + raw 档案 + plan/cases 落盘，调用输入为完整提示词与同仓 cwd", async () => {
    const case_ = referenceMainCase("runner-happy-001");
    const client = FakeClaudeCodeClient.fromOutputs([
      okRunOutput(claudeStdout({ findings: [findingJson("F001")] })),
    ]);
    const outcome = await runClaudeCodeReference(
      referencePlan({ referenceId: "ref-happy" }),
      [case_],
      { client },
      rootOf("ref-happy"),
    );
    expect(outcome.executed).toBe(1);
    expect(outcome.resumed).toBe(0);
    expect(outcome.failures).toEqual([]);
    expect(outcome.records).toHaveLength(1);

    // 调用输入：完整提示词（含 diff 与输出纪律）+ 子进程 cwd = 被检仓库（同仓）
    expect(client.runInputs).toHaveLength(1);
    expect(client.runInputs[0]?.model).toBe("sonnet");
    expect(client.runInputs[0]?.maxTurns).toBe(5);
    expect(client.runInputs[0]?.cwd).toBe(case_.repoPath);
    expect(client.runInputs[0]?.prompt).toContain("Case ID: runner-happy-001");
    expect(client.runInputs[0]?.prompt).toContain('{"findings": []}');

    // 记录字段：归一化结果 + 版本/模型留档 + rawPath 指向真实档案
    const record = outcome.records[0];
    expect(record).toMatchObject({
      source: "defects4j",
      caseId: "runner-happy-001",
      rep: 1,
      status: "ok",
      requestedModel: "sonnet",
      actualModels: ["claude-sonnet-4-5"],
      claudeVersion: "2.1.241 (fake)",
      numTurns: 3,
      totalCostUsd: 0.05,
    });
    expect(record?.findings.map((f) => f.id)).toEqual(["F001"]);
    expect(record?.rawPath).toBe("raw/defects4j/runner-happy-001/rep-1.json");

    // raw 档案：提示词原文 / stdout 原文 / 配置 / CLI 版本（可复现性留档）
    const store = new ReferenceRunStore(rootOf("ref-happy").referenceRoot);
    const raw = (await readJson(
      store.rawPathOf({ source: "defects4j", caseId: "runner-happy-001", rep: 1 }),
    )) as Record<string, unknown>;
    expect(raw).toMatchObject({
      source: "defects4j",
      caseId: "runner-happy-001",
      rep: 1,
      requestedModel: "sonnet",
      maxTurns: 5,
      allowedTools: [...CLAUDE_CODE_ALLOWED_TOOLS],
      promptTemplateVersion: CLAUDE_CODE_PROMPT_TEMPLATE_VERSION,
      claudeVersion: "2.1.241 (fake)",
      exitCode: 0,
    });
    expect(raw.prompt).toBe(client.runInputs[0]?.prompt);
    expect(String(raw.stdout)).toContain("F001");

    // plan / cases 留痕
    const plan = (await readJson(
      path.join(rootOf("ref-happy").referenceRoot, REFERENCE_PLAN_FILE),
    )) as Record<string, unknown>;
    expect(plan).toMatchObject({ referenceId: "ref-happy", model: "sonnet" });
    expect(plan.caseIds).toEqual(["runner-happy-001"]);
    const cases = (await readJson(
      path.join(rootOf("ref-happy").referenceRoot, REFERENCE_CASES_FILE),
    )) as { caseId: string }[];
    expect(cases.map((c) => c.caseId)).toEqual(["runner-happy-001"]);
  });

  it("degraded：部分条目非法 → 记录保留合法条目 + 拦截留痕 + usage 照常记账", async () => {
    const client = FakeClaudeCodeClient.fromOutputs([
      okRunOutput(
        claudeStdout({
          findings: [findingJson("F001"), { ...findingJson("F002"), line: 0 }],
        }),
      ),
    ]);
    const outcome = await runClaudeCodeReference(
      referencePlan({ referenceId: "ref-degraded" }),
      [referenceMainCase("runner-degraded-001")],
      { client },
      rootOf("ref-degraded"),
    );
    const record = outcome.records[0];
    expect(record?.status).toBe("degraded");
    expect(record?.findings.map((f) => f.id)).toEqual(["F001"]);
    expect(record?.rejections).toHaveLength(1);
    expect(record?.rejections[0]).toMatchObject({
      candidateIndex: 1,
      stage: "ENTRY_SCHEMA_INVALID",
    });
    expect(record?.usage).toEqual({ inputTokens: 1000, outputTokens: 200 });
    expect(record?.parseNotes).toEqual([]);
  });

  it("失败隔离（exit ≠ 0）：留痕继续、失败单元无记录但 raw 档案仍在", async () => {
    const client = FakeClaudeCodeClient.fromOutputs([
      failedRunOutput("API error: quota exceeded", 1),
      okRunOutput(claudeStdout({ findings: [findingJson("F001")] })),
    ]);
    const outcome = await runClaudeCodeReference(
      referencePlan({ referenceId: "ref-fail-isolated" }),
      [referenceMainCase("runner-fail-001"), referenceMainCase("runner-fail-002")],
      { client },
      rootOf("ref-fail-isolated"),
    );
    expect(outcome.executed).toBe(1);
    expect(outcome.failures).toEqual([
      {
        source: "defects4j",
        caseId: "runner-fail-001",
        rep: 1,
        message: expect.stringContaining("exited with code 1"),
      },
    ]);
    expect(outcome.records.map((r) => r.caseId)).toEqual(["runner-fail-002"]);
    // 失败单元的 raw 档案仍留档（事后归因材料）
    const store = new ReferenceRunStore(rootOf("ref-fail-isolated").referenceRoot);
    expect(
      await exists(store.rawPathOf({ source: "defects4j", caseId: "runner-fail-001", rep: 1 })),
    ).toBe(true);
    expect(
      await exists(store.pathOf({ source: "defects4j", caseId: "runner-fail-001", rep: 1 })),
    ).toBe(false);
    // 失败留痕文件落盘
    const failures = (await readJson(
      path.join(rootOf("ref-fail-isolated").referenceRoot, "failures.json"),
    )) as unknown[];
    expect(failures).toHaveLength(1);
  });

  it("is_error = true：留痕失败（不落记录）", async () => {
    const client = FakeClaudeCodeClient.fromOutputs([
      okRunOutput(claudeStdout({ isError: true, result: "credit limit reached" })),
    ]);
    const outcome = await runClaudeCodeReference(
      referencePlan({ referenceId: "ref-is-error" }),
      [referenceMainCase("runner-iserror-001")],
      { client },
      rootOf("ref-is-error"),
    );
    expect(outcome.records).toEqual([]);
    expect(outcome.failures[0]?.message).toContain("is_error=true");
  });

  it("client 抛错（超时/无法启动）：留痕失败不拖垮整批", async () => {
    const client = FakeClaudeCodeClient.fromOutputs([
      { failsWith: "claude CLI timed out after 100ms" },
      okRunOutput(claudeStdout({ findings: [] })),
    ]);
    const outcome = await runClaudeCodeReference(
      referencePlan({ referenceId: "ref-client-throw" }),
      [referenceMainCase("runner-throw-001"), referenceMainCase("runner-throw-002")],
      { client },
      rootOf("ref-client-throw"),
    );
    expect(outcome.executed).toBe(1);
    expect(outcome.failures[0]).toMatchObject({
      caseId: "runner-throw-001",
      message: "claude CLI timed out after 100ms",
    });
  });

  it("onUnit 进度回调：resumed / completed / failed 事件齐备", async () => {
    const events: string[] = [];
    const client = FakeClaudeCodeClient.fromOutputs([
      okRunOutput(claudeStdout({ findings: [findingJson("F001")] })),
    ]);
    await runClaudeCodeReference(
      referencePlan({ referenceId: "ref-events" }),
      [referenceMainCase("runner-events-001")],
      {
        client,
        onUnit: (event) => events.push(event.kind),
      },
      rootOf("ref-events"),
    );
    expect(events).toEqual(["completed"]);
  });
});

describe("runClaudeCodeReference（断点续跑）", () => {
  it("已完成单元跳过（不再花钱），失败单元续跑重试（同数据集纪律）", async () => {
    // 首跑：case-1 成功、case-2 失败（数据集两例均落 cases.json，续跑须同集）
    const first = FakeClaudeCodeClient.fromOutputs([
      okRunOutput(claudeStdout({ findings: [findingJson("F001")] })),
      failedRunOutput("transient failure", 1),
    ]);
    await runClaudeCodeReference(
      referencePlan({ referenceId: "ref-resume" }),
      [referenceMainCase("runner-resume-001"), referenceMainCase("runner-resume-002")],
      { client: first },
      rootOf("ref-resume"),
    );

    // 续跑：case-1 缓存跳过（不再花钱），case-2 重试成功
    const second = FakeClaudeCodeClient.fromOutputs([
      okRunOutput(claudeStdout({ findings: [findingJson("F002")] })),
    ]);
    const outcome = await runClaudeCodeReference(
      referencePlan({ referenceId: "ref-resume" }),
      [referenceMainCase("runner-resume-001"), referenceMainCase("runner-resume-002")],
      { client: second },
      rootOf("ref-resume"),
    );
    expect(outcome.resumed).toBe(1);
    expect(outcome.executed).toBe(1);
    expect(second.runInputs).toHaveLength(1);
    expect(second.runInputs[0]?.prompt).toContain("Case ID: runner-resume-002");
    expect(outcome.records.map((r) => r.caseId)).toEqual([
      "runner-resume-001",
      "runner-resume-002",
    ]);
    // 重试成功后：失败留痕按最新状态覆盖（不再计入）
    const failures = (await readJson(
      path.join(rootOf("ref-resume").referenceRoot, "failures.json"),
    )) as unknown[];
    expect(failures).toEqual([]);
  });

  it("失败单元重跑：续跑时可重试（失败不留记录 → 不阻塞重试）", async () => {
    const failing = FakeClaudeCodeClient.fromOutputs([failedRunOutput("boom", 2)]);
    await runClaudeCodeReference(
      referencePlan({ referenceId: "ref-retry" }),
      [referenceMainCase("runner-retry-001")],
      { client: failing },
      rootOf("ref-retry"),
    );
    const retrying = FakeClaudeCodeClient.fromOutputs([
      okRunOutput(claudeStdout({ findings: [findingJson("F001")] })),
    ]);
    const outcome = await runClaudeCodeReference(
      referencePlan({ referenceId: "ref-retry" }),
      [referenceMainCase("runner-retry-001")],
      { client: retrying },
      rootOf("ref-retry"),
    );
    expect(outcome.resumed).toBe(0);
    expect(outcome.executed).toBe(1);
    expect(outcome.records).toHaveLength(1);
  });

  it("过期配置守卫：既有记录 model/maxTurns/promptTemplateVersion 与计划不符 → 启动即报错", async () => {
    const planA = referencePlan({ referenceId: "ref-stale" });
    await runClaudeCodeReference(
      planA,
      [referenceMainCase("runner-stale-001")],
      { client: FakeClaudeCodeClient.fromOutputs([okRunOutput(claudeStdout({}))]) },
      rootOf("ref-stale"),
    );
    for (const drift of [
      referencePlan({ referenceId: "ref-stale", model: "opus" }),
      referencePlan({ referenceId: "ref-stale", maxTurns: 8 }),
      referencePlan({ referenceId: "ref-stale", promptTemplateVersion: "claude-code-reference-2" }),
    ]) {
      await expect(
        runClaudeCodeReference(
          drift,
          [referenceMainCase("runner-stale-001")],
          { client: FakeClaudeCodeClient.fromOutputs([]) },
          rootOf("ref-stale"),
        ),
      ).rejects.toThrow(/different model\/maxTurns\/promptTemplateVersion/);
    }
  });

  it("数据集一致性守卫：同 id 不同 case 集 → 启动即报错", async () => {
    await runClaudeCodeReference(
      referencePlan({ referenceId: "ref-cases-guard" }),
      [referenceMainCase("runner-guard-001")],
      { client: FakeClaudeCodeClient.fromOutputs([okRunOutput(claudeStdout({}))]) },
      rootOf("ref-cases-guard"),
    );
    await expect(
      runClaudeCodeReference(
        referencePlan({ referenceId: "ref-cases-guard" }),
        [referenceMainCase("runner-guard-001"), referenceMainCase("runner-guard-002")],
        { client: FakeClaudeCodeClient.fromOutputs([]) },
        rootOf("ref-cases-guard"),
      ),
    ).rejects.toThrow(/different case set/);
  });

  it("client.version() 启动失败 → 整批 fail fast（不逐单元空转）", async () => {
    const brokenVersion = {
      run: () => Promise.reject(new Error("should not run")),
      version: () => Promise.reject(new Error("claude --version exited with 127")),
    };
    await expect(
      runClaudeCodeReference(
        referencePlan({ referenceId: "ref-version-fail" }),
        [referenceMainCase("runner-version-001")],
        { client: brokenVersion },
        rootOf("ref-version-fail"),
      ),
    ).rejects.toThrow("claude --version exited with 127");
  });
});

describe("runClaudeCodeReference（入样与展开）", () => {
  it("计划内空集（源/过滤不命中）：零单元、零调用", async () => {
    const client = FakeClaudeCodeClient.fromOutputs([]);
    const outcome = await runClaudeCodeReference(
      referencePlan({ referenceId: "ref-empty", sources: ["clean-mr"] }),
      [referenceMainCase("runner-empty-001")],
      { client },
      rootOf("ref-empty"),
    );
    expect(client.runInputs).toHaveLength(0);
    expect(outcome.records).toEqual([]);
    expect(outcome.executed).toBe(0);
  });

  it("reps = 2：同 case 两 rep 顺序执行（rep1 冷 / rep2 热口径输入）", async () => {
    const client = FakeClaudeCodeClient.fromOutputs([
      okRunOutput(claudeStdout({ findings: [findingJson("F001")] })),
      okRunOutput(claudeStdout({ findings: [findingJson("F002")] })),
    ]);
    const outcome = await runClaudeCodeReference(
      referencePlan({ referenceId: "ref-reps", reps: 2 }),
      [referenceMainCase("runner-reps-001")],
      { client },
      rootOf("ref-reps"),
    );
    expect(outcome.records.map((r) => r.rep)).toEqual([1, 2]);
    expect(client.runInputs).toHaveLength(2);
  });

  it("clean MR case 正常入样（truth = null 走阴性对照口径，由报告层处理）", async () => {
    const client = FakeClaudeCodeClient.fromOutputs([
      okRunOutput(claudeStdout({ findings: [findingJson("F001")] })),
    ]);
    const outcome = await runClaudeCodeReference(
      referencePlan({ referenceId: "ref-clean" }),
      [referenceCleanCase("runner-clean-001")],
      { client },
      rootOf("ref-clean"),
    );
    expect(outcome.records[0]).toMatchObject({
      source: "clean-mr",
      caseId: "runner-clean-001",
    });
  });
});
