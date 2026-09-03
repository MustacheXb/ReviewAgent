import type { DefectRecord } from "../../src/dataset/defect-record.js";

/**
 * 小型缺陷对 fixture（内联，零外部依赖）：
 * 一个 Java 缺陷记录，含两个文件——
 * - Parser.java：修复为「纯新增」（补 null 防御）；
 * - Util.java：修复为「单行替换」（lo/hi 交换缺陷）。
 * 用于逆补丁转换、真值构造、逆 diff 语义断言。
 */

const BUGGY_PARSER = [
  "package com.example;",
  "",
  "public class Parser {",
  "    int parse(String s) {",
  "        return Integer.parseInt(s.trim());",
  "    }",
  "}",
  "",
].join("\n");

const FIXED_PARSER = [
  "package com.example;",
  "",
  "public class Parser {",
  "    int parse(String s) {",
  "        if (s == null) {",
  "            throw new IllegalArgumentException(\"null input\");",
  "        }",
  "        return Integer.parseInt(s.trim());",
  "    }",
  "}",
  "",
].join("\n");

const BUGGY_UTIL = [
  "package com.example;",
  "",
  "public class Util {",
  "    static int clamp(int v, int lo, int hi) {",
  "        return Math.max(hi, Math.min(lo, v));",
  "    }",
  "}",
  "",
].join("\n");

const FIXED_UTIL = [
  "package com.example;",
  "",
  "public class Util {",
  "    static int clamp(int v, int lo, int hi) {",
  "        return Math.max(lo, Math.min(hi, v));",
  "    }",
  "}",
  "",
].join("\n");

/** 最小修复补丁：buggy → fixed（两文件，两 hunk） */
export const FIX_PATCH = [
  "--- src/main/java/com/example/Parser.java",
  "+++ src/main/java/com/example/Parser.java",
  "@@ -2,6 +2,9 @@",
  " ",
  " public class Parser {",
  "     int parse(String s) {",
  "+        if (s == null) {",
  "+            throw new IllegalArgumentException(\"null input\");",
  "+        }",
  "         return Integer.parseInt(s.trim());",
  "     }",
  " }",
  "--- src/main/java/com/example/Util.java",
  "+++ src/main/java/com/example/Util.java",
  "@@ -2,6 +2,6 @@",
  " ",
  " public class Util {",
  "     static int clamp(int v, int lo, int hi) {",
  "-        return Math.max(hi, Math.min(lo, v));",
  "+        return Math.max(lo, Math.min(hi, v));",
  "     }",
  " }",
].join("\n") + "\n";

export const ISSUE_DESCRIPTION =
  "NumberUtils.parse crashes with NullPointerException on null input, and Util.clamp returns wrong result when lo > hi.";

export const PARSER_PATH = "src/main/java/com/example/Parser.java";
export const UTIL_PATH = "src/main/java/com/example/Util.java";

export const FIXED_SOURCES: Readonly<Record<string, string>> = {
  [PARSER_PATH]: FIXED_PARSER,
  [UTIL_PATH]: FIXED_UTIL,
};

export const BUGGY_SOURCES: Readonly<Record<string, string>> = {
  [PARSER_PATH]: BUGGY_PARSER,
  [UTIL_PATH]: BUGGY_UTIL,
};

/** 完整 defectRecord fixture（含 buggy 快照以启用直接断言） */
export const DEFECT_RECORD: DefectRecord = {
  recordId: "Example-1",
  fixedSources: FIXED_SOURCES,
  fixPatch: FIX_PATCH,
  issueDescription: ISSUE_DESCRIPTION,
  defectNatures: {
    [PARSER_PATH]: "NULL_SAFETY",
    [UTIL_PATH]: "BOUNDARY",
  },
  buggySources: BUGGY_SOURCES,
};
