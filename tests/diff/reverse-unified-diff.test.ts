import { describe, expect, it } from "vitest";
import { reverseUnifiedDiff } from "../../src/dataset/diff/reverse-unified-diff.js";
import { applyUnifiedDiff } from "../../src/dataset/diff/apply-unified-diff.js";
import { parseUnifiedDiff } from "../../src/dataset/diff/parse-unified-diff.js";
import { BUGGY_SOURCES, FIXED_SOURCES, FIX_PATCH } from "../fixtures/defect-pair.js";

describe("reverseUnifiedDiff（逆补丁核心）", () => {
  it("逆 diff 应用于修复后版本得到历史 buggy 版本（逆补丁法语义）", () => {
    const reversed = reverseUnifiedDiff(FIX_PATCH);
    expect(reversed.ok).toBe(true);
    if (!reversed.ok) {
      return;
    }
    const applied = applyUnifiedDiff(FIXED_SOURCES, reversed.value);
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }
    expect(applied.value.deletedPaths).toEqual([]);
    expect(applied.value.sources).toEqual(BUGGY_SOURCES);
  });

  it("正 diff 应用于 buggy 版本得到修复后版本（对照组）", () => {
    const applied = applyUnifiedDiff(BUGGY_SOURCES, FIX_PATCH);
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }
    expect(applied.value.sources).toEqual(FIXED_SOURCES);
  });

  it("逆 diff 的 hunk 范围与前缀正确互换", () => {
    const reversed = reverseUnifiedDiff(FIX_PATCH);
    expect(reversed.ok).toBe(true);
    if (!reversed.ok) {
      return;
    }
    const parsed = parseUnifiedDiff(reversed.value);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const parserHunk = parsed.value[0]?.hunks[0];
    expect(parserHunk?.oldStart).toBe(2);
    expect(parserHunk?.oldCount).toBe(9); // 原新侧
    expect(parserHunk?.newStart).toBe(2);
    expect(parserHunk?.newCount).toBe(6); // 原旧侧
    const adds = parserHunk?.lines.filter((l) => l.type === "add") ?? [];
    const removes = parserHunk?.lines.filter((l) => l.type === "remove") ?? [];
    expect(adds).toHaveLength(0); // 原补丁的 add 行在逆 diff 中变 remove
    expect(removes).toHaveLength(3); // 原纯新增的 3 行（null 防御）在逆 diff 中成为待删除
  });

  it("逆 diff 自身是可解析且可再逆的（结构闭合）", () => {
    const reversed = reverseUnifiedDiff(FIX_PATCH);
    expect(reversed.ok).toBe(true);
    if (!reversed.ok) {
      return;
    }
    const doubleReversed = reverseUnifiedDiff(reversed.value);
    expect(doubleReversed.ok).toBe(true);
    if (!doubleReversed.ok) {
      return;
    }
    const backToBuggy = applyUnifiedDiff(BUGGY_SOURCES, doubleReversed.value);
    expect(backToBuggy.ok).toBe(true);
    if (!backToBuggy.ok) {
      return;
    }
    expect(backToBuggy.value.sources).toEqual(FIXED_SOURCES);
  });

  it("文件创建与删除互逆", () => {
    const creation = [
      "--- /dev/null",
      "+++ b/NewFile.java",
      "@@ -0,0 +1,2 @@",
      "+package com.example;",
      "+",
    ].join("\n") + "\n";
    const reversed = reverseUnifiedDiff(creation);
    expect(reversed.ok).toBe(true);
    if (!reversed.ok) {
      return;
    }
    const applied = applyUnifiedDiff({ "NewFile.java": "package com.example;\n\n" }, reversed.value);
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }
    expect(applied.value.deletedPaths).toEqual(["NewFile.java"]);
  });

  it("解析失败时原样传递错误", () => {
    const result = reverseUnifiedDiff("not a diff");
    expect(result.ok).toBe(false);
  });
});
