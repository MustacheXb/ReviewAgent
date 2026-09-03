import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeLlmClient } from "../src/fake/fake-llm-client.js";
import { SYSTEM_PROMPT } from "../src/loop/messages.js";
import { runReview } from "../src/run/run-review.js";
import { CONFIGS } from "../src/contracts/config.js";
import type { KnowledgeEntry } from "../src/contracts/knowledge.js";
import type { LlmResponse, ToolCall } from "../src/contracts/llm-client.js";
import { REVIEW_TOOL_ORDER } from "../src/tools/registry.js";
import { buildReviewToolkit } from "../src/tools/toolkit.js";
import { SAMPLE_MR_CASE } from "./fixtures/sample-mr-case.js";
import { HAPPY_PATH_FINDING, HAPPY_PATH_RESPONSES } from "./helpers/happy-path-script.js";
import { reply, toolCallReply } from "./helpers/llm-script.js";

/**
 * 工单 #7 主 seam 断言（fake LLM 捕获的请求与 RunResult 审计）：
 * - 检索四件套在 config E（主力系统形态）端到端走通（调用 → 结果回注 → 续跑）；
 * - 七工具 schema 字节一致挂载于 C/D/E（A/B 仍零工具，见 config C 测试的回归块）；
 * - POC1 知识语料经 options.knowledge 静态注入，驱动 search_rule / search_history。
 *
 * 注：config E 的 Context Ledger 行为属工单 #8（T07），本文件只断言 T06 交付的
 * 工具挂载与检索语义，不预支 Ledger 断言。
 */

let auditDir: string;

beforeAll(async () => {
  auditDir = await mkdtemp(path.join(tmpdir(), "review-agent-config-e-"));
});

afterAll(async () => {
  await rm(auditDir, { recursive: true, force: true });
});

const RULES: readonly KnowledgeEntry[] = [
  {
    id: "R001",
    title: "Off-by-one loop bounds",
    text: "Prefer i < count over i <= count when summing the first count elements.",
  },
  {
    id: "R002",
    title: "Resource cleanup",
    text: "Always close streams in a finally block.",
  },
];

const HISTORY: readonly KnowledgeEntry[] = [
  {
    id: "H001",
    title: "Past off-by-one defect in MathUtils",
    text: "Historical defect: sumFirst read values[count] because the loop bound used <=.",
  },
];

/** 六阶段脚本：Context Retrieval 阶段先调用检索工具，收到结果后续跑并完成 */
function configEScript(call: ToolCall): readonly LlmResponse[] {
  return [
    reply(JSON.stringify({ summary: "The MR changes the loop bound of MathUtils.sumFirst." })),
    reply(JSON.stringify({ riskClass: "Medium", reason: "Core arithmetic logic changes." })),
    reply(JSON.stringify({ neededContext: ["Impact of the loop bound change"], reason: "Impact analysis." })),
    toolCallReply([call]),
    reply(JSON.stringify({ notes: "The retrieval tool returned the requested context." })),
    reply(JSON.stringify({ candidates: [HAPPY_PATH_FINDING] })),
    reply(
      JSON.stringify({
        verdicts: [{ id: "F001", pass: true, reason: "Evidence is concrete." }],
        complete: true,
      }),
    ),
  ];
}

describe("runReview — config E end-to-end (fake LLM, retrieval quartet at the main seam)", () => {
  it("completes a run with a scripted review.find_references call: call → result injection → continued run", async () => {
    const fake = FakeLlmClient.fromResponses(
      configEScript({ id: "call-1", name: "review.find_references", argumentsJson: '{"symbol":"sumFirst"}' }),
    );
    const result = await runReview(CONFIGS.E, SAMPLE_MR_CASE, fake, { auditDir });

    expect(result.configId).toBe("E");
    expect(result.rounds).toBe(1);
    expect(result.toolCalls).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.audit.requests).toHaveLength(7);

    const record = result.audit.toolCallLog[0];
    expect(record?.name).toBe("review.find_references");
    expect(record?.resultSummary).toContain(
      'References to "sumFirst" (name-level whole-word match, no type resolution): 2 match(es) across 2 file(s)',
    );
    expect(record?.resultSummary).toContain("[declaration] MathUtils.sumFirst");
    expect(record?.resultSummary).toContain("[usage] Calculator.total");
    expect(record?.resultSummary).not.toMatch(/^ERROR:/);

    // 结果回注：工具调用后的下一次请求含 assistant(toolCalls) + tool(result) 消息（Zone C append-only）
    const recallRequest = result.audit.requests[4];
    const toolMessages = recallRequest?.messages.filter((message) => message.role === "tool") ?? [];
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.toolCallId).toBe("call-1");
    expect(toolMessages[0]?.content).toContain("[usage] Calculator.total");
  });

  it("completes a run with a scripted review.get_call_chain call (1-2 hop name-level chain)", async () => {
    const fake = FakeLlmClient.fromResponses(
      configEScript({ id: "call-1", name: "review.get_call_chain", argumentsJson: '{"symbol":"sumFirst"}' }),
    );
    const result = await runReview(CONFIGS.E, SAMPLE_MR_CASE, fake, { auditDir });

    const record = result.audit.toolCallLog[0];
    expect(record?.name).toBe("review.get_call_chain");
    expect(record?.resultSummary).toContain(
      'Call chain for "sumFirst" (name-level, up to 2 hops, no type resolution): 1 method declaration(s) matched',
    );
    expect(record?.resultSummary).toContain("MathUtils.sumFirst - method at src/main/java/com/example/math/MathUtils.java:18");
    expect(record?.resultSummary).toContain('Callers of "total" (hop 2):');
    expect(record?.resultSummary).toContain("Main.main - src/main/java/com/example/math/Main.java:11");
    expect(record?.resultSummary).not.toMatch(/^ERROR:/);

    const toolMessage = result.audit.requests[4]?.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("Calculator.total - src/main/java/com/example/math/Calculator.java:12");
  });

  it("answers review.search_rule from the statically injected rule corpus", async () => {
    const fake = FakeLlmClient.fromResponses(
      configEScript({ id: "call-1", name: "review.search_rule", argumentsJson: '{"query":"off-by-one"}' }),
    );
    const result = await runReview(CONFIGS.E, SAMPLE_MR_CASE, fake, {
      auditDir,
      knowledge: { rules: RULES },
    });

    const record = result.audit.toolCallLog[0];
    expect(record?.name).toBe("review.search_rule");
    expect(record?.resultSummary).toContain(
      'Rule search "off-by-one" (case-insensitive substring): 1 of 2 rule(s) matched',
    );
    expect(record?.resultSummary).toContain("[R001] Off-by-one loop bounds");
    expect(record?.resultSummary).toContain("    Prefer i < count over i <= count when summing the first count elements.");
    expect(record?.resultSummary).not.toMatch(/^ERROR:/);
  });

  it("answers review.search_history from the statically injected history corpus", async () => {
    const fake = FakeLlmClient.fromResponses(
      configEScript({ id: "call-1", name: "review.search_history", argumentsJson: '{"query":"loop bound"}' }),
    );
    const result = await runReview(CONFIGS.E, SAMPLE_MR_CASE, fake, {
      auditDir,
      knowledge: { history: HISTORY },
    });

    const record = result.audit.toolCallLog[0];
    expect(record?.name).toBe("review.search_history");
    expect(record?.resultSummary).toContain(
      'History search "loop bound" (case-insensitive substring): 1 of 1 history record(s) matched',
    );
    expect(record?.resultSummary).toContain("[H001] Past off-by-one defect in MathUtils");
    expect(record?.resultSummary).not.toMatch(/^ERROR:/);
  });

  it("states the empty POC1 corpus explicitly when no knowledge is configured", async () => {
    const fake = FakeLlmClient.fromResponses(
      configEScript({ id: "call-1", name: "review.search_rule", argumentsJson: '{"query":"null"}' }),
    );
    const result = await runReview(CONFIGS.E, SAMPLE_MR_CASE, fake, { auditDir });

    const record = result.audit.toolCallLog[0];
    expect(record?.resultSummary).toBe(
      'Rule search "null" (case-insensitive substring): rule corpus is empty (0 entries configured for this run)',
    );
  });

  it("starts from the minimal context and keeps Zone A byte-stable within the run", async () => {
    const fake = FakeLlmClient.fromResponses(
      configEScript({ id: "call-1", name: "review.find_references", argumentsJson: '{"symbol":"sumFirst"}' }),
    );
    const result = await runReview(CONFIGS.E, SAMPLE_MR_CASE, fake, { auditDir });

    const firstTools = JSON.stringify(result.audit.requests[0]?.tools);
    for (const request of result.audit.requests) {
      expect(request.messages[0]?.role).toBe("system");
      expect(request.messages[0]?.content).toBe(SYSTEM_PROMPT);
      expect(request.messages[1]?.role).toBe("user");
      expect(request.messages[1]?.content).toContain("Unified diff:");
      expect(JSON.stringify(request.tools)).toBe(firstTools);
      const joined = request.messages.map((message) => message.content).join("\n");
      expect(joined).not.toContain("Repository context (Zone B)");
      expect(joined).not.toContain("Full repository context");
    }
    expect(result.audit.prefetch).toBeUndefined();
    expect(result.audit.fullRepo).toBeUndefined();
  });

  it("keeps Zone C append-only across requests (each request is a strict prefix of the next)", async () => {
    const fake = FakeLlmClient.fromResponses(
      configEScript({ id: "call-1", name: "review.get_call_chain", argumentsJson: '{"symbol":"sumFirst"}' }),
    );
    const result = await runReview(CONFIGS.E, SAMPLE_MR_CASE, fake, { auditDir });
    const requests = result.audit.requests;
    for (let i = 0; i + 1 < requests.length; i++) {
      const earlier = requests[i]?.messages ?? [];
      const later = requests[i + 1]?.messages ?? [];
      expect(earlier.length).toBeLessThan(later.length);
      expect(later.slice(0, earlier.length)).toEqual(earlier);
    }
  });

  it("reproduces the exact request bytes across two independent config E runs", async () => {
    const call: ToolCall = {
      id: "call-1",
      name: "review.find_references",
      argumentsJson: '{"symbol":"sumFirst"}',
    };
    const first = FakeLlmClient.fromResponses(configEScript(call));
    const second = FakeLlmClient.fromResponses(configEScript(call));
    await runReview(CONFIGS.E, SAMPLE_MR_CASE, first, { auditDir });
    await runReview(CONFIGS.E, SAMPLE_MR_CASE, second, { auditDir });

    expect(second.capturedRequests).toEqual(first.capturedRequests);
  });
});

describe("C/D/E mount the identical 7-tool registry schema (byte-stable Zone A)", () => {
  it("sends byte-identical tool schemas in every C, D and E request", async () => {
    const fakeC = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    const fakeD = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    const fakeE = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    await runReview(CONFIGS.C, SAMPLE_MR_CASE, fakeC, { auditDir });
    await runReview(CONFIGS.D, SAMPLE_MR_CASE, fakeD, { auditDir });
    await runReview(CONFIGS.E, SAMPLE_MR_CASE, fakeE, { auditDir });

    const toolkit = buildReviewToolkit({ repoPath: SAMPLE_MR_CASE.repoPath, diff: SAMPLE_MR_CASE.diff });
    expect(toolkit.tools.map((tool) => tool.name)).toEqual([...REVIEW_TOOL_ORDER]);
    const registryBytes = JSON.stringify(toolkit.tools);

    for (const fake of [fakeC, fakeD, fakeE]) {
      expect(fake.capturedRequests.length).toBeGreaterThan(0);
      for (const request of fake.capturedRequests) {
        expect(JSON.stringify(request.tools)).toBe(registryBytes);
        expect(request.tools.length).toBe(7);
      }
    }
  });
});
