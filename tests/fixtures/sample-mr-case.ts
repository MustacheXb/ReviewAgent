import { fileURLToPath } from "node:url";
import type { MRCase } from "../../src/contracts/mr-case.js";

/**
 * 手写 Java MR 测试样例（Ticket 01 fixture）。
 * 逆补丁法形态：仓库内是修复后版本（base）；MR diff 是引入缺陷的逆 diff
 * （把 sumFirst 的循环上界从 i < count 改成 i <= count，读越界一个元素）；
 * 真值 = 最小修复补丁的行位与性质。
 */

const SAMPLE_REPO_PATH = fileURLToPath(new URL("./sample-java-repo", import.meta.url));

const MR_DIFF = [
  "diff --git a/src/main/java/com/example/math/MathUtils.java b/src/main/java/com/example/math/MathUtils.java",
  "index 9c8b7a6..4d3e2f1 100644",
  "--- a/src/main/java/com/example/math/MathUtils.java",
  "+++ b/src/main/java/com/example/math/MathUtils.java",
  "@@ -17,7 +17,7 @@",
  " */",
  "     public static int sumFirst(int[] values, int count) {",
  "         int sum = 0;",
  "-        for (int i = 0; i < count; i++) {",
  "+        for (int i = 0; i <= count; i++) {",
  "             sum += values[i];",
  "         }",
  "         return sum;",
].join("\n");

const FIX_PATCH = [
  "--- a/src/main/java/com/example/math/MathUtils.java",
  "+++ b/src/main/java/com/example/math/MathUtils.java",
  "@@ -17,7 +17,7 @@",
  " */",
  "     public static int sumFirst(int[] values, int count) {",
  "         int sum = 0;",
  "-        for (int i = 0; i <= count; i++) {",
  "+        for (int i = 0; i < count; i++) {",
  "             sum += values[i];",
  "         }",
  "         return sum;",
].join("\n");

export const SAMPLE_MR_CASE: MRCase = {
  caseId: "sample-mathutils-offbyone-001",
  repoPath: SAMPLE_REPO_PATH,
  diff: MR_DIFF,
  issueDescription:
    "MathUtils.sumFirst uses the loop condition 'i <= count', which reads values[count]; when count equals values.length this throws an ArrayIndexOutOfBoundsException.",
  truth: {
    locations: [
      {
        file: "src/main/java/com/example/math/MathUtils.java",
        lineStart: 20,
        lineEnd: 20,
        defectNature: "CORRECTNESS",
      },
    ],
    fixPatch: FIX_PATCH,
  },
  labels: {
    source: "handwritten-sample",
    riskClass: "Medium",
    allowedConfigs: ["A", "B", "C", "D", "E"],
  },
};
