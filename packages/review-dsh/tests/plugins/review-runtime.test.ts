import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { describe, expect, it } from "vitest";

import type { CapturedWireRequest } from "../../src/llm/wire-log.js";
import type { CapturedKernelRequest } from "../../src/plugins/review-cache.js";
import type { AuditLlmRequest, AuditMessage } from "../../src/plugins/review-runtime.js";
import { classifyAuditCacheBreaks, toAuditRequests } from "../../src/plugins/review-runtime.js";

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

/** 审计请求构造（classifyAuditCacheBreaks 的入参形态；parameters 为对象——桥接点） */
function auditRequest(options: {
  readonly model?: string;
  readonly system?: string;
  readonly tail?: readonly AuditMessage[];
  readonly tools?: readonly {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  }[];
} = {}): AuditLlmRequest {
  return {
    model: options.model ?? "deepseek-v4-flash",
    effort: "default",
    messages: [
      { role: "system", content: options.system ?? "ZONE-A" },
      { role: "user", content: "mr-intro" },
      ...(options.tail ?? []),
    ],
    tools: options.tools ?? [],
  };
}

describe("classifyAuditCacheBreaks：审计请求 → Cache Break 归因（冻结分类器桥接）", () => {
  it("model 段分歧 → MODEL_CHANGED（zone MODEL），offset = model 段内首异位", () => {
    const breaks = classifyAuditCacheBreaks([auditRequest({ model: "m" }), auditRequest({ model: "n" })]);

    // JSON.stringify("m") = "\"m\"" vs "\"n\""：首异位 = 1（手算布局锚点）
    expect(breaks).toEqual([{ requestIndex: 1, reason: "MODEL_CHANGED", zone: "MODEL", divergeByteOffset: 1 }]);
  });

  it("messages[0]（system）分歧 → SYSTEM_PROMPT_CHANGED（zone A）", () => {
    const breaks = classifyAuditCacheBreaks([
      auditRequest({ system: "ZONE-A" }),
      auditRequest({ system: "ZONE-A!" }),
    ]);

    expect(breaks).toEqual([
      expect.objectContaining({ requestIndex: 1, reason: "SYSTEM_PROMPT_CHANGED", zone: "A" }),
    ]);
    expect(breaks[0]?.divergeByteOffset).toBeGreaterThan(0);
  });

  it("中段消息分歧 → CONTEXT_REORDERED（zone B/C）", () => {
    const breaks = classifyAuditCacheBreaks([
      auditRequest({ tail: [{ role: "user", content: "phase-1" }] }),
      auditRequest({ tail: [{ role: "user", content: "phase-1-rewritten" }] }),
    ]);

    expect(breaks).toEqual([
      expect.objectContaining({ requestIndex: 1, reason: "CONTEXT_REORDERED", zone: "B/C" }),
    ]);
  });

  it("消息一致而 tools 段分歧 → TOOL_SCHEMA_CHANGED（parameters 对象经桥接参与字节比较）", () => {
    const tools = (value: number) => [
      { name: "review.get_file", description: "read a file", parameters: { startLine: value } },
    ];
    const breaks = classifyAuditCacheBreaks([auditRequest({ tools: tools(1) }), auditRequest({ tools: tools(2) })]);

    expect(breaks).toEqual([
      expect.objectContaining({ requestIndex: 1, reason: "TOOL_SCHEMA_CHANGED", zone: "A" }),
    ]);
    expect(typeof breaks[0]?.divergeByteOffset).toBe("number");
  });

  it("前缀语义：append-only 增长 / 收缩都不构成 break", () => {
    const grown = classifyAuditCacheBreaks([
      auditRequest(),
      auditRequest({ tail: [{ role: "assistant", content: "reply" }] }),
    ]);
    expect(grown).toEqual([]);

    const shrunk = classifyAuditCacheBreaks([
      auditRequest({ tail: [{ role: "assistant", content: "reply" }] }),
      auditRequest(),
    ]);
    expect(shrunk).toEqual([]);
  });

  it("空序列 / 单请求：无相邻对，零记录", () => {
    expect(classifyAuditCacheBreaks([])).toEqual([]);
    expect(classifyAuditCacheBreaks([auditRequest()])).toEqual([]);
  });

  it("多对递增：requestIndex 指向后一请求，逐对归因", () => {
    const breaks = classifyAuditCacheBreaks([
      auditRequest({ model: "m" }),
      auditRequest({ model: "n" }),
      auditRequest({ model: "n", system: "ZONE-B" }),
    ]);

    expect(breaks.map((record) => [record.requestIndex, record.reason])).toEqual([
      [1, "MODEL_CHANGED"],
      [2, "SYSTEM_PROMPT_CHANGED"],
    ]);
  });
});
