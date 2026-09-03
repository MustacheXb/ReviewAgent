import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeLlmClient } from "../src/fake/fake-llm-client.js";
import { SYSTEM_PROMPT } from "../src/loop/messages.js";
import { runReview } from "../src/run/run-review.js";
import { CONFIGS } from "../src/contracts/config.js";
import type { LlmResponse, ToolCall } from "../src/contracts/llm-client.js";
import { buildReviewToolkit } from "../src/tools/toolkit.js";
import { SAMPLE_MR_CASE } from "./fixtures/sample-mr-case.js";
import { HAPPY_PATH_FINDING, HAPPY_PATH_RESPONSES } from "./helpers/happy-path-script.js";
import { reply, toolCallReply } from "./helpers/llm-script.js";

/**
 * 工单 #6 主 seam 断言：config D = Minimal Context + Stable Prefix。
 * - 最小上下文起点：请求从 [system(Zone A), user(diff)] 开始，无任何注入层；
 * - Zone A 纪律：system 字节 + 工具 schema 字节全程稳定，且与 config C 完全一致
 *   （C/D 挂载同一套注册表 schema，前缀对比不被工具差异污染）。
 */

let auditDir: string;

beforeAll(async () => {
  auditDir = await mkdtemp(path.join(tmpdir(), "review-agent-config-d-"));
});

afterAll(async () => {
  await rm(auditDir, { recursive: true, force: true });
});

const getFileCall: ToolCall = {
  id: "call-1",
  name: "review.get_file",
  argumentsJson:
    '{"path":"src/main/java/com/example/math/MathUtils.java","startLine":15,"endLine":22}',
};

/** 六阶段脚本：Context Retrieval 阶段先做区间读取，收到结果后续跑并完成 */
function configDScript(): readonly LlmResponse[] {
  return [
    reply(JSON.stringify({ summary: "The MR changes the loop bound of MathUtils.sumFirst." })),
    reply(JSON.stringify({ riskClass: "Medium", reason: "Core arithmetic logic changes." })),
    reply(JSON.stringify({ neededContext: ["Loop body of MathUtils.sumFirst"], reason: "Impact analysis." })),
    toolCallReply([getFileCall]),
    reply(JSON.stringify({ notes: "The changed region was read via review.get_file." })),
    reply(JSON.stringify({ candidates: [HAPPY_PATH_FINDING] })),
    reply(
      JSON.stringify({
        verdicts: [{ id: "F001", pass: true, reason: "Evidence is concrete." }],
        complete: true,
      }),
    ),
  ];
}

describe("runReview — config D end-to-end (fake LLM, minimal context + stable prefix)", () => {
  it("completes the run with a scripted range read: call → result injection → continued run", async () => {
    const fake = FakeLlmClient.fromResponses(configDScript());
    const result = await runReview(CONFIGS.D, SAMPLE_MR_CASE, fake, { auditDir });

    expect(result.configId).toBe("D");
    expect(result.rounds).toBe(1);
    expect(result.toolCalls).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.audit.requests).toHaveLength(7);

    const record = result.audit.toolCallLog[0];
    expect(record?.name).toBe("review.get_file");
    expect(record?.resultSummary).toContain("18 |     public static int sumFirst(int[] values, int count) {");
    expect(record?.resultSummary).not.toMatch(/^ERROR:/);

    const toolMessages =
      result.audit.requests[4]?.messages.filter((message) => message.role === "tool") ?? [];
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.toolCallId).toBe("call-1");
    expect(toolMessages[0]?.content).toContain("Lines 15-22 of 25");
  });

  it("starts from the minimal context: system + diff only, no injected layers", async () => {
    const fake = FakeLlmClient.fromResponses(configDScript());
    const result = await runReview(CONFIGS.D, SAMPLE_MR_CASE, fake, { auditDir });

    for (const request of result.audit.requests) {
      const messages = request.messages;
      expect(messages[0]?.role).toBe("system");
      expect(messages[0]?.content).toBe(SYSTEM_PROMPT);
      expect(messages[1]?.role).toBe("user");
      expect(messages[1]?.content).toContain("Unified diff:");
      const joined = messages.map((message) => message.content).join("\n");
      expect(joined).not.toContain("Repository context (Zone B)");
      expect(joined).not.toContain("Full repository context");
      expect(joined).not.toContain("- Symbol layer.");
    }
    expect(result.audit.prefetch).toBeUndefined();
    expect(result.audit.fullRepo).toBeUndefined();
  });

  it("keeps Zone A byte-stable within the run: identical system prompt and tool schema bytes in every request", async () => {
    const fake = FakeLlmClient.fromResponses(configDScript());
    const result = await runReview(CONFIGS.D, SAMPLE_MR_CASE, fake, { auditDir });

    const firstSystem = result.audit.requests[0]?.messages[0]?.content;
    const firstTools = JSON.stringify(result.audit.requests[0]?.tools);
    expect(firstSystem).toBe(SYSTEM_PROMPT);
    for (const request of result.audit.requests) {
      expect(request.messages[0]?.content).toBe(firstSystem);
      expect(JSON.stringify(request.tools)).toBe(firstTools);
    }
    expect(result.audit.requests[0]?.tools.length).toBe(3);
  });

  it("mounts tool schemas byte-identical to config C (registry as the single source)", async () => {
    const fakeC = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    const fakeD = FakeLlmClient.fromResponses(configDScript());
    await runReview(CONFIGS.C, SAMPLE_MR_CASE, fakeC, { auditDir });
    const resultD = await runReview(CONFIGS.D, SAMPLE_MR_CASE, fakeD, { auditDir });

    const toolkit = buildReviewToolkit({ repoPath: SAMPLE_MR_CASE.repoPath, diff: SAMPLE_MR_CASE.diff });
    const registryBytes = JSON.stringify(toolkit.tools);
    const configCBytes = JSON.stringify(fakeC.capturedRequests[0]?.tools);
    const configDBytes = JSON.stringify(resultD.audit.requests[0]?.tools);

    expect(configCBytes).toBe(registryBytes);
    expect(configDBytes).toBe(registryBytes);
    expect(resultD.audit.requests.every((request) => JSON.stringify(request.tools) === registryBytes)).toBe(true);
  });

  it("keeps Zone C append-only across requests (each request is a strict prefix of the next)", async () => {
    const fake = FakeLlmClient.fromResponses(configDScript());
    const result = await runReview(CONFIGS.D, SAMPLE_MR_CASE, fake, { auditDir });
    const requests = result.audit.requests;
    for (let i = 0; i + 1 < requests.length; i++) {
      const earlier = requests[i]?.messages ?? [];
      const later = requests[i + 1]?.messages ?? [];
      expect(earlier.length).toBeLessThan(later.length);
      expect(later.slice(0, earlier.length)).toEqual(earlier);
    }
  });

  it("reproduces the exact request bytes across two independent config D runs", async () => {
    const first = FakeLlmClient.fromResponses(configDScript());
    const second = FakeLlmClient.fromResponses(configDScript());
    await runReview(CONFIGS.D, SAMPLE_MR_CASE, first, { auditDir });
    await runReview(CONFIGS.D, SAMPLE_MR_CASE, second, { auditDir });

    expect(second.capturedRequests).toEqual(first.capturedRequests);
  });

  it("turns a lazy repository failure into a bounded, audited tool error without failing the run", async () => {
    const fake = FakeLlmClient.fromResponses(configDScript());
    const result = await runReview(
      CONFIGS.D,
      { ...SAMPLE_MR_CASE, repoPath: "Z:/definitely/not/a/repo" },
      fake,
      { auditDir },
    );

    expect(result.rounds).toBe(1);
    expect(result.toolCalls).toBe(1);
    expect(result.audit.toolCallLog[0]?.resultSummary).toMatch(/^ERROR: failed to list Java files/);
    expect(result.findings).toHaveLength(1);
  });

  it("still honors explicit tool overrides (test seam) without auto-mounting", async () => {
    const fake = FakeLlmClient.fromResponses(configDScript());
    const result = await runReview(CONFIGS.D, SAMPLE_MR_CASE, fake, {
      auditDir,
      tools: [{ name: "review.get_symbol", description: "stub", parametersJson: '{"type":"object"}' }],
      toolExecutor: { execute: async () => "stub result" },
    });

    for (const request of result.audit.requests) {
      expect(request.tools).toEqual([
        { name: "review.get_symbol", description: "stub", parametersJson: '{"type":"object"}' },
      ]);
    }
    expect(result.audit.toolCallLog[0]?.resultSummary).toBe("stub result");
  });
});
