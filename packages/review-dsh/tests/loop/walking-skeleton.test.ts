import { Context } from "@deepseek-ai/cordis";
import type { Message } from "@deepseek-ai/dsh-llm";
import { describe, expect, it } from "vitest";

import { buildInitialUserMessage, SYSTEM_PROMPT } from "../../../../src/loop/messages.js";
import { PHASE_INSTRUCTIONS } from "../../../../src/loop/phases.js";
import type { FakeLlmScriptStep } from "../../src/llm/fake-adapter.js";
import type { MrInput } from "../../src/plugins/review-context.js";
import { mount } from "../helpers/mount-profile.js";

function textOf(message: Message): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
}

/** 冻结 harness 的 MR intro 字节（独立真源：不重算，直接对齐薄 harness 输出） */
function frozenMrIntroText(input: MrInput): string {
  const message = buildInitialUserMessage({
    caseId: input.caseId,
    repoPath: "",
    diff: input.diff,
    issueDescription: input.issueDescription,
    truth: null,
    labels: { source: "test", riskClass: "Low", allowedConfigs: [] },
  });
  return message.content;
}

const INPUT: MrInput = {
  caseId: "VUL4J-38",
  issueDescription: "Vulnerability fix: URL encoding",
  diff: "--- a/src/main/java/Example.java\n+++ b/src/main/java/Example.java\n@@ -1,1 +1,1 @@\n-old\n+new",
};

const CANDIDATE_F001 = {
  id: "F001",
  severity: "P2",
  category: "CORRECTNESS",
  file: "src/main/java/Example.java",
  line: 42,
  title: "Incorrect URL encoding of query parameters",
  description: "The change encodes the joined query string instead of individual parameter values, breaking clients that send reserved characters.",
  evidence: ["Example.java:42 - URLEncoder.encode applied to the joined query string"],
  rule: "CORRECTNESS-001",
  confidence: 0.9,
};

function configAScript(): readonly FakeLlmScriptStep[] {
  return [
    { kind: "reply", content: '{"summary":"The change replaces manual URL encoding with a utility call."}', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 } },
    { kind: "reply", content: '{"riskClass":"Medium","reason":"business logic change"}', usage: { inputTokens: 101, outputTokens: 11 } },
    { kind: "reply", content: '{"neededContext":[],"reason":"diff is self-contained"}', usage: { inputTokens: 102, outputTokens: 12 } },
    { kind: "reply", content: '{"notes":"No further context can be retrieved in this configuration."}', usage: { inputTokens: 103, outputTokens: 13 } },
    { kind: "reply", content: JSON.stringify({ candidates: [CANDIDATE_F001] }), usage: { inputTokens: 104, outputTokens: 14 } },
    { kind: "reply", content: '{"verdicts":[{"id":"F001","pass":true,"reason":"evidence supports the finding"}],"complete":true}', usage: { inputTokens: 105, outputTokens: 15 } },
  ];
}

describe("walking skeleton：config A 六阶段 × 1 轮（策略驱动器 + FakeLlmAdapter 脚本）", () => {
  it("一次检视会话：六次请求、阶段轨迹、Finding 过闸与 embryonic POC1 审计", async () => {
    const { ctx, adapter } = await mount(configAScript());

    const result = await ctx.reviewRuntime.run(INPUT);

    // —— 请求序列：6 次模型调用（一阶段一 turn，config A 零工具）
    const requests = adapter.capturedRequests;
    expect(requests).toHaveLength(6);
    expect(requests.map((request) => request.provider)).toEqual(Array.from({ length: 6 }, () => "deepseek"));
    expect(requests.map((request) => request.model)).toEqual(Array.from({ length: 6 }, () => "deepseek-v4-flash"));
    expect(requests.every((request) => request.tools === undefined)).toBe(true);

    // —— 请求 1 布局（POC1 字节）：system(Zone A) + user(MR intro) + user(Phase 1)
    const first = requests[0];
    expect(first?.system).toBe(SYSTEM_PROMPT);
    expect(first?.messages.map((message) => message.role)).toEqual(["user", "user"]);
    expect(first?.messages[0] !== undefined ? textOf(first.messages[0]) : "").toBe(frozenMrIntroText(INPUT));
    expect(first?.messages[1] !== undefined ? textOf(first.messages[1]) : "").toBe(PHASE_INSTRUCTIONS["Change Understanding"]);

    // —— 请求 2：历史追加（assistant 回复 1 + Phase 2 指令）
    const second = requests[1];
    expect(second?.messages.map((message) => message.role)).toEqual(["user", "user", "assistant", "user"]);
    expect(second?.messages[3] !== undefined ? textOf(second.messages[3]) : "").toBe(PHASE_INSTRUCTIONS["Risk Classification"]);

    // —— 请求 6：Phase 6 指令收尾
    const last = requests[5];
    expect(last?.messages.map((message) => message.role)).toEqual([
      "user", "user", "assistant",
      "user", "assistant",
      "user", "assistant",
      "user", "assistant",
      "user", "assistant",
      "user",
    ]);
    expect(last?.messages[11] !== undefined ? textOf(last.messages[11]) : "").toBe(PHASE_INSTRUCTIONS["Evidence Verification"]);

    // —— 阶段轨迹（round 1 × 6 阶段，每阶段 1 次请求）
    expect(result.phaseLog).toEqual([
      { round: 1, phase: "Change Understanding", requestCount: 1 },
      { round: 1, phase: "Risk Classification", requestCount: 1 },
      { round: 1, phase: "Context Decision", requestCount: 1 },
      { round: 1, phase: "Context Retrieval", requestCount: 1 },
      { round: 1, phase: "Deep Reasoning", requestCount: 1 },
      { round: 1, phase: "Evidence Verification", requestCount: 1 },
    ]);

    // —— Finding 过闸产出
    expect(result.findings).toEqual([CANDIDATE_F001]);

    // —— embryonic POC1 审计
    const audit = result.audit;
    expect(audit.caseId).toBe("VUL4J-38");
    expect(audit.configId).toBe("A");
    expect(audit.model).toBe("deepseek-v4-flash");
    expect(audit.effort).toBe("default");
    expect(audit.rounds).toBe(1);
    expect(audit.toolCalls).toBe(0);
    expect(audit.truncated).toBe(false);
    expect(audit.truncationReasons).toEqual([]);
    expect(audit.runId).toMatch(/^\d{8}T\d{6}\.\d{3}-A-VUL4J-38$/);
    expect(audit.usage).toEqual({ inputTokens: 615, outputTokens: 75, cacheReadTokens: 50 });
    expect(audit.rejections).toEqual([]);
    expect(audit.toolCallLog).toEqual([]);
    expect(audit.requests).toHaveLength(6);
    // 审计请求 0 = POC1 形态：system 落 messages[0]，工具空数组
    expect(audit.requests[0]).toEqual({
      model: "deepseek-v4-flash",
      effort: "default",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: frozenMrIntroText(INPUT) },
        { role: "user", content: PHASE_INSTRUCTIONS["Change Understanding"] },
      ],
      tools: [],
    });
  });

  it("证据门拦截：候选缺 verdict → VERIFICATION_FAILED 留痕，不出 Finding", async () => {
    const script: readonly FakeLlmScriptStep[] = [
      ...configAScript().slice(0, 4),
      { kind: "reply", content: JSON.stringify({ candidates: [CANDIDATE_F001] }) },
      { kind: "reply", content: '{"verdicts":[],"complete":true}' },
    ];
    const { ctx } = await mount(script);

    const result = await ctx.reviewRuntime.run(INPUT);

    expect(result.findings).toEqual([]);
    expect(result.audit.rejections).toEqual([
      {
        candidateId: "F001",
        stage: "VERIFICATION_FAILED",
        reason: "no verification verdict for candidate",
      },
    ]);
  });
});
