import { describe, expect, it } from "vitest";
import type { ClaudeCodeRunOutput } from "../../src/reference/contracts.js";
import {
  extractFindingsPayload,
  normalizeClaudeCodeRun,
  normalizeEntries,
  parseClaudeCodeStdout,
} from "../../src/reference/normalize.js";
import { claudeStdout, findingJson } from "./helpers.js";

/**
 * Claude Code 输出归一化（Ticket 13 验收）：有界失败容错——
 * stdout 层 / 载荷层 / 条目层逐级拦截留痕，合法部分照常保留，usage 恒记账。
 * 全部纯函数：fake stdout 字符串进、Finding[] + 拦截留痕出。
 */

function runOf(stdout: string): ClaudeCodeRunOutput {
  return { stdout, stderr: "", exitCode: 0, timedOut: false };
}

describe("parseClaudeCodeStdout", () => {
  it("完整合法 stdout：result/usage/轮数/成本/实际模型/权限拒绝逐字段映射", () => {
    const parse = parseClaudeCodeStdout(
      claudeStdout({
        findings: [findingJson("F001")],
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 3000,
        cacheWriteTokens: 500,
        numTurns: 4,
        totalCostUsd: 0.12,
        modelUsage: { "claude-sonnet-4-5": { costUSD: 0.12 } },
        permissionDenials: 2,
      }),
    );
    expect(parse.resultText).toBe(JSON.stringify({ findings: [findingJson("F001")] }));
    expect(parse.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 3000,
      cacheWriteTokens: 500,
    });
    expect(parse.numTurns).toBe(4);
    expect(parse.totalCostUsd).toBe(0.12);
    expect(parse.actualModels).toEqual(["claude-sonnet-4-5"]);
    expect(parse.permissionDenials).toBe(2);
    expect(parse.isError).toBe(false);
    expect(parse.notes).toEqual([]);
  });

  it("缓存字段为零时不携带可选字段（与 DeepSeekClient 记账风格一致）", () => {
    const parse = parseClaudeCodeStdout(
      claudeStdout({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    );
    expect(parse.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("is_error = true 传导（runner 层据此判失败）", () => {
    const parse = parseClaudeCodeStdout(claudeStdout({ isError: true, result: "api error" }));
    expect(parse.isError).toBe(true);
    expect(parse.resultText).toBe("api error");
  });

  it("非法 JSON：resultText 为 null、usage 记零、notes 留痕", () => {
    const parse = parseClaudeCodeStdout("this is not json at all");
    expect(parse.resultText).toBeNull();
    expect(parse.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(parse.numTurns).toBeNull();
    expect(parse.totalCostUsd).toBeNull();
    expect(parse.actualModels).toEqual([]);
    expect(parse.notes.join("; ")).toContain("stdout is not valid JSON");
  });

  it("stdout JSON 非对象（数组/字符串）：留痕拒绝", () => {
    expect(parseClaudeCodeStdout("[1, 2, 3]").notes).toContain("stdout JSON is not an object");
    expect(parseClaudeCodeStdout('"text"').notes).toContain("stdout JSON is not an object");
  });

  it("result 缺失或空白（max-turns 截断）：留痕 + 其余字段照常", () => {
    const parse = parseClaudeCodeStdout(claudeStdout({ result: "   " }));
    expect(parse.resultText).toBeNull();
    expect(parse.notes.join("; ")).toContain("no non-empty result text");
    expect(parse.usage.inputTokens).toBe(1000);
  });

  it("usage / num_turns / total_cost_usd 字段非法：按 0 / null 计并留痕", () => {
    const parse = parseClaudeCodeStdout(
      JSON.stringify({
        result: "ok",
        usage: { input_tokens: -5, output_tokens: "many" },
        num_turns: 1.5,
        total_cost_usd: "free",
      }),
    );
    expect(parse.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(parse.numTurns).toBeNull();
    expect(parse.totalCostUsd).toBeNull();
    expect(parse.notes.join("; ")).toContain("usage.input_tokens");
    expect(parse.notes.join("; ")).toContain("num_turns");
    expect(parse.notes.join("; ")).toContain("total_cost_usd");
  });

  it("modelUsage 缺失/非对象：实际模型记空数组", () => {
    expect(parseClaudeCodeStdout(JSON.stringify({ result: "ok" })).actualModels).toEqual([]);
  });
});

describe("extractFindingsPayload", () => {
  it("裸 JSON 对象直接提取", () => {
    const payload = extractFindingsPayload('{"findings": []}');
    expect(payload).toEqual({ findings: [] });
  });

  it("剥 ```json 围栏", () => {
    const payload = extractFindingsPayload('```json\n{"findings": []}\n```');
    expect(payload).toEqual({ findings: [] });
  });

  it("散文 + 首尾括号子串提取（方括号候选先行：取回 findings 数组）", () => {
    const payload = extractFindingsPayload(
      'Here is my review:\n{"findings": [{"id": "F001"}]}\nHope this helps.',
    );
    expect(payload).toEqual([{ id: "F001" }]);
  });

  it("散文包裹的裸对象（无方括号）走花括号候选", () => {
    const payload = extractFindingsPayload('Review: {"findings": null} — done.');
    expect(payload).toEqual({ findings: null });
  });

  it("裸数组子串提取", () => {
    const payload = extractFindingsPayload('Findings below:\n[{"id": "F001"}]\ndone');
    expect(payload).toEqual([{ id: "F001" }]);
  });

  it("空文本 / 无 JSON 载荷返回 null", () => {
    expect(extractFindingsPayload("")).toBeNull();
    expect(extractFindingsPayload("   ")).toBeNull();
    expect(extractFindingsPayload("no json here at all")).toBeNull();
  });
});

describe("normalizeEntries", () => {
  it("合法条目保留且恰取 10 个 Schema 字段（额外字段丢弃防下游污染）", () => {
    const candidate = { ...findingJson("F001"), extraField: "should be dropped" };
    const normalized = normalizeEntries([candidate]);
    expect(normalized.rejections).toEqual([]);
    expect(normalized.findings).toHaveLength(1);
    expect(normalized.findings[0]).toEqual(findingJson("F001"));
    expect(normalized.findings[0]).not.toHaveProperty("extraField");
  });

  it("单条形状非法：丢弃该条 + ENTRY_SCHEMA_INVALID 留痕（candidateIndex 对位）", () => {
    const normalized = normalizeEntries([
      findingJson("F001"),
      { ...findingJson("F002"), severity: "P9", line: 0 },
      findingJson("F003"),
    ]);
    expect(normalized.findings.map((f) => f.id)).toEqual(["F001", "F003"]);
    expect(normalized.rejections).toHaveLength(1);
    expect(normalized.rejections[0]).toMatchObject({
      candidateIndex: 1,
      stage: "ENTRY_SCHEMA_INVALID",
    });
    expect(normalized.rejections[0]?.reason).toContain("severity");
    expect(normalized.rejections[0]?.reason).toContain("line");
  });

  it("id 重复：保留首个、丢弃后来者 + DUPLICATE_ID 留痕", () => {
    const normalized = normalizeEntries([findingJson("F001"), findingJson("F001", { line: 25 })]);
    expect(normalized.findings).toHaveLength(1);
    expect(normalized.findings[0]?.line).toBe(20);
    expect(normalized.rejections[0]).toMatchObject({
      candidateIndex: 1,
      stage: "DUPLICATE_ID",
      reason: expect.stringContaining("F001"),
    });
  });

  it("空数组：零 finding 零拦截（clean MR 合法输出）", () => {
    const normalized = normalizeEntries([]);
    expect(normalized.findings).toEqual([]);
    expect(normalized.rejections).toEqual([]);
  });
});

describe("normalizeClaudeCodeRun（整体归一化）", () => {
  it("全部合法：status ok、零拦截", () => {
    const normalized = normalizeClaudeCodeRun(
      runOf(claudeStdout({ findings: [findingJson("F001"), findingJson("F002", { line: 21 })] })),
    );
    expect(normalized.status).toBe("ok");
    expect(normalized.findings.map((f) => f.id)).toEqual(["F001", "F002"]);
    expect(normalized.rejections).toEqual([]);
    expect(normalized.parse.usage.inputTokens).toBe(1000);
  });

  it("部分非法（有界失败）：status degraded、合法条目保留 + 逐条留痕", () => {
    const normalized = normalizeClaudeCodeRun(
      runOf(
        claudeStdout({
          findings: [
            findingJson("F001"),
            { ...findingJson("F002"), confidence: 9 },
            findingJson("F001"),
          ],
        }),
      ),
    );
    expect(normalized.status).toBe("degraded");
    expect(normalized.findings.map((f) => f.id)).toEqual(["F001"]);
    expect(normalized.rejections.map((r) => r.stage)).toEqual([
      "ENTRY_SCHEMA_INVALID",
      "DUPLICATE_ID",
    ]);
    // usage / 成本照常记账（钱已花，指标如实计入）
    expect(normalized.parse.usage.outputTokens).toBe(200);
    expect(normalized.parse.totalCostUsd).toBe(0.05);
  });

  it("stdout 非法 JSON：CLI_OUTPUT_UNPARSABLE、findings 空、usage 记零留痕", () => {
    const normalized = normalizeClaudeCodeRun(runOf("<html>gateway error</html>"));
    expect(normalized.status).toBe("degraded");
    expect(normalized.findings).toEqual([]);
    expect(normalized.rejections).toEqual([
      {
        candidateIndex: null,
        stage: "CLI_OUTPUT_UNPARSABLE",
        reason: expect.stringContaining("stdout is not valid JSON"),
      },
    ]);
  });

  it("result 无 JSON 载荷：FINDINGS_FIELD_INVALID", () => {
    const normalized = normalizeClaudeCodeRun(runOf(claudeStdout({ result: "I found nothing to report, sorry." })));
    expect(normalized.status).toBe("degraded");
    expect(normalized.rejections[0]).toMatchObject({ stage: "FINDINGS_FIELD_INVALID" });
  });

  it("载荷既非数组也无 findings 字段：FINDINGS_FIELD_INVALID", () => {
    const normalized = normalizeClaudeCodeRun(runOf(claudeStdout({ result: '{"summary": "looks fine"}' })));
    expect(normalized.rejections[0]).toMatchObject({ stage: "FINDINGS_FIELD_INVALID" });
  });
});
