import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { describe, expect, it } from "vitest";

import type { CapturedWireRequest } from "../../src/llm/wire-log.js";
import type { CapturedKernelRequest } from "../../src/plugins/review-cache.js";
import { toAuditRequests } from "../../src/plugins/review-runtime.js";

function kernelRequest(options: { readonly omitSystem?: boolean } = {}): CapturedKernelRequest {
  const base: Omit<CapturedKernelRequest, "system"> = {
    model: "deepseek-v4-flash",
    reasoningEffort: "default",
    messages: [createUserMessage({ content: [{ type: "text", text: "phase" }], source: { kind: "user" } })],
    tools: [],
  };
  return options.omitSystem === true ? base : { ...base, system: "ZONE-A" };
}

function wireRequest(text: string): CapturedWireRequest {
  return { text };
}

describe("toAuditRequests：kernel 快照 × wire 字节合并（错位守卫）", () => {
  it("对齐合并：system 落 messages[0]，wireBody 按调用序并入", () => {
    const merged = toAuditRequests(
      [kernelRequest(), kernelRequest({ omitSystem: true })],
      [wireRequest('{"a":1}'), wireRequest('{"a":2}')],
      true,
    );

    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual({
      model: "deepseek-v4-flash",
      effort: "default",
      messages: [
        { role: "system", content: "ZONE-A" },
        { role: "user", content: "phase" },
      ],
      tools: [],
      wireBody: '{"a":1}',
    });
    expect(merged[1]?.wireBody).toBe('{"a":2}');
    expect(merged[1]?.messages[0]).toEqual({ role: "user", content: "phase" });
  });

  it("wire 捕获未挂载：wireRequests 恒空，字段合法缺席、不判错位", () => {
    const merged = toAuditRequests([kernelRequest(), kernelRequest()], [], false);

    expect(merged).toHaveLength(2);
    expect(merged.every((request) => request.wireBody === undefined)).toBe(true);
  });

  it("挂载捕获但两流错位 → fail fast（绝不产出错位归因的审计）", () => {
    // 场景：三次 kernel 分发，其中一次在序列化点前早退 → 只剩两条 wire 字节
    expect(() => toAuditRequests([kernelRequest(), kernelRequest(), kernelRequest()], [], true)).toThrow(
      /misaligned: 0 wire record\(s\) for 3 kernel request/,
    );
    expect(() =>
      toAuditRequests(
        [kernelRequest(), kernelRequest(), kernelRequest()],
        [wireRequest('{"a":1}'), wireRequest('{"a":2}')],
        true,
      ),
    ).toThrow(/misaligned: 2 wire record\(s\) for 3 kernel request/);
  });
});
