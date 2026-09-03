import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SAMPLE_MR_CASE } from "./sample-mr-case.js";

/** 手写 Java MR fixture 自身的健全性（diff/真值/仓库形态） */
describe("sample MR fixture", () => {
  it("carries a unified diff with exactly one changed file", () => {
    expect(SAMPLE_MR_CASE.diff).toContain("diff --git a/src/main/java/com/example/math/MathUtils.java");
    expect(SAMPLE_MR_CASE.diff.match(/^-[^-]/gm)).toHaveLength(1);
    expect(SAMPLE_MR_CASE.diff.match(/^\+[^+]/gm)).toHaveLength(1);
    expect(SAMPLE_MR_CASE.diff).toContain("for (int i = 0; i <= count; i++) {");
  });

  it("carries truth as a minimal fix patch with line locations", () => {
    const truth = SAMPLE_MR_CASE.truth;
    expect(truth).not.toBeNull();
    expect(truth?.locations).toHaveLength(1);
    const location = truth?.locations[0];
    expect(location?.file).toBe("src/main/java/com/example/math/MathUtils.java");
    expect(location?.lineStart).toBe(20);
    expect(location?.lineEnd).toBe(20);
    expect(location?.defectNature).toBe("CORRECTNESS");
    expect(truth?.fixPatch).toContain("+        for (int i = 0; i < count; i++) {");
  });

  it("points to a fixture repository containing the changed and context files", () => {
    const repoDir = fileURLToPath(new URL("./sample-java-repo", import.meta.url));
    expect(SAMPLE_MR_CASE.repoPath).toBe(repoDir);
    const files = [
      "src/main/java/com/example/math/MathUtils.java",
      "src/main/java/com/example/math/Calculator.java",
      "src/main/java/com/example/math/Main.java",
    ];
    for (const file of files) {
      expect(existsSync(path.join(repoDir, file)), `missing fixture file: ${file}`).toBe(true);
    }
  });

  it("base file contains the fixed loop bound referenced by the diff", async () => {
    const mathUtils = await import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(SAMPLE_MR_CASE.repoPath, "src/main/java/com/example/math/MathUtils.java"), "utf8"),
    );
    const lines = mathUtils.split(/\r?\n/);
    const loopLine = lines[19];
    expect(loopLine?.trim()).toBe("for (int i = 0; i < count; i++) {");
  });
});
