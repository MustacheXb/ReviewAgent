import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReviewConfig } from "../src/contracts/config.js";
import type { ToolCall, ToolSchema } from "../src/contracts/llm-client.js";
import { FakeLlmClient } from "../src/fake/fake-llm-client.js";
import { MAX_ROUNDS, MAX_TOOL_CALLS } from "../src/loop/constants.js";
import { runReview } from "../src/run/run-review.js";
import { CONFIGS } from "../src/contracts/config.js";
import { SAMPLE_MR_CASE } from "./fixtures/sample-mr-case.js";
import { reply, toolCallReply } from "./helpers/llm-script.js";

/** 循环级测试配置：挂工具（结构合法的 ReviewConfig，非 CONFIGS 五者之一） */
const TOOLS_ENABLED_CONFIG: ReviewConfig = {
  configId: "C",
  toolsEnabled: true,
  prefetch: false,
  fullRepo: false,
  stablePrefix: false,
  ledger: false,
};

const STUB_TOOL_SCHEMA: ToolSchema = {
  name: "review.get_symbol",
  description: "Get a symbol definition",
  parametersJson: '{"type":"object","properties":{},"required":[]}',
};

const toolCall = (n: number): ToolCall => ({
  id: `call-${n}`,
  name: "review.get_symbol",
  argumentsJson: "{}",
});

let auditDir: string;

beforeAll(async () => {
  auditDir = await mkdtemp(path.join(tmpdir(), "review-agent-bounds-"));
});

afterAll(async () => {
  await rm(auditDir, { recursive: true, force: true });
});

describe("loop hard bounds", () => {
  it("truncates a never-completing review at max_rounds = 5", async () => {
    const neverComplete = reply(JSON.stringify({ verdicts: [], complete: false }));
    const fake = new FakeLlmClient([], { fallback: { kind: "reply", response: neverComplete } });

    const result = await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, { auditDir });

    expect(result.rounds).toBe(MAX_ROUNDS);
    expect(result.rounds).toBeLessThanOrEqual(5);
    expect(result.audit.truncated).toBe(true);
    expect(result.audit.truncationReasons).toContain("MAX_ROUNDS_REACHED");
    // 5 轮 × 6 阶段 = 30 次请求，被硬上界钉死
    expect(result.audit.requests).toHaveLength(MAX_ROUNDS * 6);
    expect(result.audit.phaseLog).toHaveLength(MAX_ROUNDS * 6);
    expect(result.findings).toEqual([]);
  });

  it("truncates infinite tool calls at max_tool_calls = 6 (global budget)", async () => {
    const executed: ToolCall[] = [];
    const executor = {
      execute: async (call: ToolCall): Promise<string> => {
        executed.push(call);
        return `stub result for ${call.name}`;
      },
    };
    const infiniteToolCalls = toolCallReply([toolCall(1), toolCall(2)]);
    const fake = new FakeLlmClient([], { fallback: { kind: "reply", response: infiniteToolCalls } });

    const result = await runReview(TOOLS_ENABLED_CONFIG, SAMPLE_MR_CASE, fake, {
      auditDir,
      tools: [STUB_TOOL_SCHEMA],
      toolExecutor: executor,
    });

    expect(result.toolCalls).toBe(MAX_TOOL_CALLS);
    expect(result.toolCalls).toBeLessThanOrEqual(6);
    expect(executed).toHaveLength(MAX_TOOL_CALLS);
    expect(result.audit.truncated).toBe(true);
    expect(result.audit.truncationReasons).toContain("TOOL_BUDGET_EXHAUSTED");
    expect(result.audit.truncationReasons).toContain("MAX_ROUNDS_REACHED");
    // 每个请求都挂工具 schema；执行的 6 次全部留痕
    for (const request of result.audit.requests) {
      expect(request.tools).toEqual([STUB_TOOL_SCHEMA]);
    }
    const executedRecords = result.audit.toolCallLog.filter(
      (record) => !record.resultSummary.startsWith("SKIPPED:"),
    );
    expect(executedRecords).toHaveLength(MAX_TOOL_CALLS);
    expect(executedRecords.every((record) => record.resultSummary === "stub result for review.get_symbol")).toBe(true);
  });

  it("skips overflow tool calls beyond the budget within a single reply and still completes the run", async () => {
    const candidates = {
      candidates: [
        {
          id: "F001",
          severity: "P2",
          category: "CORRECTNESS",
          file: "src/main/java/com/example/math/MathUtils.java",
          line: 20,
          title: "Sample candidate",
          description: "Sample description for the budget test.",
          evidence: ["Diff line 20 shows the changed loop bound"],
          rule: "CORRECTNESS-001",
          confidence: 0.8,
        },
      ],
    };
    const script = [
      toolCallReply([1, 2, 3, 4, 5, 6, 7].map(toolCall)),
      reply("{}"),
      reply("{}"),
      reply("{}"),
      reply("{}"),
      reply(JSON.stringify(candidates)),
      reply(
        JSON.stringify({
          verdicts: [{ id: "F001", pass: true, reason: "evidence is concrete" }],
          complete: true,
        }),
      ),
    ];
    const fake = FakeLlmClient.fromResponses(script);

    const result = await runReview(TOOLS_ENABLED_CONFIG, SAMPLE_MR_CASE, fake, {
      auditDir,
      tools: [STUB_TOOL_SCHEMA],
      toolExecutor: { execute: async () => "ok" },
    });

    expect(result.toolCalls).toBe(MAX_TOOL_CALLS);
    expect(result.rounds).toBe(1);
    expect(result.audit.truncated).toBe(false);
    expect(result.audit.truncationReasons).toEqual(["TOOL_BUDGET_EXHAUSTED"]);
    expect(result.audit.toolCallLog).toHaveLength(7);
    expect(result.audit.toolCallLog.filter((record) => record.resultSummary === "ok")).toHaveLength(6);
    expect(result.audit.toolCallLog.filter((record) => record.resultSummary.startsWith("SKIPPED:"))).toHaveLength(1);
    // 工具结果以 tool 角色消息回填（append-only）
    const toolMessages = result.audit.requests[1]?.messages.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(6);
    expect(result.findings).toHaveLength(1);
  });

  it("records executor failures and still counts them against the budget", async () => {
    const script = [
      toolCallReply([toolCall(1)]),
      reply("{}"),
      reply("{}"),
      reply("{}"),
      reply("{}"),
      reply('{"candidates": []}'),
      reply('{"verdicts": [], "complete": true}'),
    ];
    const fake = FakeLlmClient.fromResponses(script);

    const result = await runReview(TOOLS_ENABLED_CONFIG, SAMPLE_MR_CASE, fake, {
      auditDir,
      tools: [STUB_TOOL_SCHEMA],
      toolExecutor: {
        execute: async () => {
          throw new Error("tool exploded");
        },
      },
    });

    expect(result.toolCalls).toBe(1);
    expect(result.audit.toolCallLog[0]?.resultSummary).toBe("ERROR: tool exploded");
    expect(result.rounds).toBe(1);
    expect(result.audit.truncated).toBe(false);
  });

  it("ignores tool calls from the model when tools are disabled (config A), keeping toolCalls = 0", async () => {
    const misbehavingReply = toolCallReply([toolCall(1)]);
    const fake = new FakeLlmClient([], { fallback: { kind: "reply", response: misbehavingReply } });
    let executorCalls = 0;

    const result = await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, {
      auditDir,
      tools: [STUB_TOOL_SCHEMA],
      toolExecutor: {
        execute: async () => {
          executorCalls++;
          return "should never run";
        },
      },
    });

    expect(executorCalls).toBe(0);
    expect(result.toolCalls).toBe(0);
    // 5 轮 × 6 阶段，每次回复的 1 个工具调用全部被跳过并留痕
    expect(result.audit.toolCallLog).toHaveLength(MAX_ROUNDS * 6);
    expect(
      result.audit.toolCallLog.every((record) => record.resultSummary.startsWith("SKIPPED: tools are not enabled")),
    ).toBe(true);
    for (const request of result.audit.requests) {
      expect(request.tools).toEqual([]);
    }
  });

  it("stops a run whose completion lands exactly on the last round without truncation", async () => {
    const completeFalse = reply('{"verdicts": [], "complete": false}');
    const completeTrue = reply('{"verdicts": [], "complete": true}');
    // 前 4 轮全部不完成（24 个回复）+ 第 5 轮前 5 个阶段不完成 + 第 5 轮验证阶段完成
    const steps = [
      ...Array.from({ length: MAX_ROUNDS * 6 - 1 }, () => ({ kind: "reply" as const, response: completeFalse })),
      { kind: "reply" as const, response: completeTrue },
    ];
    const fake = new FakeLlmClient(steps);

    const result = await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, { auditDir });

    expect(result.rounds).toBe(MAX_ROUNDS);
    expect(result.audit.truncated).toBe(false);
    expect(result.audit.truncationReasons).toEqual([]);
    expect(result.audit.requests).toHaveLength(MAX_ROUNDS * 6);
  });

  it("carries over the global tool budget across phases (not per-phase)", async () => {
    // 阶段 1 用掉 3 次、阶段 2 用掉 2 次、阶段 3 用掉 1 次 → 第 4 次请求起预算归零
    const manyCalls = (count: number) => toolCallReply(Array.from({ length: count }, (_, i) => toolCall(i + 1)));
    const script = [
      manyCalls(3), // phase 1, call 1
      reply("{}"), // phase 1 final
      manyCalls(2), // phase 2, call 1
      reply("{}"), // phase 2 final
      manyCalls(2), // phase 3, call 1 → 只执行 1 次，1 次溢出跳过
      reply("{}"), // phase 3 final
      reply("{}"), // phase 4
      reply('{"candidates": []}'), // phase 5
      reply('{"verdicts": [], "complete": true}'), // phase 6
    ];
    const fake = FakeLlmClient.fromResponses(script);

    const result = await runReview(TOOLS_ENABLED_CONFIG, SAMPLE_MR_CASE, fake, {
      auditDir,
      tools: [STUB_TOOL_SCHEMA],
      toolExecutor: { execute: async () => "ok" },
    });

    expect(result.toolCalls).toBe(MAX_TOOL_CALLS);
    expect(result.audit.truncationReasons).toContain("TOOL_BUDGET_EXHAUSTED");
    expect(result.rounds).toBe(1);
    expect(result.audit.truncated).toBe(false);
  });
});
