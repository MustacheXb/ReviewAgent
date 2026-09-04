import { describe, expect, it } from "vitest";
import type { KnowledgeEntry } from "../src/contracts/knowledge.js";
import { buildReviewToolkit } from "../src/tools/toolkit.js";
import {
  createContextLedger,
  createInertContextLedger,
  LEDGER_REFERENCE_ECHO_MAX_CHARS,
} from "../src/tools/ledger.js";
import type { ToolCall } from "../src/contracts/llm-client.js";
import { SAMPLE_MR_CASE } from "./fixtures/sample-mr-case.js";

/**
 * 工单 #8 验收：Context Ledger 纯逻辑（功能态 / 惰性态）与工具箱级去重行为。
 * 断言对象是 ContextLedger 公开方法与 executor 的输出字符串（runReview 工具
 * 挂载的同一接口）：命中语义（精确重复）、引用格式（字节确定）、顺序编号、
 * 防御性快照；ledger:true 工具箱的重复读取返回引用而非原文。
 */

const MATH_UTILS = "src/main/java/com/example/math/MathUtils.java";

const toolCall = (name: string, argumentsJson: string): ToolCall => ({
  id: "call-1",
  name,
  argumentsJson,
});

describe("createContextLedger (functional ledger, run-private)", () => {
  it("misses before registration and returns a formatted reference after registering", () => {
    const ledger = createContextLedger();
    const description = "review.get_file src/main/java/com/example/math/MathUtils.java:15-22";

    expect(ledger.referenceIfLoaded("range", description)).toBeUndefined();

    ledger.register("range", description);
    expect(ledger.referenceIfLoaded("range", description)).toBe(
      `Already loaded: ctx#001 (${description})`,
    );
  });

  it("assigns sequential zero-padded ids in registration order", () => {
    const ledger = createContextLedger();
    for (let index = 1; index <= 10; index++) {
      ledger.register("symbol", `review.get_symbol "symbol${index}"`);
    }
    expect(ledger.snapshot().map((entry) => entry.id)).toEqual([
      "ctx#001",
      "ctx#002",
      "ctx#003",
      "ctx#004",
      "ctx#005",
      "ctx#006",
      "ctx#007",
      "ctx#008",
      "ctx#009",
      "ctx#010",
    ]);
  });

  it("keys on kind and description together (same description under another kind misses)", () => {
    const ledger = createContextLedger();
    ledger.register("file", "review.get_file src/Foo.java");

    expect(ledger.referenceIfLoaded("file", "review.get_file src/Foo.java")).toContain("ctx#001");
    expect(ledger.referenceIfLoaded("range", "review.get_file src/Foo.java")).toBeUndefined();
    expect(ledger.referenceIfLoaded("symbol", "review.get_file src/Foo.java")).toBeUndefined();
  });

  it("does not match different descriptions (no subsumption between overlapping reads)", () => {
    const ledger = createContextLedger();
    ledger.register("file", "review.get_file src/Foo.java");

    // 整读之后的子区间读取、不同区间、其他工具的相同符号名：均不命中
    expect(ledger.referenceIfLoaded("range", "review.get_file src/Foo.java:100-180")).toBeUndefined();
    expect(ledger.referenceIfLoaded("file", "review.get_file src/Bar.java")).toBeUndefined();
    expect(ledger.referenceIfLoaded("symbol", "review.get_symbol \"sumFirst\"")).toBeUndefined();
  });

  it("bounds the description echo inside the reference (deterministic truncation)", () => {
    const ledger = createContextLedger();
    const longDescription = `review.search_rule "${"x".repeat(400)}"`;
    ledger.register("evidence", longDescription);

    const reference = ledger.referenceIfLoaded("evidence", longDescription);
    expect(reference).toBeDefined();
    const echo = reference?.slice("Already loaded: ctx#001 (".length, -1) ?? "";
    expect(echo.length).toBe(LEDGER_REFERENCE_ECHO_MAX_CHARS + 3);
    expect(echo.endsWith("...")).toBe(true);
  });

  it("returns defensive snapshots: earlier snapshots freeze, arrays and entries are fresh copies", () => {
    const ledger = createContextLedger();
    ledger.register("file", "review.get_file src/Foo.java");
    const first = ledger.snapshot();
    ledger.register("symbol", "review.get_symbol \"Foo\"");

    expect(first).toHaveLength(1);
    expect(ledger.snapshot()).toHaveLength(2);

    const second = ledger.snapshot();
    const third = ledger.snapshot();
    expect(second).not.toBe(third);
    expect(second[0]).not.toBe(third?.[0]);
  });
});

describe("createInertContextLedger (A/B/C/D default: zero behavior change)", () => {
  it("never reports a hit and keeps the snapshot empty even after register calls", () => {
    const ledger = createInertContextLedger();
    ledger.register("file", "review.get_file src/Foo.java");

    expect(ledger.referenceIfLoaded("file", "review.get_file src/Foo.java")).toBeUndefined();
    expect(ledger.snapshot()).toEqual([]);
  });
});

describe("toolkit with ledger: true (Zone C tool-result dedup)", () => {
  const RULES: readonly KnowledgeEntry[] = [
    {
      id: "R001",
      title: "Off-by-one loop bounds",
      text: "Prefer i < count over i <= count when summing the first count elements.",
    },
  ];

  function ledgerToolkit() {
    return buildReviewToolkit({
      repoPath: SAMPLE_MR_CASE.repoPath,
      diff: SAMPLE_MR_CASE.diff,
      ledger: true,
      knowledge: { rules: RULES },
    });
  }

  it("returns the full range content first and an 'Already loaded' reference on the exact repeat", async () => {
    const toolkit = ledgerToolkit();
    const call = toolCall("review.get_file", `{"path":"${MATH_UTILS}","startLine":15,"endLine":22}`);
    const first = await toolkit.executor.execute(call);
    const second = await toolkit.executor.execute({ ...call, id: "call-2" });

    expect(first).toContain("Lines 15-22 of 25");
    expect(first).toContain("18 |     public static int sumFirst(int[] values, int count) {");
    expect(second).toBe(`Already loaded: ctx#001 (review.get_file ${MATH_UTILS}:15-22)`);
  });

  it("registers whole-file reads as kind file and dedupes them separately from ranges", async () => {
    const toolkit = ledgerToolkit();
    const whole = await toolkit.executor.execute(toolCall("review.get_file", `{"path":"${MATH_UTILS}"}`));
    const wholeRepeat = await toolkit.executor.execute(
      toolCall("review.get_file", `{"path":"${MATH_UTILS}"}`),
    );
    const range = await toolkit.executor.execute(
      toolCall("review.get_file", `{"path":"${MATH_UTILS}","startLine":15,"endLine":22}`),
    );

    expect(whole).toContain("Lines 1-25 of 25");
    expect(wholeRepeat).toBe(`Already loaded: ctx#001 (review.get_file ${MATH_UTILS})`);
    expect(range).toContain("Lines 15-22 of 25");
    expect(toolkit.ledger.snapshot().map((entry) => entry.kind)).toEqual(["file", "range"]);
  });

  it("canonicalizes omitted range bounds (startLine default 1 hits the same key)", async () => {
    const toolkit = ledgerToolkit();
    const first = await toolkit.executor.execute(
      toolCall("review.get_file", `{"path":"${MATH_UTILS}","endLine":22}`),
    );
    const second = await toolkit.executor.execute(
      toolCall("review.get_file", `{"path":"${MATH_UTILS}","startLine":1,"endLine":22}`),
    );

    expect(first).toContain("Lines 1-22 of 25");
    expect(second).toBe(`Already loaded: ctx#001 (review.get_file ${MATH_UTILS}:1-22)`);
  });

  it("dedupes get_symbol repeats while keeping find_references / get_call_chain requests distinct", async () => {
    const toolkit = ledgerToolkit();
    const symbolFirst = await toolkit.executor.execute(toolCall("review.get_symbol", '{"symbol":"sumFirst"}'));
    const symbolRepeat = await toolkit.executor.execute(toolCall("review.get_symbol", '{"symbol":"sumFirst"}'));
    const refsRepeat = await toolkit.executor.execute(
      toolCall("review.find_references", '{"symbol":"sumFirst"}'),
    );
    const chainRepeat = await toolkit.executor.execute(
      toolCall("review.get_call_chain", '{"symbol":"sumFirst"}'),
    );

    expect(symbolFirst).toContain('Symbol "sumFirst": 1 match(es)');
    expect(symbolRepeat).toBe('Already loaded: ctx#001 (review.get_symbol "sumFirst")');
    // find_references / get_call_chain 是不同请求（标识含工具名），各自返回原文
    expect(refsRepeat).toContain('References to "sumFirst"');
    expect(chainRepeat).toContain('Call chain for "sumFirst"');
    expect(toolkit.ledger.snapshot().map((entry) => entry.description)).toEqual([
      'review.get_symbol "sumFirst"',
      'review.find_references "sumFirst"',
      'review.get_call_chain "sumFirst"',
    ]);
  });

  it("dedupes get_diff and search_rule as kind evidence", async () => {
    const toolkit = ledgerToolkit();
    const diffFirst = await toolkit.executor.execute(toolCall("review.get_diff", "{}"));
    const diffRepeat = await toolkit.executor.execute(toolCall("review.get_diff", "{}"));
    const ruleFirst = await toolkit.executor.execute(toolCall("review.search_rule", '{"query":"off-by-one"}'));
    const ruleRepeat = await toolkit.executor.execute(toolCall("review.search_rule", '{"query":"off-by-one"}'));

    expect(diffFirst).toContain("MR unified diff:");
    expect(diffRepeat).toBe("Already loaded: ctx#001 (review.get_diff)");
    expect(ruleFirst).toContain("[R001] Off-by-one loop bounds");
    expect(ruleRepeat).toBe('Already loaded: ctx#002 (review.search_rule "off-by-one")');
    expect(toolkit.ledger.snapshot().map((entry) => entry.kind)).toEqual(["evidence", "evidence"]);
  });

  it("does not register failed reads: a retry after an error fails again with the real read", async () => {
    const toolkit = ledgerToolkit();
    const badCall = toolCall("review.get_file", '{"path":"no/such/File.java"}');
    await expect(toolkit.executor.execute(badCall)).rejects.toThrow(/cannot be read from the repository snapshot/);
    await expect(toolkit.executor.execute(badCall)).rejects.toThrow(/cannot be read from the repository snapshot/);
    expect(toolkit.ledger.snapshot()).toEqual([]);
  });

  it("returns a hit without touching the data source (repeat needs no repository)", async () => {
    const brokenRepoToolkit = buildReviewToolkit({
      repoPath: "Z:/definitely/not/a/repo",
      diff: SAMPLE_MR_CASE.diff,
      ledger: true,
    });
    const call = toolCall("review.get_file", '{"path":"src/Foo.java"}');
    await expect(brokenRepoToolkit.executor.execute(call)).rejects.toThrow(
      /failed to list Java files/,
    );

    // 对照：已成功登记的读取，重复命中不触碰数据源（repo 失效也不影响引用字节）
    const workingToolkit = ledgerToolkit();
    await workingToolkit.executor.execute(toolCall("review.get_symbol", '{"symbol":"sumFirst"}'));
    const repeat = await workingToolkit.executor.execute(
      toolCall("review.get_symbol", '{"symbol":"sumFirst"}'),
    );
    expect(repeat).toBe('Already loaded: ctx#001 (review.get_symbol "sumFirst")');
  });

  it("keeps T05/T06 behavior byte-identical when the ledger is not enabled (default)", async () => {
    const toolkit = buildReviewToolkit({
      repoPath: SAMPLE_MR_CASE.repoPath,
      diff: SAMPLE_MR_CASE.diff,
    });
    const call = toolCall("review.get_file", `{"path":"${MATH_UTILS}","startLine":15,"endLine":22}`);
    const first = await toolkit.executor.execute(call);
    const second = await toolkit.executor.execute({ ...call, id: "call-2" });

    expect(second).toBe(first);
    expect(first).toContain("Lines 15-22 of 25");
    expect(toolkit.ledger.snapshot()).toEqual([]);
  });
});
