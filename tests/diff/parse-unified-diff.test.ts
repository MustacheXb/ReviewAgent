import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../../src/dataset/diff/parse-unified-diff.js";
import { FIX_PATCH } from "../fixtures/defect-pair.js";

describe("parseUnifiedDiff", () => {
  it("解析多文件 plain 风格 diff 并给出结构化 hunk", () => {
    const result = parseUnifiedDiff(FIX_PATCH);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const files = result.value;
    expect(files).toHaveLength(2);
    expect(files[0]?.oldPath).toBe("src/main/java/com/example/Parser.java");
    expect(files[0]?.newPath).toBe("src/main/java/com/example/Parser.java");
    expect(files[0]?.hunks).toHaveLength(1);
    const hunk = files[0]?.hunks[0];
    expect(hunk?.oldStart).toBe(2);
    expect(hunk?.oldCount).toBe(6);
    expect(hunk?.newStart).toBe(2);
    expect(hunk?.newCount).toBe(9);
    const addCount = hunk?.lines.filter((l) => l.type === "add").length ?? 0;
    const removeCount = hunk?.lines.filter((l) => l.type === "remove").length ?? 0;
    expect(addCount).toBe(3);
    expect(removeCount).toBe(0);
  });

  it("剥 git 风格头与前缀噪音（diff --git / index / mode）", () => {
    const gitStyle = [
      "diff --git a/Foo.java b/Foo.java",
      "index 1234567..89abcde 100644",
      "--- a/Foo.java",
      "+++ b/Foo.java",
      "@@ -1,3 +1,3 @@",
      " line1",
      "-line2",
      "+line2 fixed",
      " line3",
    ].join("\n");
    const result = parseUnifiedDiff(gitStyle);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value[0]?.oldPath).toBe("Foo.java");
    expect(result.value[0]?.newPath).toBe("Foo.java");
  });

  it("解析 no-newline 标记（旧侧末行无换行）", () => {
    const noNewline = [
      "--- a/Foo.java",
      "+++ b/Foo.java",
      "@@ -1 +1 @@",
      "-old last",
      "\\ No newline at end of file",
      "+new last",
    ].join("\n");
    const result = parseUnifiedDiff(noNewline);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const file = result.value[0]!;
    expect(file.oldNoNewlineAtEnd).toBe(true);
    expect(file.newNoNewlineAtEnd).toBe(false);
    const removed = file.hunks[0]?.lines.find((l) => l.type === "remove");
    expect(removed?.noNewlineAtEnd).toBe(true);
  });

  it("解析 no-newline 标记出现在 hunk 体中部（旧侧 EOF 无换行，新侧续行）", () => {
    const midMarker = [
      "--- a/Foo.java",
      "+++ b/Foo.java",
      "@@ -1 +1,2 @@",
      "-old last",
      "\\ No newline at end of file",
      "+old last",
      "+appended",
    ].join("\n");
    const result = parseUnifiedDiff(midMarker);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const file = result.value[0]!;
    expect(file.oldNoNewlineAtEnd).toBe(true);
    expect(file.newNoNewlineAtEnd).toBe(false);
  });

  it("解析新文件创建（--- /dev/null，旧侧计数 0）", () => {
    const creation = [
      "--- /dev/null",
      "+++ b/NewFile.java",
      "@@ -0,0 +1,2 @@",
      "+package com.example;",
      "+",
    ].join("\n");
    const result = parseUnifiedDiff(creation);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value[0]?.oldPath).toBeNull();
    expect(result.value[0]?.newPath).toBe("NewFile.java");
  });

  it("解析文件删除（+++ /dev/null，新侧计数 0）", () => {
    const deletion = [
      "--- a/OldFile.java",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-package com.example;",
      "-",
    ].join("\n");
    const result = parseUnifiedDiff(deletion);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value[0]?.oldPath).toBe("OldFile.java");
    expect(result.value[0]?.newPath).toBeNull();
  });

  it("拒绝空 diff", () => {
    expect(parseUnifiedDiff("").ok).toBe(false);
    expect(parseUnifiedDiff("   \n").ok).toBe(false);
  });

  it("拒绝 --- 之后缺少 +++ 的结构错误", () => {
    const broken = "--- a/Foo.java\n@@ -1 +1 @@\n-x\n+y\n";
    const result = parseUnifiedDiff(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("+++");
    }
  });

  it("拒绝非法 hunk 头", () => {
    const broken = "--- a/F.java\n+++ b/F.java\n@@ -x,y +1,1 @@\n-x\n+y\n";
    const result = parseUnifiedDiff(broken);
    expect(result.ok).toBe(false);
  });

  it("拒绝 hunk 体行数与头部声明不符（体过短）", () => {
    const result = parseUnifiedDiff("--- a/F.java\n+++ b/F.java\n@@ -1,3 +1,3 @@\n a\n-b\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("不完整");
    }
  });

  it("拒绝 hunk 体中的无法识别行", () => {
    const broken = "--- a/F.java\n+++ b/F.java\n@@ -1 +1 @@\n-x\ngarbage line\n+y\n";
    const result = parseUnifiedDiff(broken);
    expect(result.ok).toBe(false);
  });

  it("拒绝二进制文件补丁", () => {
    const binary = [
      "diff --git a/logo.png b/logo.png",
      "Binary files a/logo.png and b/logo.png differ",
    ].join("\n");
    expect(parseUnifiedDiff(binary).ok).toBe(false);
  });

  it("拒绝纯重命名补丁", () => {
    const rename = [
      "diff --git a/A.java b/B.java",
      "similarity index 100%",
      "rename from A.java",
      "rename to B.java",
    ].join("\n");
    expect(parseUnifiedDiff(rename).ok).toBe(false);
  });

  it("拒绝新旧路径均为 /dev/null", () => {
    const broken = "--- /dev/null\n+++ /dev/null\n@@ -0,0 +0,0 @@\n";
    expect(parseUnifiedDiff(broken).ok).toBe(false);
  });

  it("拒绝创建文件却声明旧侧行号的补丁", () => {
    const broken = "--- /dev/null\n+++ b/New.java\n@@ -1,1 +1,1 @@\n-x\n+y\n";
    expect(parseUnifiedDiff(broken).ok).toBe(false);
  });

  it("拒绝 hunk 重叠（旧侧）", () => {
    const overlap = [
      "--- a/F.java",
      "+++ b/F.java",
      "@@ -1,3 +1,3 @@",
      " a",
      "-b",
      "+B",
      " c",
      "@@ -2,2 +2,2 @@",
      " b",
      "-c",
      "+C",
    ].join("\n");
    const result = parseUnifiedDiff(overlap);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("重叠");
    }
  });

  it("拒绝不以文件头开头的输入", () => {
    const broken = "random leading text\n--- a/F.java\n+++ b/F.java\n";
    expect(parseUnifiedDiff(broken).ok).toBe(false);
  });
});
