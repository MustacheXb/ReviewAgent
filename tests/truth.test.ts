import { describe, expect, it } from "vitest";
import { buildTruthLocations } from "../src/dataset/truth.js";

describe("buildTruthLocations（真值行位与性质）", () => {
  it("含 remove 行的变更段：行位 = remove 行旧侧行号", () => {
    const patch = [
      "--- a/F.txt",
      "+++ b/F.txt",
      "@@ -1,2 +1,2 @@",
      "-old line 1",
      "+new line 1",
      " line 2",
    ].join("\n") + "\n";
    const result = buildTruthLocations(patch);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toEqual([
      { file: "F.txt", lineStart: 1, lineEnd: 1, defectNature: "CORRECTNESS" },
    ]);
  });

  it("单 hunk 多变更段：按段产出多个真值位置（保持顺序）", () => {
    const patch = [
      "--- a/F.txt",
      "+++ b/F.txt",
      "@@ -1,4 +1,4 @@",
      "-a",
      "+x",
      " c",
      "-b",
      "+y",
      " d",
    ].join("\n") + "\n";
    const result = buildTruthLocations(patch);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toEqual([
      { file: "F.txt", lineStart: 1, lineEnd: 1, defectNature: "CORRECTNESS" },
      { file: "F.txt", lineStart: 3, lineEnd: 3, defectNature: "CORRECTNESS" },
    ]);
  });

  it("混合段（remove+add 交错）：行位覆盖段内全部 remove 行", () => {
    const patch = [
      "--- a/F.txt",
      "+++ b/F.txt",
      "@@ -2,4 +2,4 @@",
      " ctx1",
      "-a",
      "+x",
      "-b",
      "+y",
      " ctx2",
    ].join("\n") + "\n";
    const result = buildTruthLocations(patch);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toEqual([
      { file: "F.txt", lineStart: 3, lineEnd: 4, defectNature: "CORRECTNESS" },
    ]);
  });

  it("纯新增段（段后有 context）：锚定插入点后的第一条现存 buggy 行", () => {
    const patch = [
      "--- a/F.txt",
      "+++ b/F.txt",
      "@@ -1,2 +1,3 @@",
      "+inserted",
      " one",
      " two",
    ].join("\n") + "\n";
    const result = buildTruthLocations(patch);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toEqual([
      { file: "F.txt", lineStart: 1, lineEnd: 1, defectNature: "CORRECTNESS" },
    ]);
  });

  it("纯新增段在 hunk 末尾（文件末尾追加）：锚定插入点前的最后一行", () => {
    const patch = [
      "--- a/F.txt",
      "+++ b/F.txt",
      "@@ -3,1 +3,2 @@",
      " three",
      "+appended",
    ].join("\n") + "\n";
    const result = buildTruthLocations(patch);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toEqual([
      { file: "F.txt", lineStart: 3, lineEnd: 3, defectNature: "CORRECTNESS" },
    ]);
  });

  it("修复新建文件：真值为 (0,0)（buggy 中该文件不存在）", () => {
    const patch = [
      "--- /dev/null",
      "+++ b/New.java",
      "@@ -0,0 +1,2 @@",
      "+package com.example;",
      "+",
    ].join("\n") + "\n";
    const result = buildTruthLocations(patch);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toEqual([
      { file: "New.java", lineStart: 0, lineEnd: 0, defectNature: "CORRECTNESS" },
    ]);
  });

  it("修复删除文件：真值覆盖 buggy 文件全部行", () => {
    const patch = [
      "--- a/Gone.txt",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
      "-one",
      "-two",
      "-three",
    ].join("\n") + "\n";
    const result = buildTruthLocations(patch);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toEqual([
      { file: "Gone.txt", lineStart: 1, lineEnd: 3, defectNature: "CORRECTNESS" },
    ]);
  });

  it("按文件读取缺陷性质，未标注文件用缺省 CORRECTNESS", () => {
    const patch = [
      "--- a/F.txt",
      "+++ b/F.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "--- a/G.txt",
      "+++ b/G.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n") + "\n";
    const result = buildTruthLocations(patch, { "F.txt": "SECURITY" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.map((l) => l.defectNature)).toEqual(["SECURITY", "CORRECTNESS"]);
  });

  it("非法性质显式报错", () => {
    const patch = "--- a/F.txt\n+++ b/F.txt\n@@ -1 +1 @@\n-old\n+new\n";
    const result = buildTruthLocations(patch, { "F.txt": "BOGUS" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_NATURE");
    }
  });

  it("补丁不可解析时显式报错", () => {
    expect(buildTruthLocations("garbage").ok).toBe(false);
  });
});
