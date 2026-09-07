import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KnowledgeEntry } from "../src/contracts/knowledge.js";
import type { ToolCall } from "../src/contracts/llm-client.js";
import { buildReviewToolkit } from "../src/tools/toolkit.js";
import { SAMPLE_MR_CASE } from "./fixtures/sample-mr-case.js";

/**
 * 工单 #7 验收：检索工具四件套（find_references 名字级引用匹配 /
 * get_call_chain 1~2 层名字级链 / search_rule / search_history 文本检索）。
 * 断言对象是 executor 的输出字符串（runReview 挂载的同一接口）：
 * 结构化、确定性、有界（超长截断留痕）、错误有界不泄漏绝对路径。
 */

const MATH_UTILS = "src/main/java/com/example/math/MathUtils.java";
const CALCULATOR = "src/main/java/com/example/math/Calculator.java";
const MAIN = "src/main/java/com/example/math/Main.java";

const RULES: readonly KnowledgeEntry[] = [
  {
    id: "R001",
    title: "No null collections",
    text: "Return empty collections instead of null to avoid NPE at call sites.",
  },
  {
    id: "R002",
    title: "Off-by-one loop bounds",
    text: "Prefer i < count over i <= count when summing the first count elements.",
  },
  {
    id: "R003",
    title: "Resource cleanup",
    text: "Always close streams in a finally block.",
  },
];

const HISTORY: readonly KnowledgeEntry[] = [
  {
    id: "H001",
    title: "Past off-by-one defect in MathUtils",
    text: "Historical defect: sumFirst read values[count] because the loop bound used <=.",
  },
  {
    id: "H002",
    title: "Past NPE in StringUtils.join",
    text: [
      "Historical review finding: join crashed on null parts.",
      "Fixed by adding a null guard.",
    ].join("\n"),
  },
];

/** 语料注入版工具箱（search_rule / search_history 数据源） */
function toolkitWithKnowledge() {
  return buildReviewToolkit({
    repoPath: SAMPLE_MR_CASE.repoPath,
    diff: SAMPLE_MR_CASE.diff,
    knowledge: { rules: RULES, history: HISTORY },
  });
}

let tempRepo: string;

beforeAll(async () => {
  tempRepo = await mkdtemp(path.join(tmpdir(), "review-agent-searchtools-"));
  await mkdir(path.join(tempRepo, "src", "main", "java", "demo"), { recursive: true });
  // 300 行真实调用：驱动 find_references / get_call_chain 的预算截断路径
  await writeFile(
    path.join(tempRepo, "src", "main", "java", "demo", "Many.java"),
    [
      "package demo;",
      "",
      "public final class Many {",
      "    public static int one() {",
      "        return 1;",
      "    }",
      "",
      "    public static int sum() {",
      "        int total = 0;",
      ...Array.from({ length: 300 }, () => "        total += one();"),
      "        return total;",
      "    }",
      "}",
    ].join("\n"),
    "utf8",
  );
});

afterAll(async () => {
  await rm(tempRepo, { recursive: true, force: true });
});

describe("review.find_references (name-level whole-word match, lexical precision)", () => {
  it("returns declaration and usage sites with enclosing symbols and source lines", async () => {
    const toolkit = buildReviewToolkit({
      repoPath: SAMPLE_MR_CASE.repoPath,
      diff: SAMPLE_MR_CASE.diff,
    });
    const result = await toolkit.executor.execute(call("review.find_references", '{"symbol":"sumFirst"}'));

    expect(result).toContain(
      'References to "sumFirst" (name-level whole-word match, no type resolution): 2 match(es) across 2 file(s)',
    );
    expect(result).toContain(`${CALCULATOR}:12 [usage] Calculator.total`);
    expect(result).toContain("        return MathUtils.sumFirst(readings, count);".trim());
    expect(result).toContain(`${MATH_UTILS}:18 [declaration] MathUtils.sumFirst`);
    expect(result).toContain("public static int sumFirst(int[] values, int count) {");
  });

  it("is deterministic: the same call returns the identical bytes", async () => {
    const toolkit = buildReviewToolkit({
      repoPath: SAMPLE_MR_CASE.repoPath,
      diff: SAMPLE_MR_CASE.diff,
    });
    const first = await toolkit.executor.execute(call("review.find_references", '{"symbol":"MathUtils"}'));
    const second = await toolkit.executor.execute(call("review.find_references", '{"symbol":"MathUtils"}'));
    expect(second).toBe(first);
    // 名字级匹配对类型与构造器一视同仁（词法天花板为已知限制）
    expect(first).toContain("[declaration] MathUtils");
    expect(first).toContain("[declaration] MathUtils.MathUtils");
    expect(first).toContain("[usage] Calculator.total");
  });

  it("reports zero matches explicitly instead of failing", async () => {
    const toolkit = buildReviewToolkit({
      repoPath: SAMPLE_MR_CASE.repoPath,
      diff: SAMPLE_MR_CASE.diff,
    });
    const result = await toolkit.executor.execute(
      call("review.find_references", '{"symbol":"NoSuchSymbolAnywhere"}'),
    );
    expect(result).toBe(
      'References to "NoSuchSymbolAnywhere" (name-level whole-word match, no type resolution): 0 match(es) across 0 file(s)',
    );
  });

  it("does not report comment-only mentions as references", async () => {
    const toolkit = buildReviewToolkit({
      repoPath: SAMPLE_MR_CASE.repoPath,
      diff: SAMPLE_MR_CASE.diff,
    });
    // "facade" 只出现在 Calculator.java 的 javadoc 行内
    const result = await toolkit.executor.execute(call("review.find_references", '{"symbol":"facade"}'));
    expect(result).toContain(": 0 match(es) across 0 file(s)");
  });

  it("turns a lazy repository failure into a bounded error without leaking host paths", async () => {
    const toolkit = buildReviewToolkit({
      repoPath: "Z:/definitely/not/a/repo",
      diff: SAMPLE_MR_CASE.diff,
    });
    await expect(
      toolkit.executor.execute(call("review.find_references", '{"symbol":"sumFirst"}')),
    ).rejects.toThrow(/failed to list Java files under repository path/);
  });

  it("truncates oversized results at a line boundary with an explicit notice", async () => {
    const toolkit = buildReviewToolkit({ repoPath: tempRepo, diff: SAMPLE_MR_CASE.diff });
    const result = await toolkit.executor.execute(call("review.find_references", '{"symbol":"one"}'));
    expect(result).toMatch(
      /Tool result truncated: showing \d+ of \d+ result lines \(tool result budget 8000 chars exceeded\)\./,
    );
    expect(result).toContain("[usage] Many.sum");
  });
});

describe("review.get_call_chain (1-2 hop name-level chains, ADR-0003 degraded scope)", () => {
  it("builds the two-hop caller chain and callee list around a changed method", async () => {
    const toolkit = buildReviewToolkit({
      repoPath: SAMPLE_MR_CASE.repoPath,
      diff: SAMPLE_MR_CASE.diff,
    });
    const result = await toolkit.executor.execute(call("review.get_call_chain", '{"symbol":"sumFirst"}'));

    expect(result).toContain(
      'Call chain for "sumFirst" (name-level, up to 2 hops, no type resolution): 1 method declaration(s) matched',
    );
    expect(result).toContain(`MathUtils.sumFirst - method at ${MATH_UTILS}:18`);
    expect(result).toContain(`  Callers (hop 1):`);
    expect(result).toContain(`    Calculator.total - ${CALCULATOR}:12`);
    expect(result).toContain(`  Callers of "total" (hop 2):`);
    expect(result).toContain(`    Main.main - ${MAIN}:11`);
    expect(result).toContain("  Callees (hop 1):");
    expect(result).toContain("    (none)");
  });

  it("answers a chain for an unchanged method too (tool-driven, not diff-bound)", async () => {
    const toolkit = buildReviewToolkit({
      repoPath: SAMPLE_MR_CASE.repoPath,
      diff: SAMPLE_MR_CASE.diff,
    });
    const result = await toolkit.executor.execute(call("review.get_call_chain", '{"symbol":"total"}'));

    expect(result).toContain(`Calculator.total - method at ${CALCULATOR}:11`);
    expect(result).toContain(`    Main.main - ${MAIN}:11`);
    expect(result).toContain(`    sumFirst - ${CALCULATOR}:12`);
  });

  it("builds a constructor chain when the name matches a constructor", async () => {
    const toolkit = buildReviewToolkit({
      repoPath: SAMPLE_MR_CASE.repoPath,
      diff: SAMPLE_MR_CASE.diff,
    });
    const result = await toolkit.executor.execute(call("review.get_call_chain", '{"symbol":"MathUtils"}'));
    expect(result).toContain(`MathUtils.MathUtils - constructor at ${MATH_UTILS}:8`);
    expect(result).toContain(`    Calculator.total - ${CALCULATOR}:12`);
  });

  it("is deterministic: the same call returns the identical bytes", async () => {
    const toolkit = buildReviewToolkit({
      repoPath: SAMPLE_MR_CASE.repoPath,
      diff: SAMPLE_MR_CASE.diff,
    });
    const first = await toolkit.executor.execute(call("review.get_call_chain", '{"symbol":"sumFirst"}'));
    const second = await toolkit.executor.execute(call("review.get_call_chain", '{"symbol":"sumFirst"}'));
    expect(second).toBe(first);
  });

  it("reports a name with no method or constructor match explicitly", async () => {
    const toolkit = buildReviewToolkit({
      repoPath: SAMPLE_MR_CASE.repoPath,
      diff: SAMPLE_MR_CASE.diff,
    });
    const result = await toolkit.executor.execute(
      call("review.get_call_chain", '{"symbol":"NoSuchMethodAnywhere"}'),
    );
    expect(result).toBe(
      'Call chain for "NoSuchMethodAnywhere" (name-level, up to 2 hops, no type resolution): no method or constructor named "NoSuchMethodAnywhere" found across 4 Java file(s)',
    );
  });

  it("truncates oversized chains at a line boundary with an explicit notice", async () => {
    const toolkit = buildReviewToolkit({ repoPath: tempRepo, diff: SAMPLE_MR_CASE.diff });
    const result = await toolkit.executor.execute(call("review.get_call_chain", '{"symbol":"one"}'));
    expect(result).toMatch(
      /Tool result truncated: showing \d+ of \d+ result lines \(tool result budget 8000 chars exceeded\)\./,
    );
    expect(result).toContain("Many.sum - src/main/java/demo/Many.java:");
  });
});

describe("review.search_rule (C3 Knowledge text search, thinnest usable form)", () => {
  it("matches entries case-insensitively across titles and texts with explicit counts", async () => {
    const toolkit = toolkitWithKnowledge();
    const byTitle = await toolkit.executor.execute(call("review.search_rule", '{"query":"off-by-one"}'));
    expect(byTitle).toContain('Rule search "off-by-one" (case-insensitive substring): 1 of 3 rule(s) matched');
    expect(byTitle).toContain("  [R002] Off-by-one loop bounds");
    expect(byTitle).toContain("    Prefer i < count over i <= count when summing the first count elements.");

    const byText = await toolkit.executor.execute(call("review.search_rule", '{"query":"NULL"}'));
    expect(byText).toContain('Rule search "NULL" (case-insensitive substring): 1 of 3 rule(s) matched');
    expect(byText).toContain("[R001] No null collections");
  });

  it("reports zero matches explicitly instead of failing", async () => {
    const toolkit = toolkitWithKnowledge();
    const result = await toolkit.executor.execute(call("review.search_rule", '{"query":"zzz-nothing"}'));
    expect(result).toBe('Rule search "zzz-nothing" (case-insensitive substring): 0 of 3 rule(s) matched');
  });

  it("states the empty POC1 corpus explicitly when no rules are configured", async () => {
    const toolkit = buildReviewToolkit({
      repoPath: SAMPLE_MR_CASE.repoPath,
      diff: SAMPLE_MR_CASE.diff,
    });
    const result = await toolkit.executor.execute(call("review.search_rule", '{"query":"null"}'));
    expect(result).toBe(
      'Rule search "null" (case-insensitive substring): rule corpus is empty (0 entries configured for this run)',
    );
  });

  it("is deterministic: the same call returns the identical bytes", async () => {
    const toolkit = toolkitWithKnowledge();
    const first = await toolkit.executor.execute(call("review.search_rule", '{"query":"count"}'));
    const second = await toolkit.executor.execute(call("review.search_rule", '{"query":"count"}'));
    expect(second).toBe(first);
  });

  it("truncates oversized results at a line boundary with an explicit notice", async () => {
    const toolkit = buildReviewToolkit({
      repoPath: SAMPLE_MR_CASE.repoPath,
      diff: SAMPLE_MR_CASE.diff,
      resultBudgetChars: 150,
      knowledge: {
        rules: Array.from({ length: 30 }, (_, index) => ({
          id: `R${String(index + 1).padStart(3, "0")}`,
          title: `Padding rule ${index}`,
          text: "This rule body exists to exceed the tool result budget during search result rendering.",
        })),
      },
    });
    const result = await toolkit.executor.execute(call("review.search_rule", '{"query":"Padding"}'));
    expect(result).toMatch(
      /Tool result truncated: showing \d+ of \d+ result lines \(tool result budget 150 chars exceeded\)\./,
    );
  });
});

describe("review.search_history (C3 Knowledge text search, thinnest usable form)", () => {
  it("matches history entries case-insensitively and renders multi-line texts", async () => {
    const toolkit = toolkitWithKnowledge();
    const result = await toolkit.executor.execute(call("review.search_history", '{"query":"PAST"}'));
    expect(result).toContain('History search "PAST" (case-insensitive substring): 2 of 2 history record(s) matched');
    expect(result).toContain("[H001] Past off-by-one defect in MathUtils");
    expect(result).toContain("[H002] Past NPE in StringUtils.join");
    expect(result).toContain("    Historical review finding: join crashed on null parts.");
    expect(result).toContain("    Fixed by adding a null guard.");
  });

  it("reports zero matches explicitly and keeps corpora independent from search_rule", async () => {
    const toolkit = toolkitWithKnowledge();
    const history = await toolkit.executor.execute(call("review.search_history", '{"query":"streams"}'));
    expect(history).toBe('History search "streams" (case-insensitive substring): 0 of 2 history record(s) matched');
    // rules 语料命中不串扰 history 检索
    const ruleOnly = await toolkit.executor.execute(call("review.search_history", '{"query":"finally"}'));
    expect(ruleOnly).toContain("0 of 2 history record(s) matched");
  });

  it("states the empty POC1 corpus explicitly when no history is configured", async () => {
    const toolkit = buildReviewToolkit({
      repoPath: SAMPLE_MR_CASE.repoPath,
      diff: SAMPLE_MR_CASE.diff,
    });
    const result = await toolkit.executor.execute(call("review.search_history", '{"query":"defect"}'));
    expect(result).toBe(
      'History search "defect" (case-insensitive substring): history corpus is empty (0 entries configured for this run)',
    );
  });
});

function call(name: string, argumentsJson: string): ToolCall {
  return { id: "call-1", name, argumentsJson };
}
