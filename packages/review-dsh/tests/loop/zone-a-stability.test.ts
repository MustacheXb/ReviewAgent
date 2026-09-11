/**
 * Spike（票 #18）+ #22 扩展：Zone A 字节稳定——同单元两次独立装配运行，
 * 捕获请求前缀逐字节相等（缓存纪律票的前置断言）。
 *
 * 「前缀」= POC1 请求序列化形态：system（Zone A）+ messages 的
 * {role, content}。DSH 内部的消息 id（UUID）与 source 元数据不进
 * POC1 字节，不在比较范围。
 *
 * #22 扩展：config C（工具挂载）形态下，比较面升级为完整请求对象
 * （model + effort + messages + tools schema）的规范序列化——工具
 * schema 属 Zone A 工具面字节，同样受稳定纪律约束；且两种形态均
 * 断言无变更重跑零 Cache Break（#22 AC3，config B 见 cache-discipline）。
 */

import { describe, expect, it } from "vitest";

import { SYSTEM_PROMPT } from "../../../../src/loop/messages.js";
import { SAMPLE_MR_CASE } from "../../../../tests/fixtures/sample-mr-case.js";

import type { FakeLlmScriptStep } from "../../src/llm/fake-adapter.js";
import type { MrInput } from "../../src/plugins/review-context.js";
import type { ReviewPolicyConfig } from "../../src/plugins/review-policy.js";
import type { AuditLlmRequest, ReviewAudit } from "../../src/plugins/review-runtime.js";
import { runIsolated } from "../helpers/mount-profile.js";

const INPUT: MrInput = {
  caseId: "VUL4J-38",
  issueDescription: "Vulnerability fix: URL encoding",
  diff: "--- a/src/main/java/Example.java\n+++ b/src/main/java/Example.java\n@@ -1,1 +1,1 @@\n-old\n+new",
};

/** config C 稳定门的输入：工具挂载需要 repoPath 作数据源（不进请求字节） */
const CONFIG_C_INPUT: MrInput = {
  ...INPUT,
  repoPath: SAMPLE_MR_CASE.repoPath,
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

/** 一次完整装配 + 一次检视会话（inline 拆卸，两次运行零共享状态） */
async function runOnce(
  policy: ReviewPolicyConfig = {},
  input: MrInput = INPUT,
): Promise<{
  zoneSnapshots: readonly string[];
  audit: ReviewAudit;
}> {
  const { result, zoneSnapshots } = await runIsolated(configAScript(), { policy }, input);
  return { zoneSnapshots, audit: result.audit };
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
    const projection = (requests: readonly AuditLlmRequest[]): readonly string[] =>
      requests.map((request) =>
        JSON.stringify(request.messages.map((message) => ({ role: message.role, content: message.content }))),
      );
    expect(projection(second.audit.requests)).toEqual(projection(first.audit.requests));

    // 无变更重跑零 Cache Break（#22 AC3：append-only 会话 + 稳定前缀 → 无归因）
    expect(first.audit.cacheBreaks).toEqual([]);
    expect(second.audit.cacheBreaks).toEqual([]);
  });

  it("config C（工具挂载）：两次独立运行全部请求（含 7 工具 schema）逐字节相等", async () => {
    const first = await runOnce({ toolsEnabled: true }, CONFIG_C_INPUT);
    const second = await runOnce({ toolsEnabled: true }, CONFIG_C_INPUT);

    expect(first.audit.requests).toHaveLength(6);
    // 每请求携带 7 个工具 schema（Zone A 工具面的字节稳定）
    for (const request of first.audit.requests) {
      expect(request.tools).toHaveLength(7);
    }

    // 两次运行之间：完整请求对象（model + effort + messages + tools）的
    // 规范序列化逐字节相等
    expect(second.audit.requests.map((request) => JSON.stringify(request))).toEqual(
      first.audit.requests.map((request) => JSON.stringify(request)),
    );

    // 无变更重跑零 Cache Break（#22 AC3；工具面字节亦稳定）
    expect(first.audit.cacheBreaks).toEqual([]);
    expect(second.audit.cacheBreaks).toEqual([]);
  });
});
