/**
 * #20 集成层验收：挂载 profile 真跑工具链（FakeLlmAdapter 脚本驱动）。
 *
 * 四条锁线：
 * - 请求挂载：requests[0].tools = 7 个 review.* schema（REVIEW_TOOL_ORDER 顺序，
 *   parameters 字节 = 冻结注册表 canonical 串）；config A 回归：零工具不炸组装。
 * - 执行接线：模型 tool_call → DSH ToolRuntime → POC1 工具箱 executor → 工具结果
 *   以 POC1 字节进入下一请求（role:tool + tool_call_id）。
 * - Context Ledger：同参重复调用第二份结果为 "Already loaded: ctx#001" 引用；
 *   审计 ledger 快照留痕。
 * - max_tool_calls：第 7 次调用被守卫拒绝，"Error: tool call budget exhausted"
 *   进入下一请求（事件流可验证）；toolCalls / toolCallLog 审计账目齐全。
 */

import { describe, expect, it } from "vitest";

import { REVIEW_TOOL_ORDER } from "../../../../src/tools/registry.js";
import { buildReviewReadTools, buildReviewToolkit } from "../../../../src/tools/toolkit.js";
import { SAMPLE_MR_CASE } from "../../../../tests/fixtures/sample-mr-case.js";
import type { FakeLlmScriptStep } from "../../src/llm/fake-adapter.js";
import type { MrInput } from "../../src/plugins/review-context.js";
import { mount } from "../helpers/mount-profile.js";

const MATH_UTILS = "src/main/java/com/example/math/MathUtils.java";

const TOOLS_INPUT: MrInput = {
  caseId: "KERNEL-TOOLS-1",
  issueDescription: SAMPLE_MR_CASE.issueDescription,
  diff: SAMPLE_MR_CASE.diff,
  repoPath: SAMPLE_MR_CASE.repoPath,
};

/**
 * POC1 oracle：每次调用建独立工具箱（与被测 run 同 fixture 同 diff，从空
 * Ledger 出发取首次读取结果）——跨用例零共享状态，断言语义与执行顺序无关。
 */
async function oracleResult(name: string, argumentsJson: string): Promise<string> {
  const toolkit = buildReviewToolkit({
    repoPath: SAMPLE_MR_CASE.repoPath,
    diff: SAMPLE_MR_CASE.diff,
  });
  return toolkit.executor.execute({ id: "call-oracle", name, argumentsJson });
}

/** 六阶段前三个 JSON 回复 + 后两个（Deep Reasoning / Evidence Verification） */
const PHASE_1_TO_3: readonly FakeLlmScriptStep[] = [
  { kind: "reply", content: '{"summary":"Loop boundary change in MathUtils.sumFirst."}' },
  { kind: "reply", content: '{"riskClass":"High","reason":"array indexing logic"}' },
  { kind: "reply", content: '{"neededContext":["sumFirst signature"],"reason":"verify loop bounds"}' },
];
const PHASE_5_TO_6: readonly FakeLlmScriptStep[] = [
  { kind: "reply", content: '{"candidates":[]}' },
  { kind: "reply", content: '{"verdicts":[],"complete":true}' },
];

const NOTES_REPLY: FakeLlmScriptStep = {
  kind: "reply",
  content: '{"notes":"sumFirst source retrieved."}',
};

describe("kernel 工具挂载：toolsEnabled + ledger 全链路", () => {
  it("工具 schema 挂载 + 单次调用：结果字节进入下一请求，审计账目成形", async () => {
    const getFileArgs = `{"path":"${MATH_UTILS}","startLine":1,"endLine":40}`;
    const script: readonly FakeLlmScriptStep[] = [
      ...PHASE_1_TO_3,
      {
        kind: "reply",
        content: "",
        toolCalls: [{ id: "call-1", name: "review.get_file", arguments: getFileArgs }],
      },
      NOTES_REPLY,
      ...PHASE_5_TO_6,
    ];
    const { ctx } = await mount(script, { policy: { toolsEnabled: true, ledger: true } });

    const result = await ctx.reviewRuntime.run(TOOLS_INPUT);
    const audit = result.audit;

    // —— 请求挂载：7 次模型调用（Phase 4 内 tool 循环多一次）
    expect(audit.requests).toHaveLength(7);

    // —— tools：7 个 schema、REVIEW_TOOL_ORDER 顺序、parameters = 冻结 canonical 字节
    const registered = buildReviewReadTools();
    expect(audit.requests[0]?.tools.map((tool) => tool.name)).toEqual([...REVIEW_TOOL_ORDER]);
    for (const [toolIndex, tool] of (audit.requests[0]?.tools ?? []).entries()) {
      expect(tool.description).toBe(registered[toolIndex]?.description);
      expect(JSON.stringify(tool.parameters)).toBe(registered[toolIndex]?.parametersJson);
    }
    // 请求 2 起装配确定性：schema 列表逐请求稳定（Zone A 前缀纪律）
    expect(audit.requests[4]?.tools.map((tool) => tool.name)).toEqual([...REVIEW_TOOL_ORDER]);

    // —— 执行接线：工具结果（POC1 字节）落 requests[4] 尾部两条消息
    const expected = await oracleResult("review.get_file", getFileArgs);
    const postTool = audit.requests[4]?.messages;
    const assistantToolCall = postTool?.at(-2);
    expect(assistantToolCall).toEqual({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-1", name: "review.get_file", argumentsJson: getFileArgs }],
    });
    expect(postTool?.at(-1)).toEqual({
      role: "tool",
      content: expected,
      toolCallId: "call-1",
    });

    // —— 审计账目：toolCalls 计数、toolCallLog（POC1 ToolCallRecord 形态）、ledger 快照
    expect(audit.toolCalls).toBe(1);
    expect(audit.toolCallLog).toEqual([
      { name: "review.get_file", argumentsJson: getFileArgs, resultSummary: expected },
    ]);
    expect(audit.ledger).toHaveLength(1);
    expect(audit.ledger?.[0]?.id).toBe("ctx#001");
    expect(audit.ledger?.[0]?.description).toContain(MATH_UTILS);

    // —— 阶段轨迹：Phase 4 两次请求（tool 循环），其余各一
    expect(audit.phaseLog[3]).toEqual({ round: 1, phase: "Context Retrieval", requestCount: 2 });
  });

  it("Ledger 去重：同一回复内两次同参调用，第二份结果为 ctx#001 引用", async () => {
    const getFileArgs = `{"path":"${MATH_UTILS}","startLine":1,"endLine":20}`;
    const script: readonly FakeLlmScriptStep[] = [
      ...PHASE_1_TO_3,
      {
        kind: "reply",
        content: "",
        toolCalls: [
          { id: "call-1", name: "review.get_file", arguments: getFileArgs },
          { id: "call-2", name: "review.get_file", arguments: getFileArgs },
        ],
      },
      NOTES_REPLY,
      ...PHASE_5_TO_6,
    ];
    const { ctx } = await mount(script, { policy: { toolsEnabled: true, ledger: true } });

    const result = await ctx.reviewRuntime.run(TOOLS_INPUT);
    const audit = result.audit;

    const toolMessages = (audit.requests[4]?.messages ?? []).filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(2);
    const first = await oracleResult("review.get_file", getFileArgs);
    expect(toolMessages[0]?.content).toBe(first);
    expect(toolMessages[1]?.content).toMatch(/^Already loaded: ctx#001 \(review\.get_file /);

    expect(audit.toolCallLog[1]?.resultSummary).toBe(toolMessages[1]?.content);
    expect(audit.ledger).toHaveLength(1);
  });

  it("max_tool_calls=6：第 7 次调用被守卫拒绝，拒绝理由进入下一请求", async () => {
    // 7 个互异入参（文件 25 行内的互异行区间 → Ledger 键互异，预算与去重解耦）
    const calls = Array.from({ length: 7 }, (_, index) => ({
      id: `call-${index + 1}`,
      name: "review.get_file",
      arguments: `{"path":"${MATH_UTILS}","startLine":${index * 3 + 1},"endLine":${index * 3 + 3}}`,
    }));
    const script: readonly FakeLlmScriptStep[] = [
      ...PHASE_1_TO_3,
      { kind: "reply", content: "", toolCalls: calls },
      NOTES_REPLY,
      ...PHASE_5_TO_6,
    ];
    const { ctx } = await mount(script, { policy: { toolsEnabled: true, ledger: true } });

    const result = await ctx.reviewRuntime.run(TOOLS_INPUT);
    const audit = result.audit;

    const toolMessages = (audit.requests[4]?.messages ?? []).filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(7);
    for (const [index, message] of toolMessages.entries()) {
      if (index < 6) {
        expect(message.content.startsWith("Error:")).toBe(false);
      } else {
        expect(message.content).toBe("Error: tool call budget exhausted");
      }
    }

    // —— 审计账目：尝试数 = 7（含被拒尝试），拒绝同样留痕
    expect(audit.toolCalls).toBe(7);
    expect(audit.toolCallLog).toHaveLength(7);
    expect(audit.toolCallLog[6]?.resultSummary).toBe("Error: tool call budget exhausted");
    // run 未被截断（DSH 形态：拒绝为工具错误结果，模型继续收尾 turn）
    expect(audit.truncated).toBe(false);
  });

  it("config A 回归：缺省政策零工具——tools 恒空数组，组装不因 toolOrder 校验失败", async () => {
    const script: readonly FakeLlmScriptStep[] = [
      ...PHASE_1_TO_3,
      { kind: "reply", content: '{"notes":"No further context can be retrieved in this configuration."}' },
      ...PHASE_5_TO_6,
    ];
    const { ctx } = await mount(script);

    const result = await ctx.reviewRuntime.run(TOOLS_INPUT);

    expect(result.audit.requests).toHaveLength(6);
    for (const request of result.audit.requests) {
      expect(request.tools).toEqual([]);
    }
    expect(result.audit.ledger).toBeUndefined();
    expect(result.audit.toolCallLog).toEqual([]);
  });
});
