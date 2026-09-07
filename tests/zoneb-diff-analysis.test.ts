import { describe, expect, it } from "vitest";
import { analyzeDiff, oldSpansOf } from "../src/zoneb/diff-analysis.js";
import { SAMPLE_MR_CASE } from "./fixtures/sample-mr-case.js";

describe("analyzeDiff (Diff layer of the deterministic prefetch pipeline)", () => {
  it("extracts the changed file and hunk line ranges from the sample MR diff", () => {
    const analysis = analyzeDiff(SAMPLE_MR_CASE.diff);

    expect(analysis.files).toHaveLength(1);
    const [fileDiff] = analysis.files;
    expect(fileDiff?.file).toBe("src/main/java/com/example/math/MathUtils.java");
    expect(fileDiff?.hunks).toEqual([{ oldStart: 17, oldCount: 7, newStart: 17, newCount: 7 }]);
    expect(fileDiff !== undefined ? oldSpansOf(fileDiff) : []).toEqual([{ startLine: 17, endLine: 23 }]);
  });

  it("sorts multiple changed files by path", () => {
    const diff = [
      "diff --git a/src/B.java b/src/B.java",
      "--- a/src/B.java",
      "+++ b/src/B.java",
      "@@ -1,3 +1,3 @@",
      " a",
      "-b",
      "+b",
      "diff --git a/src/A.java b/src/A.java",
      "--- a/src/A.java",
      "+++ b/src/A.java",
      "@@ -10,2 +10,2 @@",
      " a",
      "-x",
      "+y",
    ].join("\n");

    const analysis = analyzeDiff(diff);
    expect(analysis.files.map((file) => file.file)).toEqual(["src/A.java", "src/B.java"]);
  });

  it("attributes hunks of a deleted file to the a-side path", () => {
    const diff = [
      "diff --git a/src/Old.java b/src/Old.java",
      "--- a/src/Old.java",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-public class Old {",
      "-}",
    ].join("\n");

    const analysis = analyzeDiff(diff);
    expect(analysis.files.map((file) => file.file)).toEqual(["src/Old.java"]);
    expect(analysis.files[0]?.hunks[0]).toEqual({ oldStart: 1, oldCount: 2, newStart: 0, newCount: 0 });
  });

  it("attributes hunks of a new file to the b-side path", () => {
    const diff = [
      "diff --git a/src/New.java b/src/New.java",
      "--- /dev/null",
      "+++ b/src/New.java",
      "@@ -0,0 +1,2 @@",
      "+public class New {",
      "+}",
    ].join("\n");

    const analysis = analyzeDiff(diff);
    expect(analysis.files.map((file) => file.file)).toEqual(["src/New.java"]);
  });

  it("defaults the hunk count to 1 when omitted and strips trailing timestamps", () => {
    const diff = [
      "diff --git a/A.java b/A.java",
      "--- a/A.java\t2026-01-01 10:00:00.000000000 +0000",
      "+++ b/A.java\t2026-01-02 10:00:00.000000000 +0000",
      "@@ -5 +5 @@",
      " context",
      "-old",
      "+new",
    ].join("\n");

    const analysis = analyzeDiff(diff);
    expect(analysis.files[0]?.hunks[0]).toEqual({ oldStart: 5, oldCount: 1, newStart: 5, newCount: 1 });
  });

  it("fails fast on a diff without parsable file headers (no silent empty result)", () => {
    expect(() => analyzeDiff("just some text\nwith no diff headers\n")).toThrow(
      /no parsable file headers/,
    );
  });
});
