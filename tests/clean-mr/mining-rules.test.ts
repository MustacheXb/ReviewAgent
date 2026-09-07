import { describe, expect, it } from "vitest";
import {
  collectRevertedPrNumbers,
  containsJavaFile,
  extractResolvedIssues,
  hasIssueLink,
  isDependencyOnlyPaths,
  isMergedPr,
  isRevertPr,
} from "../../src/dataset/clean-mr/mining-rules.js";
import { makePullRequest } from "../fixtures/clean-mr.js";

/**
 * 挖掘规则测试（零网络）。
 * issue 关联判定逐条对齐 Multi-SWE-bench collect/filter_prs.py 的
 * extract_resolved_issues 实测语义（源码逐字核对，2026-09-03）。
 */

function issues(parts: {
  title?: string;
  body?: string | null;
  commits?: readonly string[];
}): readonly number[] {
  return extractResolvedIssues({
    title: parts.title ?? "",
    body: parts.body ?? null,
    commitMessages: parts.commits ?? [],
  });
}

describe("isMergedPr（merged 口径）", () => {
  it("merged_at 非 null 即 merged", () => {
    expect(isMergedPr(makePullRequest({ mergedAt: "2026-08-26T14:40:52Z" }))).toBe(true);
  });

  it("closed 未合并（merged_at null）不算 merged", () => {
    expect(isMergedPr(makePullRequest({ mergedAt: null, mergeCommitSha: "a".repeat(40) }))).toBe(false);
  });
});

describe("extractResolvedIssues（MSB filter_prs.py 逐字移植）", () => {
  it("标准关键词 + #N：close/closes/closed/fix(es|ed)/resolve(s|d)", () => {
    expect(issues({ title: "Fixes #123" })).toEqual([123]);
    expect(issues({ title: "close #1" })).toEqual([1]);
    expect(issues({ title: "Closed #2" })).toEqual([2]);
    expect(issues({ title: "resolve #3" })).toEqual([3]);
    expect(issues({ title: "RESOLVED #4" })).toEqual([4]);
    expect(issues({ title: "Closes #3, resolves #7" })).toEqual([3, 7]);
  });

  it("扫描范围：title + body + commit messages 拼接文本", () => {
    expect(issues({ title: "Add feature", body: "This closes #33." })).toEqual([33]);
    expect(issues({ title: "Add feature", commits: ["Fixed #12"] })).toEqual([12]);
    expect(issues({ title: "Add feature", body: "details", commits: ["work", "Fixes #55\nmore"] })).toEqual([55]);
  });

  it("HTML 注释中的关联词不计（先剥 <!--...--> 再匹配）", () => {
    expect(issues({ title: "Add feature", body: "<!-- fixes #99 -->\nsee discussion" })).toEqual([]);
    expect(issues({ title: "<!-- close #1 -->" })).toEqual([]);
  });

  it("非关键词的 #N 不计（词表判定）", () => {
    expect(issues({ title: "see #1" })).toEqual([]);
    expect(issues({ title: "what about #42" })).toEqual([]);
  });

  it("关键词后必须紧跟空白与 #（MSB 正则口径：冒号等形式不匹配）", () => {
    expect(issues({ title: "Fixes: #123" })).toEqual([]);
    expect(issues({ title: "fixes#5" })).toEqual([]);
  });

  it("关键词与 #N 可跨行（\\s 含换行）", () => {
    expect(issues({ title: "fixes", body: "#9" })).toEqual([9]);
  });

  it("编号 0 被剔除（fix #0 视为无关联，原实现同款行为）", () => {
    expect(issues({ title: "fix #0" })).toEqual([]);
  });

  it("同一关键词多次出现仅保留最后一次编号（Python dict(findall) 语义）", () => {
    expect(issues({ title: "fix #1 then fix #2" })).toEqual([2]);
    // 不同关键词各自保留最后一次出现（dict 键为关键词本身）
    expect(issues({ title: "fix #1 fixes #2 close #3" })).toEqual([1, 2, 3]);
    expect(issues({ title: "fix #1 fix #5 fixes #2" })).toEqual([2, 5]);
  });

  it("body 为 null / 空串安全", () => {
    expect(issues({ title: "Fixes #8", body: null })).toEqual([8]);
    expect(issues({ title: "Fixes #8", body: "" })).toEqual([8]);
  });

  it("hasIssueLink = 编号列表非空", () => {
    expect(hasIssueLink({ title: "Fixes #8", body: null, commitMessages: [] })).toBe(true);
    expect(hasIssueLink({ title: "plain title", body: null, commitMessages: [] })).toBe(false);
  });
});

describe("isRevertPr（PR 本身是 revert）", () => {
  it("标题含 revert 词（含自动生成的 Revert \"...\" 形态）", () => {
    expect(isRevertPr({ title: 'Revert "Add stream position"', body: null, commitMessages: [] })).toBe(true);
    expect(isRevertPr({ title: "revert PR #45", body: null, commitMessages: [] })).toBe(true);
    expect(isRevertPr({ title: "Reverting the workaround", body: null, commitMessages: [] })).toBe(true);
    expect(isRevertPr({ title: "Reverted 61f2c64", body: null, commitMessages: [] })).toBe(true);
  });

  it("正文或提交消息含 revert 词也排除（保守口径）", () => {
    expect(isRevertPr({ title: "Add feature", body: "This reverts the old behavior", commitMessages: [] })).toBe(true);
    expect(isRevertPr({ title: "Add feature", body: null, commitMessages: ["Revert abc"] })).toBe(true);
  });

  it("词边界：reversion 等衍生词不触发", () => {
    expect(isRevertPr({ title: "Add reversion guard", body: null, commitMessages: [] })).toBe(false);
    expect(isRevertPr({ title: "Preserve old behavior", body: null, commitMessages: [] })).toBe(false);
  });
});

describe("collectRevertedPrNumbers（被更晚 revert 引用的 PR）", () => {
  it("GitHub 自动正文形态：Reverts org/repo#N", () => {
    const prs = [makePullRequest({ number: 200, title: 'Revert "Add X"', body: "Reverts google/gson#123\n\n:auto-generated:" })];
    expect(collectRevertedPrNumbers(prs)).toEqual(new Set([123]));
  });

  it("人工形态：revert #N / Revert PR #N / Reverting org/repo#N", () => {
    const prs = [
      makePullRequest({ number: 201, title: "Revert #45", body: null }),
      makePullRequest({ number: 202, title: "Rollback", body: "this is reverting fasterxml/jackson-core#9 manually" }),
      makePullRequest({ number: 203, title: "Revert PR #77 due to flakiness", body: null }),
    ];
    expect(collectRevertedPrNumbers(prs)).toEqual(new Set([45, 9, 77]));
  });

  it("无 revert 语境的 #N 不收集；不匹配时为空集", () => {
    const prs = [makePullRequest({ body: "fixes #5, see #6" })];
    expect(collectRevertedPrNumbers(prs)).toEqual(new Set());
    expect(collectRevertedPrNumbers([])).toEqual(new Set());
  });

  it("revert 词与 #N 相距超过 40 字符不收集（限制误报）", () => {
    const far = "revert this and also that and then some more words and then eventually mention #123 at the end";
    const prs = [makePullRequest({ body: far })];
    expect(collectRevertedPrNumbers(prs)).toEqual(new Set());
  });
});

describe("路径规则（机械变更 / Java 文件）", () => {
  it("全部文件为依赖清单 → dependency-only", () => {
    expect(isDependencyOnlyPaths(["pom.xml"])).toBe(true);
    expect(isDependencyOnlyPaths(["pom.xml", "gradle/wrapper/gradle-wrapper.properties"])).toBe(true);
    expect(isDependencyOnlyPaths(["build.gradle.kts", "settings.gradle"])).toBe(true);
  });

  it("混合源码 → 非 dependency-only", () => {
    expect(isDependencyOnlyPaths(["pom.xml", "src/Foo.java"])).toBe(false);
    expect(isDependencyOnlyPaths(["src/Foo.java"])).toBe(false);
  });

  it("空路径列表按非机械处理（由上层 malformed-diff 兜底）", () => {
    expect(isDependencyOnlyPaths([])).toBe(false);
  });

  it("containsJavaFile：至少一个 *.java", () => {
    expect(containsJavaFile(["pom.xml", "src/main/Foo.java"])).toBe(true);
    expect(containsJavaFile(["README.md", "pom.xml"])).toBe(false);
    expect(containsJavaFile([])).toBe(false);
  });
});
