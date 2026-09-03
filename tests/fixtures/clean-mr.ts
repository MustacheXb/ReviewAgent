import type { GithubPullRequest } from "../../src/dataset/clean-mr/pr-records.js";
import type { CleanMrCandidate } from "../../src/dataset/clean-mr/selection.js";

/**
 * clean MR（Ticket 09）测试夹具：GitHub PR 工厂、候选构造器、样例 diff。
 * 全部离线数据，测试零网络。
 */

export const SAMPLE_JAVA_DIFF = [
  "diff --git a/src/main/java/com/example/Foo.java b/src/main/java/com/example/Foo.java",
  "index 1234567..89abcde 100644",
  "--- a/src/main/java/com/example/Foo.java",
  "+++ b/src/main/java/com/example/Foo.java",
  "@@ -1,5 +1,6 @@",
  " public class Foo {",
  "+    int added = 1;",
  "     int bar() {",
  "         return 1;",
  "     }",
  " }",
].join("\n");

export const SAMPLE_POM_DIFF = [
  "diff --git a/pom.xml b/pom.xml",
  "index 1111111..2222222 100644",
  "--- a/pom.xml",
  "+++ b/pom.xml",
  "@@ -1,3 +1,3 @@",
  " <project>",
  "-  <version>1.0.0</version>",
  "+  <version>1.0.1</version>",
  " </project>",
].join("\n");

export const SAMPLE_README_DIFF = [
  "diff --git a/README.md b/README.md",
  "index 1111111..2222222 100644",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1,2 +1,2 @@",
  " # Project",
  "-Old docs",
  "+New docs",
].join("\n");

export interface PrOverrides extends Partial<GithubPullRequest> {}

export function makePullRequest(overrides: PrOverrides = {}): GithubPullRequest {
  return {
    number: 101,
    title: "Add stream position tracking",
    body: "Rationale: allow collecting positions then direct-reading parts of a file.",
    state: "closed",
    draft: false,
    createdAt: "2026-08-20T10:00:00Z",
    mergedAt: "2026-08-26T14:40:52Z",
    mergeCommitSha: "61f2c646066e959f65cb99a826a2a759be42dbdd",
    htmlUrl: "https://github.com/google/gson/pull/101",
    baseRef: "main",
    baseSha: "b3f4ca20087f9066de4c340522ff84e0558e1ad1",
    labels: [],
    ...overrides,
  };
}

/** GitHub pulls 列表响应条目的原始 JSON 形态（实测形状，2026-09） */
export function makeRawListItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 3102,
    title: "Add JsonReader.getCharacterOffset to track stream position",
    body: "Rationale: Allow stream-reading large JSON files.",
    state: "closed",
    draft: false,
    created_at: "2026-08-20T10:00:00Z",
    merged_at: "2026-08-26T14:40:52Z",
    merge_commit_sha: "61f2c646066e959f65cb99a826a2a759be42dbdd",
    html_url: "https://github.com/google/gson/pull/3102",
    base: {
      label: "google:main",
      ref: "main",
      sha: "b3f4ca20087f9066de4c340522ff84e0558e1ad1",
    },
    labels: [{ name: "enhancement" }],
    ...overrides,
  };
}

export interface CandidateOverrides {
  readonly pr?: GithubPullRequest;
  readonly commitMessages?: readonly string[];
  readonly diff?: string;
}

export function makeCandidate(overrides: CandidateOverrides = {}): CleanMrCandidate {
  return {
    pr: overrides.pr ?? makePullRequest(),
    commitMessages: overrides.commitMessages ?? [makePullRequest().title],
    diff: overrides.diff ?? SAMPLE_JAVA_DIFF,
  };
}

/** 多文件 Java diff（n 个文件，每文件 changedLineCount 行变更） */
export function javaDiffWithFiles(fileCount: number, changedLineCount: number): string {
  const blocks: string[] = [];
  for (let i = 0; i < fileCount; i += 1) {
    const adds = Array.from({ length: changedLineCount }, (_, j) => `+    int v${j} = ${j};`);
    blocks.push(
      [
        `diff --git a/src/F${i}.java b/src/F${i}.java`,
        "index 1111111..2222222 100644",
        `--- a/src/F${i}.java`,
        `+++ b/src/F${i}.java`,
        `@@ -1,2 +1,${2 + changedLineCount} @@`,
        " class F {",
        ...adds,
        " }",
      ].join("\n"),
    );
  }
  return blocks.join("\n");
}
