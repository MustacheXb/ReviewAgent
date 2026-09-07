import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolCall } from "../src/contracts/llm-client.js";
import { buildReviewToolkit } from "../src/tools/toolkit.js";
import { SAMPLE_MR_CASE } from "./fixtures/sample-mr-case.js";

/**
 * 工单 #6 验收：读取工具三件套（get_symbol 签名级 / get_file 区间读取 / get_diff）。
 * 断言对象是 executor 的输出字符串（runReview 挂载的同一接口）：
 * 结构化、确定性、有界（超长截断留痕）。
 */

const MATH_UTILS = "src/main/java/com/example/math/MathUtils.java";

let tempRepo: string;

beforeAll(async () => {
  tempRepo = await mkdtemp(path.join(tmpdir(), "review-agent-readtools-"));
  await mkdir(path.join(tempRepo, "src", "main", "java", "demo"), { recursive: true });
  await writeFile(
    path.join(tempRepo, "src", "main", "java", "demo", "Empty.java"),
    "",
    "utf8",
  );
  await writeFile(
    path.join(tempRepo, "src", "main", "java", "demo", "Long.java"),
    [
      "package demo;",
      "",
      "public final class Long {",
      ...Array.from({ length: 400 }, (_, index) => `    int field${String(index).padStart(3, "0")} = ${index}; // padding to exceed the default tool result budget`),
      "}",
    ].join("\n"),
    "utf8",
  );
});

afterAll(async () => {
  await rm(tempRepo, { recursive: true, force: true });
});

describe("review.get_symbol (signature level, tree-sitter zero-build)", () => {
  const toolkit = buildReviewToolkit({
    repoPath: SAMPLE_MR_CASE.repoPath,
    diff: SAMPLE_MR_CASE.diff,
  });

  it("returns the signature of a method symbol without its body", async () => {
    const result = await toolkit.executor.execute(
      call("review.get_symbol", '{"symbol":"sumFirst"}'),
    );
    expect(result).toContain('Symbol "sumFirst": 1 match(es) across 4 Java file(s)');
    expect(result).toContain(`${MATH_UTILS} (package com.example.math)`);
    expect(result).toMatch(/L\d+ public static int sumFirst\(int\[\] values, int count\)/);
    expect(result).not.toContain("int sum = 0;");
  });

  it("returns a type match with its members (still signature level)", async () => {
    const result = await toolkit.executor.execute(
      call("review.get_symbol", '{"symbol":"Calculator"}'),
    );
    expect(result).toContain("public final class Calculator");
    expect(result).toContain("public int total(int[] readings, int count)");
    expect(result).not.toContain("return MathUtils.sumFirst(readings, count);");
  });

  it("reports zero matches explicitly instead of failing", async () => {
    const result = await toolkit.executor.execute(
      call("review.get_symbol", '{"symbol":"NoSuchSymbolAnywhere"}'),
    );
    expect(result).toBe('Symbol "NoSuchSymbolAnywhere": 0 match(es) across 4 Java file(s)');
  });

  it("is deterministic: the same call returns the identical bytes", async () => {
    const first = await toolkit.executor.execute(call("review.get_symbol", '{"symbol":"MathUtils"}'));
    const second = await toolkit.executor.execute(call("review.get_symbol", '{"symbol":"MathUtils"}'));
    expect(second).toBe(first);
    expect(first).toContain("private MathUtils()");
  });
});

describe("review.get_file (range read from the repository snapshot)", () => {
  const toolkit = buildReviewToolkit({
    repoPath: SAMPLE_MR_CASE.repoPath,
    diff: SAMPLE_MR_CASE.diff,
  });

  it("reads a line range with stable 1-based line numbers", async () => {
    const result = await toolkit.executor.execute(
      call("review.get_file", `{"path":"${MATH_UTILS}","startLine":15,"endLine":22}`),
    );
    expect(result).toContain(`File: ${MATH_UTILS}`);
    expect(result).toContain("Lines 15-22 of 25");
    expect(result).toContain("18 |     public static int sumFirst(int[] values, int count) {");
    expect(result).toContain("22 |         }");
    expect(result).not.toContain("23 | ");
  });

  it("reads the whole file when no range is given", async () => {
    const result = await toolkit.executor.execute(
      call("review.get_file", '{"path":"src/main/java/com/example/math/Main.java"}'),
    );
    expect(result).toContain("Lines 1-13 of 13");
    expect(result).toContain(" 1 | package com.example.math;");
    expect(result).toContain("13 | }");
  });

  it("clamps an end line beyond EOF with an explicit note", async () => {
    const result = await toolkit.executor.execute(
      call("review.get_file", `{"path":"${MATH_UTILS}","startLine":20,"endLine":999}`),
    );
    expect(result).toContain("Lines 20-25 of 25 (requested end line 999 clamped to end of file)");
    expect(result).toContain("25 | }");
  });

  it("rejects a start line beyond EOF with a bounded explicit error", async () => {
    await expect(
      toolkit.executor.execute(call("review.get_file", `{"path":"${MATH_UTILS}","startLine":999}`)),
    ).rejects.toThrow(/requested start line 999 is beyond end of file .* \(25 lines\)/);
  });

  it("rejects files outside the snapshot and path escapes without leaking absolute paths", async () => {
    await expect(
      toolkit.executor.execute(call("review.get_file", '{"path":"src/Nope.java"}')),
    ).rejects.toThrow(/file "src\/Nope\.java" cannot be read from the repository snapshot/);
    await expect(
      toolkit.executor.execute(call("review.get_file", '{"path":"../../outside.txt"}')),
    ).rejects.toThrow(/must stay inside the repository snapshot/);
    await expect(
      toolkit.executor.execute(call("review.get_file", '{"path":"C:/Windows/win.ini"}')),
    ).rejects.toThrow(/must be repository-relative/);
  });

  it("normalizes backslash paths to repository-relative POSIX paths", async () => {
    const result = await toolkit.executor.execute(
      call("review.get_file", '{"path":"src\\\\main\\\\java\\\\com\\\\example\\\\math\\\\Main.java"}'),
    );
    expect(result).toContain("File: src/main/java/com/example/math/Main.java");
  });

  it("reports an empty file as zero lines", async () => {
    const tempToolkit = buildReviewToolkit({ repoPath: tempRepo, diff: SAMPLE_MR_CASE.diff });
    const result = await tempToolkit.executor.execute(
      call("review.get_file", '{"path":"src/main/java/demo/Empty.java"}'),
    );
    expect(result).toContain("Lines 0-0 of 0 (empty file)");
  });

  it("truncates oversized results at a line boundary with an explicit notice", async () => {
    const tempToolkit = buildReviewToolkit({ repoPath: tempRepo, diff: SAMPLE_MR_CASE.diff });
    const result = await tempToolkit.executor.execute(
      call("review.get_file", '{"path":"src/main/java/demo/Long.java"}'),
    );
    expect(result).toMatch(
      /Tool result truncated: showing \d+ of \d+ result lines \(tool result budget 8000 chars exceeded\); request a narrower range with startLine\/endLine\./,
    );
    expect(result).toContain("File: src/main/java/demo/Long.java");
  });
});

describe("review.get_diff", () => {
  const toolkit = buildReviewToolkit({
    repoPath: SAMPLE_MR_CASE.repoPath,
    diff: SAMPLE_MR_CASE.diff,
  });

  it("returns the MR unified diff verbatim", async () => {
    const result = await toolkit.executor.execute(call("review.get_diff", "{}"));
    expect(result).toContain("MR unified diff:");
    expect(result).toContain("+        for (int i = 0; i <= count; i++) {");
    expect(result).not.toMatch(/Tool result truncated/);
  });

  it("truncates oversized diffs with an explicit notice", async () => {
    const longDiff = SAMPLE_MR_CASE.diff + "\n" + Array.from({ length: 400 }, (_, i) => `// padding line ${i}`).join("\n");
    const smallBudgetToolkit = buildReviewToolkit({
      repoPath: SAMPLE_MR_CASE.repoPath,
      diff: longDiff,
      resultBudgetChars: 500,
    });
    const result = await smallBudgetToolkit.executor.execute(call("review.get_diff", "{}"));
    expect(result).toMatch(/Tool result truncated: showing \d+ of \d+ diff lines \(tool result budget 500 chars exceeded\)\./);
  });
});

function call(name: string, argumentsJson: string): ToolCall {
  return { id: "call-1", name, argumentsJson };
}
