import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeLlmClient } from "../src/fake/fake-llm-client.js";
import { SYSTEM_PROMPT } from "../src/loop/messages.js";
import { runReview } from "../src/run/run-review.js";
import { CONFIGS } from "../src/contracts/config.js";
import type { LlmResponse, ToolCall } from "../src/contracts/llm-client.js";
import { buildReviewToolkit } from "../src/tools/toolkit.js";
import { DEFAULT_FULL_REPO_BUDGET_CHARS } from "../src/zoneb/full-repo-injection.js";
import { SAMPLE_MR_CASE } from "./fixtures/sample-mr-case.js";
import { HAPPY_PATH_FINDING, HAPPY_PATH_RESPONSES } from "./helpers/happy-path-script.js";
import { reply, toolCallReply } from "./helpers/llm-script.js";

/**
 * 工单 #6 主 seam 断言（fake LLM 捕获的请求）：config C 全仓注入 + 预算守卫 +
 * 工具挂载（注册表 schema 字节稳定）+ 脚本化工具调用走通（调用 → 结果回注 → 续跑）。
 */

let auditDir: string;

beforeAll(async () => {
  auditDir = await mkdtemp(path.join(tmpdir(), "review-agent-config-c-"));
});

afterAll(async () => {
  await rm(auditDir, { recursive: true, force: true });
});

const getSymbolCall: ToolCall = {
  id: "call-1",
  name: "review.get_symbol",
  argumentsJson: '{"symbol":"sumFirst"}',
};

/** 六阶段脚本：Context Retrieval 阶段先调用 review.get_symbol，收到结果后续跑并完成 */
function configCScript(): readonly LlmResponse[] {
  return [
    reply(JSON.stringify({ summary: "The MR changes the loop bound of MathUtils.sumFirst." })),
    reply(JSON.stringify({ riskClass: "Medium", reason: "Core arithmetic logic changes." })),
    reply(JSON.stringify({ neededContext: ["Signature of MathUtils.sumFirst"], reason: "Impact analysis." })),
    toolCallReply([getSymbolCall]),
    reply(JSON.stringify({ notes: "The symbol signature was retrieved via review.get_symbol." })),
    reply(JSON.stringify({ candidates: [HAPPY_PATH_FINDING] })),
    reply(
      JSON.stringify({
        verdicts: [{ id: "F001", pass: true, reason: "Evidence is concrete." }],
        complete: true,
      }),
    ),
  ];
}

describe("runReview — config C end-to-end (fake LLM, full-repo injection + tools)", () => {
  it("completes the run with a scripted tool call: call → result injection → continued run", async () => {
    const fake = FakeLlmClient.fromResponses(configCScript());
    const result = await runReview(CONFIGS.C, SAMPLE_MR_CASE, fake, { auditDir });

    expect(result.configId).toBe("C");
    expect(result.rounds).toBe(1);
    expect(result.toolCalls).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.audit.truncated).toBe(false);
    // 7 次请求：六阶段 + Context Retrieval 的工具结果回注重调
    expect(result.audit.requests).toHaveLength(7);

    const record = result.audit.toolCallLog[0];
    expect(record?.name).toBe("review.get_symbol");
    expect(record?.argumentsJson).toBe('{"symbol":"sumFirst"}');
    expect(record?.resultSummary).toContain("public static int sumFirst(int[] values, int count)");
    expect(record?.resultSummary).not.toMatch(/^ERROR:/);

    // 结果回注：工具调用后的下一次请求含 assistant(toolCalls) + tool(result) 消息（Zone C append-only）
    const recallRequest = result.audit.requests[4];
    const toolMessages = recallRequest?.messages.filter((message) => message.role === "tool") ?? [];
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.toolCallId).toBe("call-1");
    expect(toolMessages[0]?.content).toContain("public static int sumFirst(int[] values, int count)");
    const assistantWithCalls = recallRequest?.messages.find((message) => message.toolCalls?.length);
    expect(assistantWithCalls?.toolCalls?.[0]?.name).toBe("review.get_symbol");
  });

  it("mounts the registry tool schemas in every request (byte-stable)", async () => {
    const fake = FakeLlmClient.fromResponses(configCScript());
    const result = await runReview(CONFIGS.C, SAMPLE_MR_CASE, fake, { auditDir });
    const toolkit = buildReviewToolkit({ repoPath: SAMPLE_MR_CASE.repoPath, diff: SAMPLE_MR_CASE.diff });

    for (const request of result.audit.requests) {
      expect(request.tools).toEqual(toolkit.tools);
      expect(request.messages[0]?.role).toBe("system");
      expect(request.messages[0]?.content).toBe(SYSTEM_PROMPT);
    }
  });

  it("injects the full repository context after the diff message in every request", async () => {
    const fake = FakeLlmClient.fromResponses(configCScript());
    const result = await runReview(CONFIGS.C, SAMPLE_MR_CASE, fake, { auditDir });

    for (const request of result.audit.requests) {
      expect(request.messages[1]?.content).toContain("Unified diff:");
      const fullRepo = request.messages[2];
      expect(fullRepo?.role).toBe("user");
      expect(fullRepo?.content.startsWith("Full repository context (config C).")).toBe(true);
      expect(fullRepo?.content).toContain("## File: src/main/java/com/example/math/MathUtils.java (");
      expect(fullRepo?.content).toContain("## File: src/main/java/com/example/util/StringUtils.java (");
      expect(fullRepo?.content).toContain("public static String join(String[] parts, String separator)");
      expect(fullRepo?.content).not.toMatch(/Full repository context truncated/);
    }
  });

  it("keeps Zone C append-only across requests (each request is a strict prefix of the next)", async () => {
    const fake = FakeLlmClient.fromResponses(configCScript());
    const result = await runReview(CONFIGS.C, SAMPLE_MR_CASE, fake, { auditDir });
    const requests = result.audit.requests;
    for (let i = 0; i + 1 < requests.length; i++) {
      const earlier = requests[i]?.messages ?? [];
      const later = requests[i + 1]?.messages ?? [];
      expect(earlier.length).toBeLessThan(later.length);
      expect(later.slice(0, earlier.length)).toEqual(earlier);
    }
  });

  it("records the full-repo injection accounting in the audit and persists it to disk", async () => {
    const fake = FakeLlmClient.fromResponses(configCScript());
    const result = await runReview(CONFIGS.C, SAMPLE_MR_CASE, fake, { auditDir });

    expect(result.audit.fullRepo).toEqual({
      budgetChars: DEFAULT_FULL_REPO_BUDGET_CHARS,
      contentChars: expect.any(Number),
      truncated: false,
      totalFiles: 4,
      shownFiles: 4,
    });
    expect(result.audit.prefetch).toBeUndefined();

    const raw = await readFile(result.auditPath as string, "utf8");
    const auditFile = JSON.parse(raw) as Record<string, unknown>;
    expect(auditFile.fullRepo).toEqual(result.audit.fullRepo);
    expect(auditFile.requests).toEqual(fake.capturedRequests);
    expect(auditFile.toolCallLog).toEqual(result.audit.toolCallLog);
  });

  it("enforces the budget guard with an explicit truncation trail (file-level frontier fill)", async () => {
    const fake = FakeLlmClient.fromResponses(configCScript());
    const result = await runReview(CONFIGS.C, SAMPLE_MR_CASE, fake, {
      auditDir,
      fullRepoBudgetChars: 800,
    });

    expect(result.audit.fullRepo?.truncated).toBe(true);
    expect(result.audit.fullRepo?.totalFiles).toBe(4);
    expect(result.audit.fullRepo?.shownFiles).toBe(2);
    expect(result.audit.fullRepo?.budgetChars).toBe(800);

    const content = result.audit.requests[0]?.messages[2]?.content ?? "";
    expect(content).toContain(
      "Full repository context truncated: showing 2 of 4 files (budget 800 chars exceeded).",
    );
    expect(content).toContain("(file truncated; full-repo budget exceeded)");
    expect(content).toContain(
      "Files not included: src/main/java/com/example/math/MathUtils.java, src/main/java/com/example/util/StringUtils.java",
    );
  });

  it("degrades to an explicit zero-file notice when the budget fits no file at all", async () => {
    const fake = FakeLlmClient.fromResponses(configCScript());
    const result = await runReview(CONFIGS.C, SAMPLE_MR_CASE, fake, {
      auditDir,
      fullRepoBudgetChars: 50,
    });

    expect(result.audit.fullRepo?.truncated).toBe(true);
    expect(result.audit.fullRepo?.shownFiles).toBe(0);
    const content = result.audit.requests[0]?.messages[2]?.content ?? "";
    expect(content).toContain("Full repository context truncated: showing 0 of 4 files (budget 50 chars exceeded).");
    expect(content).not.toContain("## File:");
  });

  it("reproduces the exact request bytes across two independent config C runs", async () => {
    const first = FakeLlmClient.fromResponses(configCScript());
    const second = FakeLlmClient.fromResponses(configCScript());
    await runReview(CONFIGS.C, SAMPLE_MR_CASE, first, { auditDir });
    await runReview(CONFIGS.C, SAMPLE_MR_CASE, second, { auditDir });

    expect(second.capturedRequests).toEqual(first.capturedRequests);
  });

  it("rejects a config C run against a missing repository path with a clear error", async () => {
    const fake = FakeLlmClient.fromResponses(configCScript());
    await expect(
      runReview(CONFIGS.C, { ...SAMPLE_MR_CASE, repoPath: "Z:/definitely/not/a/repo" }, fake, { auditDir }),
    ).rejects.toThrow(/failed to build full repository context: failed to list Java files/);
  });

  it("rejects invalid budget options at the system boundary", async () => {
    const fake = FakeLlmClient.fromResponses(configCScript());
    await expect(
      runReview(CONFIGS.C, SAMPLE_MR_CASE, fake, { auditDir, fullRepoBudgetChars: 0 }),
    ).rejects.toThrow(/options\.fullRepoBudgetChars must be a positive integer/);
    await expect(
      runReview(CONFIGS.C, SAMPLE_MR_CASE, fake, { auditDir, toolResultBudgetChars: 1.5 }),
    ).rejects.toThrow(/options\.toolResultBudgetChars must be a positive integer/);
  });
});

describe("regression — config A and B stay zero-tool (no auto-mounting)", () => {
  it("sends zero tools in every config A and config B request when no tool options are given", async () => {
    const fakeA = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    const fakeB = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    const resultA = await runReview(CONFIGS.A, SAMPLE_MR_CASE, fakeA, { auditDir });
    const resultB = await runReview(CONFIGS.B, SAMPLE_MR_CASE, fakeB, { auditDir });

    for (const request of [...resultA.audit.requests, ...resultB.audit.requests]) {
      expect(request.tools).toEqual([]);
    }
    expect(resultA.toolCalls).toBe(0);
    expect(resultB.toolCalls).toBe(0);
    expect(resultA.audit.fullRepo).toBeUndefined();
    expect(resultB.audit.fullRepo).toBeUndefined();
  });
});
