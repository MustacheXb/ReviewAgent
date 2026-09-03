import { describe, expect, it } from "vitest";
import { applyUnifiedDiff } from "../../src/dataset/diff/apply-unified-diff.js";
import { BUGGY_SOURCES, FIXED_SOURCES, FIX_PATCH } from "../fixtures/defect-pair.js";

describe("applyUnifiedDiff（严格模式）", () => {
  it("应用最小修复补丁：buggy → fixed 全量一致", () => {
    const applied = applyUnifiedDiff(BUGGY_SOURCES, FIX_PATCH);
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }
    expect(applied.value.sources).toEqual(FIXED_SOURCES);
    expect(applied.value.deletedPaths).toEqual([]);
  });

  it("应用新文件创建补丁", () => {
    const creation = [
      "--- /dev/null",
      "+++ src/New.java",
      "@@ -0,0 +1,2 @@",
      "+package com.example;",
      "+",
    ].join("\n") + "\n";
    const applied = applyUnifiedDiff({}, creation);
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }
    expect(applied.value.sources["src/New.java"]).toBe("package com.example;\n\n");
  });

  it("应用删除文件补丁", () => {
    const deletion = [
      "--- src/Old.java",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-package com.example;",
    ].join("\n") + "\n";
    const applied = applyUnifiedDiff({ "src/Old.java": "package com.example;\n" }, deletion);
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }
    expect(applied.value.deletedPaths).toEqual(["src/Old.java"]);
    expect(applied.value.sources).toEqual({});
  });

  it("应用纯插入 hunk（@@ -2,0 +3,1 @@：在第 2 行后插入）", () => {
    const insertion = [
      "--- a/F.txt",
      "+++ b/F.txt",
      "@@ -2,0 +3,1 @@",
      "+inserted",
    ].join("\n") + "\n";
    const applied = applyUnifiedDiff({ "F.txt": "one\ntwo\nthree\n" }, insertion);
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }
    expect(applied.value.sources["F.txt"]).toBe("one\ntwo\ninserted\nthree\n");
  });

  it("保持 hunk 之外的尾部内容", () => {
    const patch = [
      "--- a/F.txt",
      "+++ b/F.txt",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      " three",
    ].join("\n") + "\n";
    const applied = applyUnifiedDiff({ "F.txt": "one\ntwo\nthree\nfour\n" }, patch);
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }
    expect(applied.value.sources["F.txt"]).toBe("one\nTWO\nthree\nfour\n");
  });

  it("处理文件末尾无换行的 diff（旧侧 EOF 无换行，新侧有）", () => {
    const patch = [
      "--- a/F.txt",
      "+++ b/F.txt",
      "@@ -1 +1 @@",
      "-old last",
      "\\ No newline at end of file",
      "+new last",
    ].join("\n") + "\n";
    const applied = applyUnifiedDiff({ "F.txt": "old last" }, patch);
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }
    expect(applied.value.sources["F.txt"]).toBe("new last\n");
  });

  it("处理双侧 EOF 均无换行的 diff", () => {
    const patch = [
      "--- a/F.txt",
      "+++ b/F.txt",
      "@@ -1 +1 @@",
      "-old last",
      "\\ No newline at end of file",
      "+new last",
      "\\ No newline at end of file",
    ].join("\n") + "\n";
    const applied = applyUnifiedDiff({ "F.txt": "old last" }, patch);
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }
    expect(applied.value.sources["F.txt"]).toBe("new last");
  });

  it("hunk 未触及文件末尾时沿用旧文件的无换行状态", () => {
    const patch = [
      "--- a/F.txt",
      "+++ b/F.txt",
      "@@ -1 +1 @@",
      "-old first",
      "+new first",
    ].join("\n") + "\n";
    const applied = applyUnifiedDiff({ "F.txt": "old first\nlast" }, patch);
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }
    expect(applied.value.sources["F.txt"]).toBe("new first\nlast");
  });

  it("context 行不匹配时显式报错", () => {
    const patch = [
      "--- a/F.txt",
      "+++ b/F.txt",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      " three",
    ].join("\n") + "\n";
    const applied = applyUnifiedDiff({ "F.txt": "one\nWRONG\nthree\n" }, patch);
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.error.message).toContain("不匹配");
    }
  });

  it("补丁文件不在快照中时显式报错", () => {
    const applied = applyUnifiedDiff({ "Other.txt": "x\n" }, FIX_PATCH);
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.error.message).toContain("不在源码快照中");
    }
  });

  it("hunk 起始行超出文件长度时显式报错", () => {
    const patch = [
      "--- a/F.txt",
      "+++ b/F.txt",
      "@@ -10,1 +10,1 @@",
      "-x",
      "+y",
    ].join("\n") + "\n";
    const applied = applyUnifiedDiff({ "F.txt": "one\ntwo\n" }, patch);
    expect(applied.ok).toBe(false);
  });

  it("diff 文本非法时显式报错", () => {
    const applied = applyUnifiedDiff({ "F.txt": "x\n" }, "garbage");
    expect(applied.ok).toBe(false);
  });
});
