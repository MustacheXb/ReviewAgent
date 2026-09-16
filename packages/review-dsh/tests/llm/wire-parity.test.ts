/**
 * #45 双包 wire parity（golden 钉死）：POC1 request-mapper 与 DSH wire
 * serializer 对同一逻辑请求产出相同字节。
 *
 * ADR-0008 实现决策：wire 序列化器留在各自包内（尊重 ADR-0006 的字节审计
 * 主张），以 parity 测试钉死一致——本文件即那道钉。画像表（review-llm
 * profileOf）是两侧的共同单源：thinking 策略 / completion 信封的分派在
 * 两包必须逐字节一致；漂移只能来自实现分叉，而那正是这里要变红暴露的事故。
 *
 * 逻辑请求按两侧各自的输入形状构造（LlmRequest vs GenerateOptions），
 * 对照面 = JSON.stringify 全 body（键序敏感是特性：两包共享冻结字段序
 * model → messages → [thinking → reasoning_effort] → [max_tokens] →
 * [tools → tool_choice] → stream）。deepseek 档用例同时是「DeepSeek 默认
 * 路径字节不变」在 DSH 侧的锚（root 侧绝对 golden 见
 * tests/deepseek/golden-bytes.test.ts，两者互为印证）。
 */

import { describe, expect, it } from "vitest";

import type { GenerateOptions, Message } from "@deepseek-ai/dsh-llm";
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from "@deepseek-ai/dsh-llm";

import type { LlmMessage, LlmRequest } from "../../../../src/contracts/llm-client.js";
import { buildChatCompletionsBody as poc1BuildChatCompletionsBody } from "../../../../src/deepseek/request-mapper.js";
import { toToolSchema } from "../../../../src/tools/registry.js";
import { buildReviewReadTools } from "../../../../src/tools/toolkit.js";
import { buildChatCompletionsBody as dshBuildChatCompletionsBody } from "../../src/llm/wire.js";

/** 逻辑轮次（两侧构造函数的共同输入；不直接绑定任何一侧的消息形状） */
type LogicalTurn =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "assistant-text"; readonly text: string }
  | { readonly kind: "assistant-tool-calls"; readonly calls: readonly { readonly id: string; readonly name: string; readonly arguments: string }[] }
  | { readonly kind: "tool-result"; readonly callId: string; readonly text: string };

interface ParityCase {
  readonly label: string;
  readonly model: string;
  readonly system: string;
  readonly turns: readonly LogicalTurn[];
  readonly withTools: boolean;
}

/** 循环中段形态（阶段 4 工具调用 → 工具结果 → 阶段 5 文本回复） */
const MID_LOOP_TURNS: readonly LogicalTurn[] = [
  { kind: "user", text: "Phase 4 of 6 - Context Retrieval." },
  {
    kind: "assistant-tool-calls",
    calls: [{ id: "call_1", name: "review.get_diff", arguments: "{}" }],
  },
  { kind: "tool-result", callId: "call_1", text: "--- a/src/main/java/Example.java\n+++ b/src/main/java/Example.java" },
  { kind: "assistant-text", text: '{"notes":"diff retrieved"}' },
  { kind: "user", text: "Phase 5 of 6 - Deep Reasoning." },
];

const CASES: readonly ParityCase[] = [
  {
    label: "deepseek-v4-flash 零工具双轮（默认路径字节锚）",
    model: "deepseek-v4-flash",
    system: "system prompt bytes",
    turns: [
      { kind: "user", text: "Merge request under review." },
      { kind: "user", text: "Phase 1 of 6 - Change Understanding." },
    ],
    withTools: false,
  },
  {
    label: "deepseek-v4-pro 零工具（消融档同 thinking 锁档、无信封）",
    model: "deepseek-v4-pro",
    system: "system prompt bytes",
    turns: [{ kind: "user", text: "q" }],
    withTools: false,
  },
  {
    label: "deepseek-v4-flash 带工具循环中段（默认路径字节锚）",
    model: "deepseek-v4-flash",
    system: "system prompt bytes",
    turns: MID_LOOP_TURNS,
    withTools: true,
  },
  {
    label: "glm-4.7 零工具（无 thinking 字段 + 32768 信封）",
    model: "glm-4.7",
    system: "system prompt bytes",
    turns: [
      { kind: "user", text: "Merge request under review." },
      { kind: "user", text: "Phase 1 of 6 - Change Understanding." },
    ],
    withTools: false,
  },
  {
    label: "glm-4.7 带工具循环中段（信封 + 工具面同刻序列化）",
    model: "glm-4.7",
    system: "system prompt bytes",
    turns: MID_LOOP_TURNS,
    withTools: true,
  },
  {
    label: "未知网关模型零工具（保守默认：无 thinking + 8192 信封）",
    model: "my-gateway-model",
    system: "system prompt bytes",
    turns: [{ kind: "user", text: "q" }],
    withTools: false,
  },
  {
    label: "qwen3.8-flash 带工具（火山网关目标形态，#47 冒烟对象）",
    model: "qwen3.8-flash",
    system: "system prompt bytes",
    turns: MID_LOOP_TURNS,
    withTools: true,
  },
];

/** 逻辑轮次 → POC1 LlmMessage（system 独立成首条消息） */
function toPoc1Message(turn: LogicalTurn): LlmMessage {
  if (turn.kind === "user") {
    return { role: "user", content: turn.text };
  }
  if (turn.kind === "assistant-text") {
    return { role: "assistant", content: turn.text };
  }
  if (turn.kind === "assistant-tool-calls") {
    return {
      role: "assistant",
      content: "",
      toolCalls: turn.calls.map((call) => ({ id: call.id, name: call.name, argumentsJson: call.arguments })),
    };
  }
  return { role: "tool", content: turn.text, toolCallId: turn.callId };
}

/** 逻辑轮次 → DSH Message（system 走 GenerateOptions 独立槽） */
function toDshMessage(turn: LogicalTurn, model: string): Message {
  if (turn.kind === "user") {
    return createUserMessage({ content: [{ type: "text", text: turn.text }], source: { kind: "user" } });
  }
  if (turn.kind === "assistant-text") {
    return createAssistantMessage({
      content: [{ type: "text", text: turn.text }],
      source: { provider: "deepseek", model },
    });
  }
  if (turn.kind === "assistant-tool-calls") {
    return createAssistantMessage({
      content: turn.calls.map((call) => ({
        type: "tool-call" as const,
        id: ToolCallId(call.id),
        name: call.name,
        arguments: call.arguments,
      })),
      source: { provider: "deepseek", model },
    });
  }
  return createToolResultMessage({
    callId: ToolCallId(turn.callId),
    content: [{ type: "text", text: turn.text }],
    isError: false,
  });
}

/** 逻辑请求 → POC1 LlmRequest（工具为注册表 ToolSchema 的 parametersJson 形态） */
function toPoc1Request(of: ParityCase): LlmRequest {
  const registered = buildReviewReadTools();
  return {
    model: of.model,
    effort: "default",
    messages: [{ role: "system", content: of.system }, ...of.turns.map(toPoc1Message)],
    tools: of.withTools ? registered.map(toToolSchema) : [],
  };
}

/** 逻辑请求 → DSH GenerateOptions（工具为 object 形态 parameters；canonical 键序经 round-trip 保持） */
function toDshOptions(of: ParityCase): GenerateOptions {
  const registered = buildReviewReadTools();
  return {
    provider: "deepseek",
    model: of.model,
    system: of.system,
    messages: of.turns.map((turn) => toDshMessage(turn, of.model)),
    ...(of.withTools
      ? {
          tools: registered.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: JSON.parse(tool.parametersJson) as Record<string, unknown>,
          })),
        }
      : {}),
  };
}

describe("双包 wire parity（#45）：同一逻辑请求 → 相同 JSON 字节", () => {
  for (const testCase of CASES) {
    it(`${testCase.label} [model=${testCase.model}]`, () => {
      const poc1Bytes = JSON.stringify(poc1BuildChatCompletionsBody(toPoc1Request(testCase)));
      const dshBytes = JSON.stringify(dshBuildChatCompletionsBody(toDshOptions(testCase)));
      expect(dshBytes).toBe(poc1Bytes);
    });
  }

  it("对照面敏感性：deepseek 档字节锚含 thinking 锁档与 model 首键（负面对照自动化）", () => {
    const anchor = dshBuildChatCompletionsBody(toDshOptions(CASES[0]!)) as unknown as Record<string, unknown>;
    expect(Object.keys(anchor)[0]).toBe("model");
    expect(anchor.thinking).toEqual({ type: "enabled" });
    expect(anchor.reasoning_effort).toBe("high");
    expect("max_tokens" in anchor).toBe(false);
  });
});
