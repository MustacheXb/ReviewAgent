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
 * 主 seam 断言（fake LLM 捕获的请求与 RunResult 审计）：
 * - 检索四件套在 config E（主力系统形态）端到端走通（调用 → 结果回注 → 续跑）；
 * - 七工具 schema 字节一致挂载于 C/D/E（A/B 仍零工具，见 config C 测试的回归块）；
 * - POC1 知识语料经 options.knowledge 静态注入，驱动 search_rule / search_history；
 * - T07 Context Ledger：重复读取返回 "Already loaded: ctx#NNN" 引用而非原文；
 *   E 与 D 的请求差异仅来自 Ledger（同 Zone A、同工具、同消息骨架）；
 *   登记快照进 audit.ledger（loaded_files/ranges/symbols/evidence 四类留痕）。
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

/** 六阶段脚本：Context Retrieval 阶段先调用工具，收到结果后续跑并完成 */
function configEScript(call: ToolCall): readonly LlmResponse[] {
  return configEScriptWithCalls([call]);
}

/** 六阶段脚本：Context Retrieval 阶段一次发多笔工具调用（T07：同回合内可含重复读取） */
function configEScriptWithCalls(calls: readonly ToolCall[]): readonly LlmResponse[] {
  return [
    reply(JSON.stringify({ summary: "The MR changes the loop bound of MathUtils.sumFirst." })),
    reply(JSON.stringify({ riskClass: "Medium", reason: "Core arithmetic logic changes." })),
    reply(JSON.stringify({ neededContext: ["Impact of the loop bound change"], reason: "Impact analysis." })),
    toolCallReply([...calls]),
    reply(JSON.stringify({ notes: "The retrieval tools returned the requested context." })),
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

describe("runReview — config E Context Ledger (T07: tool-result dedup at the main seam)", () => {
  const MATH_UTILS = "src/main/java/com/example/math/MathUtils.java";
  const RANGE_READ: ToolCall = {
    id: "call-1",
    name: "review.get_file",
    argumentsJson: `{"path":"${MATH_UTILS}","startLine":15,"endLine":22}`,
  };
  const RANGE_READ_REPEAT: ToolCall = { ...RANGE_READ, id: "call-2" };
  const RANGE_REFERENCE = `Already loaded: ctx#001 (review.get_file ${MATH_UTILS}:15-22)`;

  it("returns a reference instead of the original content when the LLM repeats an identical read", async () => {
    const fake = FakeLlmClient.fromResponses(configEScriptWithCalls([RANGE_READ, RANGE_READ_REPEAT]));
    const result = await runReview(CONFIGS.E, SAMPLE_MR_CASE, fake, { auditDir });

    expect(result.toolCalls).toBe(2);
    expect(result.audit.toolCallLog[0]?.resultSummary).toContain("Lines 15-22 of 25");
    expect(result.audit.toolCallLog[0]?.resultSummary).toContain("18 |     public static int sumFirst(int[] values, int count) {");
    expect(result.audit.toolCallLog[1]?.resultSummary).toBe(RANGE_REFERENCE);

    // 两条工具结果均回注（Zone C append-only）：第一条原文 + 第二条引用
    const toolMessages = result.audit.requests[4]?.messages.filter((message) => message.role === "tool") ?? [];
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]?.toolCallId).toBe("call-1");
    expect(toolMessages[0]?.content).toContain("18 |     public static int sumFirst(int[] values, int count) {");
    expect(toolMessages[1]?.toolCallId).toBe("call-2");
    expect(toolMessages[1]?.content).toBe(RANGE_REFERENCE);
  });

  it("registers file / range / symbol / evidence reads and answers repeats with references", async () => {
    const calls: readonly ToolCall[] = [
      { id: "call-1", name: "review.get_diff", argumentsJson: "{}" },
      { id: "call-2", name: "review.get_file", argumentsJson: `{"path":"${MATH_UTILS}"}` },
      { id: "call-3", name: "review.get_file", argumentsJson: `{"path":"${MATH_UTILS}","startLine":15,"endLine":22}` },
      { id: "call-4", name: "review.get_symbol", argumentsJson: '{"symbol":"sumFirst"}' },
      { id: "call-5", name: "review.get_symbol", argumentsJson: '{"symbol":"sumFirst"}' },
      { id: "call-6", name: "review.get_diff", argumentsJson: "{}" },
    ];
    const fake = FakeLlmClient.fromResponses(configEScriptWithCalls(calls));
    const result = await runReview(CONFIGS.E, SAMPLE_MR_CASE, fake, { auditDir });

    // 6 笔调用全预算内（被去重的调用同样计入 max_tool_calls）
    expect(result.toolCalls).toBe(6);
    expect(result.audit.toolCallLog).toHaveLength(6);
    expect(result.audit.toolCallLog[4]?.resultSummary).toBe('Already loaded: ctx#004 (review.get_symbol "sumFirst")');
    expect(result.audit.toolCallLog[5]?.resultSummary).toBe("Already loaded: ctx#001 (review.get_diff)");

    // 登记快照：四类登记（evidence/file/range/symbol）按调用顺序编号
    expect(result.audit.ledger).toEqual([
      { id: "ctx#001", kind: "evidence", description: "review.get_diff" },
      { id: "ctx#002", kind: "file", description: `review.get_file ${MATH_UTILS}` },
      { id: "ctx#003", kind: "range", description: `review.get_file ${MATH_UTILS}:15-22` },
      { id: "ctx#004", kind: "symbol", description: 'review.get_symbol "sumFirst"' },
    ]);
  });

  it("differs from config D only in the deduplicated tool result (same Zone A, same message skeleton)", async () => {
    const fakeD = FakeLlmClient.fromResponses(configEScriptWithCalls([RANGE_READ, RANGE_READ_REPEAT]));
    const fakeE = FakeLlmClient.fromResponses(configEScriptWithCalls([RANGE_READ, RANGE_READ_REPEAT]));
    const resultD = await runReview(CONFIGS.D, SAMPLE_MR_CASE, fakeD, { auditDir });
    const resultE = await runReview(CONFIGS.E, SAMPLE_MR_CASE, fakeE, { auditDir });

    // D 无 Ledger：两次重复读取各得原文；E：第二次得引用
    expect(resultD.audit.toolCallLog[0]?.resultSummary).toBe(resultD.audit.toolCallLog[1]?.resultSummary);
    expect(resultD.audit.toolCallLog[1]?.resultSummary).toContain("Lines 15-22 of 25");
    expect(resultE.audit.toolCallLog[1]?.resultSummary).toBe(RANGE_REFERENCE);
    expect(resultD.audit.ledger).toBeUndefined();

    // 逐请求对比：Zone A（system + 工具 schema）逐字节一致；差异只有被去重的工具结果消息
    const requestsD = resultD.audit.requests;
    const requestsE = resultE.audit.requests;
    expect(requestsE).toHaveLength(requestsD.length);
    for (let i = 0; i < requestsD.length; i++) {
      const requestD = requestsD[i];
      const requestE = requestsE[i];
      if (requestD === undefined || requestE === undefined) {
        throw new Error(`missing captured request at index ${i}`);
      }
      expect(requestE.messages).toHaveLength(requestD.messages.length);
      expect(requestE.messages[0]?.content).toBe(requestD.messages[0]?.content);
      expect(JSON.stringify(requestE.tools)).toBe(JSON.stringify(requestD.tools));

      const diffIndexes: number[] = [];
      for (let m = 0; m < requestD.messages.length; m++) {
        if (JSON.stringify(requestD.messages[m]) !== JSON.stringify(requestE.messages[m])) {
          diffIndexes.push(m);
        }
      }
      if (i <= 3) {
        expect(diffIndexes).toEqual([]);
      } else {
        expect(diffIndexes).toHaveLength(1);
        const messageD = requestD.messages[diffIndexes[0] ?? 0];
        const messageE = requestE.messages[diffIndexes[0] ?? 0];
        expect(messageD?.role).toBe("tool");
        expect(messageE?.role).toBe("tool");
        expect(messageD?.content).toContain("18 |     public static int sumFirst(int[] values, int count) {");
        expect(messageE?.content).toBe(RANGE_REFERENCE);
      }
    }
  });

  it("keeps Zone A byte-stable and Zone C append-only while the ledger is deduplicating", async () => {
    const fake = FakeLlmClient.fromResponses(configEScriptWithCalls([RANGE_READ, RANGE_READ_REPEAT]));
    const result = await runReview(CONFIGS.E, SAMPLE_MR_CASE, fake, { auditDir });

    const firstTools = JSON.stringify(result.audit.requests[0]?.tools);
    const requests = result.audit.requests;
    for (const request of requests) {
      expect(request.messages[0]?.role).toBe("system");
      expect(request.messages[0]?.content).toBe(SYSTEM_PROMPT);
      expect(JSON.stringify(request.tools)).toBe(firstTools);
    }
    for (let i = 0; i + 1 < requests.length; i++) {
      const earlier = requests[i]?.messages ?? [];
      const later = requests[i + 1]?.messages ?? [];
      expect(earlier.length).toBeLessThan(later.length);
      expect(later.slice(0, earlier.length)).toEqual(earlier);
    }
  });

  it("starts every run from an empty ledger: ids restart and request bytes reproduce", async () => {
    const first = FakeLlmClient.fromResponses(configEScriptWithCalls([RANGE_READ, RANGE_READ_REPEAT]));
    const second = FakeLlmClient.fromResponses(configEScriptWithCalls([RANGE_READ, RANGE_READ_REPEAT]));
    const firstResult = await runReview(CONFIGS.E, SAMPLE_MR_CASE, first, { auditDir });
    const secondResult = await runReview(CONFIGS.E, SAMPLE_MR_CASE, second, { auditDir });

    // 两个 run 各自从 ctx#001 起（run 私有，互不影响），请求字节完全复现
    expect(secondResult.audit.toolCallLog[1]?.resultSummary).toBe(RANGE_REFERENCE);
    expect(secondResult.audit.ledger?.[0]?.id).toBe("ctx#001");
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
