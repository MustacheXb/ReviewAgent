import type { SourceSnapshot } from "../../../src/dataset/diff/apply-unified-diff.js";
import { reverseUnifiedDiff } from "../../../src/dataset/diff/reverse-unified-diff.js";
import type { MRCase, MRTruth, TruthLocation } from "../../../src/contracts/mr-case.js";
import type { CompositeCandidate } from "../../../src/experiment/synthetic/compose-composite.js";

/**
 * 合成组合构造（#52）测试共享 fixture：一个 10 文件级的微型 Java「仓」
 * 快照 + 4 个 Vul4J 形态案例（含真值 fixPatch 与 MR diff = 逆补丁）。
 *
 * 快照时间线（V2 = 锚案例 VUL4J-2 fix commit 点的物化状态）：
 * - Parser.java / Service.java / Report.java 已含各自修复（fix 态）
 * - FillerA–D 为良性填充候选（方法体含语句锚 / javadoc 锚 / 局部声明）
 * - drift 场景把 Report.java 第 5 行改掉（VUL4J-4 修复后又有一次无关提交）
 */

export const PARSER_PATH = "src/main/java/com/example/Parser.java";
export const SERVICE_PATH = "src/main/java/com/example/Service.java";
export const REPORT_PATH = "src/main/java/com/example/Report.java";

/** 填充候选文件（确定性生成：letter × methodCount 个方法，标识符带文件前缀保证全快照唯一） */
function makeFillerFile(letter: string, methodCount: number): string {
  const methods = Array.from({ length: methodCount }, (_, index) => {
    const local = `${letter.toLowerCase()}Value${index}`;
    return [
      `    public int compute${letter}${index}(int input) {`,
      `        int ${local} = input * ${index + 1};`,
      `        if (${local} > 100) {`,
      `            return ${local};`,
      `        }`,
      `        return ${local} + 1;`,
      `    }`,
    ].join("\n");
  });
  return ["package com.example.fill;", "", `public class Filler${letter} {`, ...methods, "}", ""].join("\n");
}

function filler(letter: string): string {
  return makeFillerFile(letter, 3);
}

export const PARSER_FIXED = [
  "package com.example;",
  "",
  "public class Parser {",
  "    public String parse(String input) {",
  "        if (input == null) {",
  "            return \"\";",
  "        }",
  "        return input.trim();",
  "    }",
  "}",
  "",
].join("\n");

export const SERVICE_FIXED = [
  "package com.example;",
  "",
  "public class Service {",
  "    public int length(String value) {",
  "        if (value == null) {",
  "            return 0;",
  "        }",
  "        return value.length();",
  "    }",
  "}",
  "",
].join("\n");

export const REPORT_FIXED = [
  "package com.example;",
  "",
  "public class Report {",
  "    public String render(String title) {",
  "        return \"report: \" + title;",
  "    }",
  "}",
  "",
].join("\n");

/** drift 场景：VUL4J-4 修复后的又一次无关提交改了 Report 第 5 行 */
export const REPORT_DRIFTED = [
  "package com.example;",
  "",
  "public class Report {",
  "    public String render(String title) {",
  "        return \"report: \" + title.trim();",
  "    }",
  "}",
  "",
].join("\n");

/** V2 快照（锚案例 fix commit 点）：案例文件均处修复态 + 4 个填充候选 */
export function snapshotV2(report: string = REPORT_FIXED): SourceSnapshot {
  return {
    [PARSER_PATH]: PARSER_FIXED,
    [SERVICE_PATH]: SERVICE_FIXED,
    [REPORT_PATH]: report,
    "src/main/java/com/example/fill/FillerA.java": filler("A"),
    "src/main/java/com/example/fill/FillerB.java": filler("B"),
    "src/main/java/com/example/fill/FillerC.java": filler("C"),
    "src/main/java/com/example/fill/FillerD.java": filler("D"),
  };
}

// ---------- 案例修复补丁（buggy → fixed）与逆补丁 ----------

/** VUL4J-1 修复（Parser 补空检查） */
export const FIX_PATCH_PARSER = [
  `--- ${PARSER_PATH}`,
  `+++ ${PARSER_PATH}`,
  "@@ -2,5 +2,8 @@",
  " ",
  " public class Parser {",
  "     public String parse(String input) {",
  "+        if (input == null) {",
  "+            return \"\";",
  "+        }",
  "         return input.trim();",
  "     }",
  "",
].join("\n");

/** VUL4J-2 修复（Service 补空检查） */
export const FIX_PATCH_SERVICE = [
  `--- ${SERVICE_PATH}`,
  `+++ ${SERVICE_PATH}`,
  "@@ -2,5 +2,8 @@",
  " ",
  " public class Service {",
  "     public int length(String value) {",
  "+        if (value == null) {",
  "+            return 0;",
  "+        }",
  "         return value.length();",
  "     }",
  "",
].join("\n");

/** VUL4J-3 修复（Service 补空串检查——与 VUL4J-2 同文件，用于文件级不相交场景） */
export const FIX_PATCH_SERVICE_EMPTY = [
  `--- ${SERVICE_PATH}`,
  `+++ ${SERVICE_PATH}`,
  "@@ -5,6 +5,9 @@",
  "         if (value == null) {",
  "             return 0;",
  "         }",
  "+        if (value.isEmpty()) {",
  "+            return 0;",
  "+        }",
  "         return value.length();",
  "     }",
  " }",
  "",
].join("\n");

/** VUL4J-4 修复（Report 输出加前缀） */
export const FIX_PATCH_REPORT = [
  `--- ${REPORT_PATH}`,
  `+++ ${REPORT_PATH}`,
  "@@ -3,5 +3,5 @@",
  " public class Report {",
  "     public String render(String title) {",
  "-        return title;",
  "+        return \"report: \" + title;",
  "     }",
  " }",
  "",
].join("\n");

/** 由修复补丁派生案例 MR diff（逆补丁：fixed → buggy） */
export function mrDiffOf(fixPatch: string): string {
  const reversed = reverseUnifiedDiff(fixPatch);
  if (!reversed.ok) {
    throw new Error(`fixture fixPatch 逆补丁失败：${reversed.error.message}`);
  }
  return reversed.value;
}

function truth(file: string, lineStart: number, defectNature: string, fixPatch: string): MRTruth {
  const location: TruthLocation = { file, lineStart, lineEnd: lineStart, defectNature };
  return { locations: [location], fixPatch };
}

export function makeCandidate(
  caseId: string,
  fixCommitAt: string,
  fixPatch: string,
  truthOf: MRTruth,
  snapshot: SourceSnapshot,
  repoPath = "D:/repos/example",
): CompositeCandidate {
  const mrCase: MRCase = {
    caseId,
    repoPath,
    diff: mrDiffOf(fixPatch),
    issueDescription: `issue of ${caseId}`,
    truth: truthOf,
    labels: { source: "vul4j", riskClass: "Medium", allowedConfigs: ["A", "B", "C", "D", "E"] },
  };
  return { mrCase, fixCommitAt, snapshot };
}

/** 四案例标准组（V2 快照；锚 = VUL4J-2） */
export function standardCandidates(report: string = REPORT_FIXED): CompositeCandidate[] {
  const snap = snapshotV2(report);
  return [
    makeCandidate("VUL4J-1", "2024-01-10T00:00:00Z", FIX_PATCH_PARSER, truth(PARSER_PATH, 5, "NullCheck", FIX_PATCH_PARSER), snap),
    makeCandidate("VUL4J-2", "2024-06-15T00:00:00Z", FIX_PATCH_SERVICE, truth(SERVICE_PATH, 5, "NullCheck", FIX_PATCH_SERVICE), snap),
    makeCandidate("VUL4J-3", "2024-03-01T00:00:00Z", FIX_PATCH_SERVICE_EMPTY, truth(SERVICE_PATH, 8, "EmptyCheck", FIX_PATCH_SERVICE_EMPTY), snap),
    makeCandidate("VUL4J-4", "2024-02-20T00:00:00Z", FIX_PATCH_REPORT, truth(REPORT_PATH, 5, "ReturnValue", FIX_PATCH_REPORT), snap),
  ];
}
