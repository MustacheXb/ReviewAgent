import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";

import { SYSTEM_PROMPT } from "../../../../src/loop/messages.js";

import { FakeLlmAdapter, type FakeLlmScriptStep } from "../../src/llm/fake-adapter.js";
import { assembleReviewProfile, type ReviewProfileHandle } from "../../src/profile/assemble.js";
import type { MrInput } from "../../src/plugins/review-context.js";

/**
 * Spike（票 #18）：Zone A 字节稳定——同单元两次独立装配运行，
 * 捕获请求前缀逐字节相等（缓存纪律票的前置断言）。
 *
 * 「前缀」= POC1 请求序列化形态：system（Zone A）+ messages 的
 * {role, content}。DSH 内部的消息 id（UUID）与 source 元数据不进
 * POC1 字节，不在比较范围。
 */

const INPUT: MrInput = {
  caseId: "VUL4J-38",
  issueDescription: "Vulnerability fix: URL encoding",
  diff: "--- a/src/main/java/Example.java\n+++ b/src/main/java/Example.java\n@@ -1,1 +1,1 @@\n-old\n+new",
};

function configAScript(): readonly FakeLlmScriptStep[] {
  return [
    { kind: "reply", content: '{"summary":"s"}' },
    { kind: "reply", content: '{"riskClass":"Low","reason":"r"}' },
    { kind: "reply", content: '{"neededContext":[],"reason":"r"}' },
    { kind: "reply", content: '{"notes":"n"}' },
    { kind: "reply", content: '{"candidates":[]}' },
    { kind: "reply", content: '{"verdicts":[],"complete":true}' },
  ];
}

/** 一次完整装配 + 一次检视会话（用后即焚，保证两次运行零共享状态） */
async function runOnce(): Promise<{ zoneSnapshots: readonly string[]; requests: readonly { role: string; content: string }[][] }> {
  const ctx = new Context();
  const sessionRoot = await mkdtemp(join(tmpdir(), "review-dsh-zonea-"));
  const adapter = new FakeLlmAdapter(configAScript());
  const handle: ReviewProfileHandle = await assembleReviewProfile(ctx, { sessionRoot, adapter });
  try {
    const result = await ctx.reviewRuntime.run(INPUT);
    return {
      zoneSnapshots: ctx.reviewCache.zoneSnapshots,
      requests: result.audit.requests.map((request) => request.messages.map((message) => ({ role: message.role, content: message.content }))),
    };
  } finally {
    await handle.dispose();
    await rm(sessionRoot, { recursive: true, force: true });
  }
}

describe("spike：Zone A 字节稳定（同单元两次运行）", () => {
  it("两次独立装配运行：Zone A 前缀与请求消息序列逐字节相等", async () => {
    const first = await runOnce();
    const second = await runOnce();

    // 每次运行内部：6 个请求的 Zone A 前缀全同，且等于冻结 harness 的 SYSTEM_PROMPT
    expect(first.zoneSnapshots).toHaveLength(6);
    expect(second.zoneSnapshots).toHaveLength(6);
    expect(first.zoneSnapshots.every((zone) => zone === SYSTEM_PROMPT)).toBe(true);
    expect(second.zoneSnapshots.every((zone) => zone === SYSTEM_PROMPT)).toBe(true);

    // 两次运行之间：Zone A 前缀逐字节相等
    expect(second.zoneSnapshots).toEqual(first.zoneSnapshots);

    // 两次运行之间：全部 6 个请求的消息序列（POC1 序列化形态）逐字节相等
    expect(second.requests).toEqual(first.requests);
  });
});
