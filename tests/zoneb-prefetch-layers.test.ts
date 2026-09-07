import { describe, expect, it } from "vitest";
import { resolvePrefetchBudgets } from "../src/contracts/prefetch.js";
import { buildPrefetchContext } from "../src/zoneb/prefetch.js";
import { SAMPLE_MR_CASE } from "./fixtures/sample-mr-case.js";

/**
 * 工单 #4 验收标准（config B 确定性预取管线）：
 * 预取顺序符合固定管线 Diff → Symbol → Reference → Call Chain；
 * 同一仓库 + 同一 diff → 字节级可复现的注入内容；预算超限显式留痕。
 */
describe("buildPrefetchContext — deterministic prefetch pipeline", () => {
  const INPUT = {
    repoPath: SAMPLE_MR_CASE.repoPath,
    diff: SAMPLE_MR_CASE.diff,
    budgets: resolvePrefetchBudgets(undefined),
  };

  it("emits Zone B plus the three pipeline layers in fixed order", async () => {
    const context = await buildPrefetchContext(INPUT);

    expect(context.zoneBMessage.role).toBe("user");
    expect(context.zoneBMessage.content).toContain("Repository context (Zone B)");
    expect(context.layerMessages).toHaveLength(3);
    const [symbol, reference, callChain] = context.layerMessages;
    expect(symbol?.content).toContain("Prefetched context (1 of 3) - Symbol layer.");
    expect(reference?.content).toContain("Prefetched context (2 of 3) - Reference layer.");
    expect(callChain?.content).toContain("Prefetched context (3 of 3) - Call chain layer.");
    // 每层都自述固定管线（Diff -> Symbol -> Reference -> Call Chain）
    for (const message of context.layerMessages) {
      expect(message.content).toContain("Deterministic prefetch pipeline: Diff -> Symbol -> Reference -> Call Chain.");
      expect(message.role).toBe("user");
    }
  });

  it("records the layer accounting in pipeline order (zone-b, symbol, reference, call-chain)", async () => {
    const context = await buildPrefetchContext(INPUT);

    expect(context.records.map((record) => record.layer)).toEqual([
      "zone-b",
      "symbol",
      "reference",
      "call-chain",
    ]);
    for (const record of context.records) {
      expect(record.truncated).toBe(false);
      expect(record.shownEntries).toBe(record.totalEntries);
      expect(record.contentChars).toBeGreaterThan(0);
    }
  });

  it("prefetches signature-level changed symbols (Symbol layer)", async () => {
    const context = await buildPrefetchContext(INPUT);
    const symbolLayer = context.layerMessages[0]?.content ?? "";

    expect(symbolLayer).toContain("src/main/java/com/example/math/MathUtils.java (changed lines: 17-23)");
    expect(symbolLayer).toContain("public static int sumFirst(int[] values, int count)");
    expect(symbolLayer).toContain("public final class MathUtils");
    expect(symbolLayer).not.toContain("sum += values[i]");
  });

  it("prefetches name-level references across the whole repository (Reference layer)", async () => {
    const context = await buildPrefetchContext(INPUT);
    const referenceLayer = context.layerMessages[1]?.content ?? "";

    expect(referenceLayer).toContain('Symbol "sumFirst": 2 match(es)');
    expect(referenceLayer).toContain(
      "src/main/java/com/example/math/Calculator.java:12:         return MathUtils.sumFirst(readings, count);",
    );
    expect(referenceLayer).toContain(
      "src/main/java/com/example/math/MathUtils.java:18:     public static int sumFirst(int[] values, int count) {",
    );
  });

  it("prefetches 1-2 hop name-level call chains around changed methods (Call Chain layer)", async () => {
    const context = await buildPrefetchContext(INPUT);
    const callChainLayer = context.layerMessages[2]?.content ?? "";

    expect(callChainLayer).toContain(
      "MathUtils.sumFirst - method at src/main/java/com/example/math/MathUtils.java:18",
    );
    expect(callChainLayer).toContain(
      "Calculator.total - src/main/java/com/example/math/Calculator.java:12",
    );
    expect(callChainLayer).toContain('Callers of "total" (hop 2):');
    expect(callChainLayer).toContain("Main.main - src/main/java/com/example/math/Main.java:11");
  });

  it("is byte-reproducible: the same repository and diff produce identical injection messages", async () => {
    const first = await buildPrefetchContext(INPUT);
    const second = await buildPrefetchContext(INPUT);

    expect(second.zoneBMessage.content).toBe(first.zoneBMessage.content);
    expect(second.layerMessages.map((message) => message.content)).toEqual(
      first.layerMessages.map((message) => message.content),
    );
    expect(second.records).toEqual(first.records);
  });

  it("truncates layers with explicit notices when budgets are exceeded (no silent drops)", async () => {
    const context = await buildPrefetchContext({
      ...INPUT,
      budgets: {
        zoneBBudgetChars: 700,
        symbolLayerBudgetChars: 150,
        referenceLayerBudgetChars: 150,
        callChainLayerBudgetChars: 150,
      },
    });

    for (const record of context.records) {
      expect(record.truncated).toBe(true);
      expect(record.shownEntries).toBeLessThan(record.totalEntries);
    }
    expect(context.zoneBMessage.content).toMatch(
      /truncated: showing \d+ of \d+ .+ \(zone B (repo-map|package-structure|symbol-index) budget \d+ chars exceeded\)/,
    );
    const [symbol, reference, callChain] = context.layerMessages;
    expect(symbol?.content).toContain("Symbol layer truncated: showing 0 of 1 file entries (budget 150 chars exceeded).");
    expect(reference?.content).toContain("Reference layer truncated: showing 0 of 1 symbol entries (budget 150 chars exceeded).");
    expect(callChain?.content).toContain("Call chain layer truncated: showing 0 of 1 chain entries (budget 150 chars exceeded).");
  });

  it("fails fast with a clear error when the repository path does not exist", async () => {
    await expect(
      buildPrefetchContext({
        repoPath: "Z:/definitely/not/a/repo",
        diff: SAMPLE_MR_CASE.diff,
        budgets: resolvePrefetchBudgets(undefined),
      }),
    ).rejects.toThrow(/failed to list Java files under repository path/);
  });

  it("fails fast when the diff carries no parsable file headers", async () => {
    await expect(
      buildPrefetchContext({
        repoPath: SAMPLE_MR_CASE.repoPath,
        diff: "not a diff",
        budgets: resolvePrefetchBudgets(undefined),
      }),
    ).rejects.toThrow(/no parsable file headers/);
  });
});
