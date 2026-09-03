import { describe, expect, it } from "vitest";
import { toCanonicalJson } from "../src/tools/json-canonical.js";
import { GET_DIFF_TOOL } from "../src/tools/get-diff.js";
import {
  assembleReviewTools,
  createToolExecutor,
  parseToolArguments,
  REVIEW_TOOL_ORDER,
  toToolSchema,
} from "../src/tools/registry.js";
import { buildReviewReadTools, buildReviewToolkit } from "../src/tools/toolkit.js";
import { createInertContextLedger } from "../src/tools/ledger.js";
import type { ToolCall } from "../src/contracts/llm-client.js";
import { SAMPLE_MR_CASE } from "./fixtures/sample-mr-case.js";

/**
 * 工单 #6 验收：工具 schema 在注册表层字节稳定（固定字段顺序），
 * 注册表保证数量 / 顺序 / schema 固定（Zone A 稳定前缀的一部分）。
 */

const toolCall = (name: string, argumentsJson: string): ToolCall => ({
  id: "call-1",
  name,
  argumentsJson,
});

describe("canonical JSON serialization (byte-stable tool schemas)", () => {
  it("serializes object keys in a fixed canonical order regardless of construction order", () => {
    const first = { required: [], additionalProperties: false, properties: {}, type: "object" };
    const second = { type: "object", properties: {}, required: [], additionalProperties: false };
    expect(toCanonicalJson(first)).toBe(toCanonicalJson(second));
    expect(toCanonicalJson(second)).toBe('{"type":"object","properties":{},"required":[],"additionalProperties":false}');
  });

  it("sorts non-schema keys lexicographically and preserves array order", () => {
    expect(toCanonicalJson({ zeta: 1, alpha: 2, type: "integer" })).toBe('{"type":"integer","alpha":2,"zeta":1}');
    expect(toCanonicalJson({ values: [3, 1, 2] })).toBe('{"values":[3,1,2]}');
    expect(toCanonicalJson({ nested: { required: ["b"], type: "object" } })).toBe(
      '{"nested":{"type":"object","required":["b"]}}',
    );
  });

  it("rejects non-serializable values explicitly", () => {
    expect(() => toCanonicalJson(() => "function")).toThrow(/cannot serialize value of type function/);
  });
});

describe("review tool registry (fixed count, order and schema)", () => {
  it("declares the canonical 7-tool order from the design document", () => {
    expect(REVIEW_TOOL_ORDER).toEqual([
      "review.get_diff",
      "review.get_symbol",
      "review.get_file",
      "review.find_references",
      "review.get_call_chain",
      "review.search_rule",
      "review.search_history",
    ]);
  });

  it("returns the full 7-tool set in canonical order (T05 read trio + T06 search quartet)", () => {
    expect(buildReviewReadTools().map((tool) => tool.name)).toEqual([
      "review.get_diff",
      "review.get_symbol",
      "review.get_file",
      "review.find_references",
      "review.get_call_chain",
      "review.search_rule",
      "review.search_history",
    ]);
  });

  it("produces byte-identical schemas across independent assemblies", () => {
    const first = assembleReviewTools([GET_DIFF_TOOL]);
    const second = assembleReviewTools([GET_DIFF_TOOL]);
    expect(JSON.stringify(second.map(toToolSchema))).toBe(JSON.stringify(first.map(toToolSchema)));
  });

  it("serializes every parametersJson with the canonical field order (type < properties < required < additionalProperties)", () => {
    for (const tool of buildReviewReadTools()) {
      expect(tool.parametersJson.startsWith('{"type":"object","properties":')).toBe(true);
      const typeAt = tool.parametersJson.indexOf('"type":"object"');
      const propertiesAt = tool.parametersJson.indexOf('"properties"');
      const requiredAt = tool.parametersJson.indexOf('"required"');
      const additionalAt = tool.parametersJson.indexOf('"additionalProperties"');
      expect(typeAt).toBeLessThan(propertiesAt);
      expect(propertiesAt).toBeLessThan(requiredAt);
      expect(requiredAt).toBeLessThan(additionalAt);
      expect(JSON.parse(tool.parametersJson)).toBeTypeOf("object");
    }
  });

  it("locks the prose-free get_diff schema bytes exactly", () => {
    const diffTool = buildReviewReadTools().find((tool) => tool.name === "review.get_diff");
    expect(diffTool).toBeDefined();
    if (diffTool === undefined) {
      return;
    }
    const schema = toToolSchema(diffTool);
    expect(schema.name).toBe("review.get_diff");
    expect(schema.parametersJson).toBe('{"type":"object","properties":{},"required":[],"additionalProperties":false}');
    expect(schema.parametersJson).toBe(toCanonicalJson(GET_DIFF_TOOL.parameters));
  });

  it("rejects tools outside the fixed review.* set and duplicate registrations", () => {
    const outsider = { ...GET_DIFF_TOOL, name: "review.not_in_the_set" };
    expect(() => assembleReviewTools([outsider])).toThrow(/is not part of the fixed review\.\* tool set/);
    expect(() => assembleReviewTools([GET_DIFF_TOOL, GET_DIFF_TOOL])).toThrow(/registered more than once/);
    expect(() => assembleReviewTools([{ ...GET_DIFF_TOOL, description: "   " }])).toThrow(
      /must declare a non-empty description/,
    );
  });
});

describe("tool executor dispatch and input validation (bounded failures)", () => {
  const toolkit = buildReviewToolkit({
    repoPath: SAMPLE_MR_CASE.repoPath,
    diff: SAMPLE_MR_CASE.diff,
  });

  it("fails with a bounded, explicit error for an unknown tool name", async () => {
    await expect(toolkit.executor.execute(toolCall("review.nope", "{}"))).rejects.toThrow(
      /unknown tool "review.nope" \(available: review.get_diff, review.get_symbol, review.get_file, review.find_references, review.get_call_chain, review.search_rule, review.search_history\)/,
    );
  });

  it("fails boundedly when argumentsJson is not valid JSON (echo is truncated)", async () => {
    const huge = `{"symbol": "${"x".repeat(500)}"`;
    await expect(toolkit.executor.execute(toolCall("review.get_symbol", huge))).rejects.toThrow(
      /review\.get_symbol: arguments are not valid JSON \(got .{80}\.\.\.\):/,
    );
  });

  it("rejects non-object arguments (arrays and scalars)", () => {
    expect(() => parseToolArguments(toolCall("review.get_symbol", "[1,2]"))).toThrow(/must be a JSON object/);
    expect(() => parseToolArguments(toolCall("review.get_symbol", '"sumFirst"'))).toThrow(/must be a JSON object/);
  });

  it("validates required and typed arguments per tool", async () => {
    await expect(toolkit.executor.execute(toolCall("review.get_symbol", "{}"))).rejects.toThrow(
      /review.get_symbol: argument "symbol" must be a non-empty string/,
    );
    await expect(
      toolkit.executor.execute(toolCall("review.get_file", '{"path":"a.java","startLine":-3}')),
    ).rejects.toThrow(/review.get_file: argument "startLine" must be a positive integer/);
    await expect(
      toolkit.executor.execute(toolCall("review.get_file", '{"path":"a.java","startLine":5,"endLine":2}')),
    ).rejects.toThrow(/"startLine" \(5\) must not exceed "endLine" \(2\)/);
    await expect(toolkit.executor.execute(toolCall("review.find_references", "{}"))).rejects.toThrow(
      /review.find_references: argument "symbol" must be a non-empty string/,
    );
    await expect(toolkit.executor.execute(toolCall("review.get_call_chain", "{}"))).rejects.toThrow(
      /review.get_call_chain: argument "symbol" must be a non-empty string/,
    );
    await expect(toolkit.executor.execute(toolCall("review.search_rule", "{}"))).rejects.toThrow(
      /review.search_rule: argument "query" must be a non-empty string/,
    );
    await expect(toolkit.executor.execute(toolCall("review.search_history", "{}"))).rejects.toThrow(
      /review.search_history: argument "query" must be a non-empty string/,
    );
  });

  it("exposes exactly the registry schemas on the toolkit (mountable tools)", () => {
    expect(toolkit.tools.map((tool) => tool.name)).toEqual([
      ...REVIEW_TOOL_ORDER,
    ]);
    expect(JSON.stringify(toolkit.tools)).toBe(JSON.stringify(buildReviewReadTools().map(toToolSchema)));
  });
});

describe("createToolExecutor with a scriptable context", () => {
  it("executes tools against the provided run context without touching the repository for get_diff", async () => {
    const executor = createToolExecutor(buildReviewReadTools(), {
      diff: SAMPLE_MR_CASE.diff,
      repo: (): Promise<never> => Promise.reject(new Error("repository must not be loaded")),
      resultBudgetChars: 8_000,
      rules: [],
      history: [],
      ledger: createInertContextLedger(),
    });
    const result = await executor.execute(toolCall("review.get_diff", "{}"));
    expect(result).toContain("MR unified diff:");
    expect(result).toContain("-        for (int i = 0; i < count; i++) {");
  });

  it("answers search_rule and search_history from the corpus carried by the run context", async () => {
    const executor = createToolExecutor(buildReviewReadTools(), {
      diff: SAMPLE_MR_CASE.diff,
      repo: (): Promise<never> => Promise.reject(new Error("repository must not be loaded")),
      resultBudgetChars: 8_000,
      rules: [{ id: "R001", title: "No null collections", text: "Return empty collections instead of null." }],
      history: [{ id: "H001", title: "Past off-by-one defect", text: "Loop bound defect fixed in 2023." }],
      ledger: createInertContextLedger(),
    });
    const ruleResult = await executor.execute(toolCall("review.search_rule", '{"query":"null"}'));
    expect(ruleResult).toContain('Rule search "null" (case-insensitive substring): 1 of 1 rule(s) matched');
    expect(ruleResult).toContain("[R001] No null collections");
    const historyResult = await executor.execute(toolCall("review.search_history", '{"query":"off-by-one"}'));
    expect(historyResult).toContain(
      'History search "off-by-one" (case-insensitive substring): 1 of 1 history record(s) matched',
    );
    expect(historyResult).toContain("[H001] Past off-by-one defect");
  });
});
