import { describe, expect, it } from "vitest";

import type { GenerateOptions } from "@deepseek-ai/dsh-llm";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

import { FakeLlmAdapter, type FakeReply } from "../../src/llm/fake-adapter.js";

async function collect(chunks: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const chunk of chunks) {
    out.push(chunk);
  }
  return out;
}

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    messages: [createUserMessage({ content: [{ type: "text", text: "Phase 1 of 6" }], source: { kind: "user" } })],
    system: "Zone A bytes",
    ...overrides,
  };
}

describe("FakeLlmAdapter（ctx.llm 同缝 fake：脚本化回复 + 请求捕获）", () => {
  it("脚本回复产出 block-start → text-delta → block-end → usage → finish 的完整块流", async () => {
    const reply: FakeReply = {
      kind: "reply",
      content: '{"summary":"changed url encoding"}',
      usage: { inputTokens: 300, outputTokens: 42, cacheReadTokens: 700 },
    };
    const adapter = new FakeLlmAdapter([reply]);
    const chunks = await collect(adapter.stream(options()));

    expect(chunks).toEqual([
      { type: "block-start", index: 0, blockType: "text" },
      { type: "text-delta", index: 0, text: '{"summary":"changed url encoding"}' },
      {
        type: "block-end",
        index: 0,
        block: { type: "text", text: '{"summary":"changed url encoding"}' },
      },
      { type: "usage", usage: { inputTokens: 300, outputTokens: 42, cacheReadTokens: 700 } },
      { type: "finish", reason: { kind: "stop" } },
    ]);
  });

  it("带 toolCalls 的回复产出 tool-call 块并以 tool-calls finish 收尾", async () => {
    const reply: FakeReply = {
      kind: "reply",
      content: "",
      toolCalls: [{ id: "call_1", name: "review.get_diff", arguments: "{}" }],
    };
    const adapter = new FakeLlmAdapter([reply]);
    const chunks = await collect(adapter.stream(options()));

    expect(chunks).toEqual([
      { type: "block-start", index: 0, blockType: "tool-call" },
      { type: "tool-call-delta", index: 0, id: "call_1", name: "review.get_diff", argumentsDelta: "{}" },
      {
        type: "block-end",
        index: 0,
        block: { type: "tool-call", id: "call_1", name: "review.get_diff", arguments: "{}" },
      },
      { type: "finish", reason: { kind: "tool-calls" } },
    ]);
  });

  it("捕获收到的每个请求（含 system 与 tools），脚本耗尽时显式报错", async () => {
    const adapter = new FakeLlmAdapter([{ kind: "reply", content: "ok" }]);
    await collect(adapter.stream(options({ tools: [{ name: "review.get_diff", description: "d", parameters: {} }] })));

    expect(adapter.capturedRequests).toHaveLength(1);
    expect(adapter.capturedRequests[0]).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      system: "Zone A bytes",
      messages: [{ role: "user", content: [{ type: "text", text: "Phase 1 of 6" }] }],
      tools: [{ name: "review.get_diff", description: "d", parameters: {} }],
    });

    await expect(collect(adapter.stream(options()))).rejects.toThrow(/script exhausted/i);
  });

  it("fail 步以 error finish 结束（不发 usage，不发后续块）", async () => {
    const adapter = new FakeLlmAdapter([{ kind: "fail", message: "gateway exploded" }]);
    const chunks = await collect(adapter.stream(options()));

    expect(chunks).toEqual([
      {
        type: "finish",
        reason: {
          kind: "error",
          failure: { message: "gateway exploded", code: "FAKE_LLM_SCRIPT" },
        },
      },
    ]);
  });

  it("usage 缺省时不发 usage 块（adapter 契约：usage 先于 finish，可缺省）", async () => {
    const adapter = new FakeLlmAdapter([{ kind: "reply", content: "ok" }]);
    const chunks = await collect(adapter.stream(options()));

    expect(chunks.filter((chunk) => (chunk as { type: string }).type === "usage")).toEqual([]);
    expect(chunks[chunks.length - 1]).toEqual({ type: "finish", reason: { kind: "stop" } });
  });
});
