/**
 * Vul4J 适配层测试夹具（Ticket 08）：模拟一条 Vul4J 导出物。
 *
 * 形态对齐实测核验（github.com/tuhh-softsec/Vul4J，2026-09-03）：
 * - 修复 commit diff = 源码节 + 测试节 + 二进制资源节混杂（如 VUL4J-12）；
 * - 本夹具含全部三种节，用于验证 stripTestSections 的剥离与留痕。
 * 纯数据：期望值不在此处，断言在各测试文件。
 */

export const VUL4J_SAMPLE_VUL_ID = "VUL4J-99";
export const VUL4J_SAMPLE_CVE_ID = "CVE-2026-1234";
export const VUL4J_SAMPLE_CWE_ID = "CWE-20";
export const VUL4J_SAMPLE_CWE_NAME = "Improper Input Validation";
export const VUL4J_SAMPLE_REPO_SLUG = "example/codec";
export const VUL4J_SAMPLE_FIX_SHA = "0123456789abcdef0123456789abcdef01234567";
export const VUL4J_SAMPLE_FIX_COMMIT_URL = `https://github.com/example/codec/commit/${VUL4J_SAMPLE_FIX_SHA}`;
export const VUL4J_SAMPLE_FAILING_TESTS = "com.example.codec.DecoderTest#testNullRejected";

export const VUL4J_SAMPLE_SRC_PATH = "src/main/java/com/example/codec/Decoder.java";
export const VUL4J_SAMPLE_TEST_PATH = "src/test/java/com/example/codec/DecoderTest.java";
export const VUL4J_SAMPLE_BINARY_PATH = "src/main/resources/legacy.dat";

/** 修复后（fix commit）版本源码（12 行，含尾换行） */
export const VUL4J_SAMPLE_FIXED_DECODER = [
  "package com.example.codec;",
  "",
  "import java.util.Base64;",
  "",
  "public class Decoder {",
  "    public byte[] decode(String input) {",
  "        if (input == null) {",
  '            throw new IllegalArgumentException("input required");',
  "        }",
  "        return Base64.getDecoder().decode(input);",
  "    }",
  "}",
  "",
].join("\n");

/** 历史 buggy 版本源码（fix commit 的父提交，12 行，含尾换行） */
export const VUL4J_SAMPLE_BUGGY_DECODER = [
  "package com.example.codec;",
  "",
  "import java.util.Base64;",
  "",
  "public class Decoder {",
  "    public byte[] decode(String input) {",
  "        if (input == null) {",
  "            return new byte[0];",
  "        }",
  "        return Base64.getDecoder().decode(input);",
  "    }",
  "}",
  "",
].join("\n");

/** 源码节（git 风格，含 index 行；buggy → fixed 方向） */
const SRC_SECTION = [
  `diff --git a/${VUL4J_SAMPLE_SRC_PATH} b/${VUL4J_SAMPLE_SRC_PATH}`,
  "index 1111111..2222222 100644",
  `--- a/${VUL4J_SAMPLE_SRC_PATH}`,
  `+++ b/${VUL4J_SAMPLE_SRC_PATH}`,
  "@@ -7,4 +7,4 @@",
  "         if (input == null) {",
  "-            return new byte[0];",
  '+            throw new IllegalArgumentException("input required");',
  "         }",
  "         return Base64.getDecoder().decode(input);",
  "",
].join("\n");

/** 测试节（新增 PoV 测试文件；适配层应剥离并留痕） */
const TEST_SECTION = [
  `diff --git a/${VUL4J_SAMPLE_TEST_PATH} b/${VUL4J_SAMPLE_TEST_PATH}`,
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  `+++ b/${VUL4J_SAMPLE_TEST_PATH}`,
  "@@ -0,0 +1,3 @@",
  "+package com.example.codec;",
  "+",
  "+public class DecoderTest {}",
  "",
].join("\n");

/** 非测试路径的二进制资源节（适配层应剥离并留痕到 excludedBinaryFiles） */
const BINARY_SECTION = [
  `diff --git a/${VUL4J_SAMPLE_BINARY_PATH} b/${VUL4J_SAMPLE_BINARY_PATH}`,
  "new file mode 100644",
  "index 0000000..4444444",
  `Binary files /dev/null and b/${VUL4J_SAMPLE_BINARY_PATH} differ`,
  "",
].join("\n");

/** 修复 commit 完整 diff（三节拼接；`<human_patch>.diff` 取回形态） */
export const VUL4J_SAMPLE_FIX_DIFF = SRC_SECTION + TEST_SECTION + BINARY_SECTION;

/** 剥离测试/二进制后的源码补丁（stripTestSections 期望输出 = 源码节原文） */
export const VUL4J_SAMPLE_SRC_PATCH = SRC_SECTION;

/** 仅测试节的 diff（全部剥离 → NO_SOURCE_FILES 错误分支） */
export const VUL4J_SAMPLE_ALL_TEST_DIFF = TEST_SECTION + BINARY_SECTION;

/** 修复后源码快照（含测试文件，覆盖源码补丁触碰的全部文件） */
export const VUL4J_SAMPLE_FIXED_SOURCES: Readonly<Record<string, string>> = {
  [VUL4J_SAMPLE_SRC_PATH]: VUL4J_SAMPLE_FIXED_DECODER,
  [VUL4J_SAMPLE_TEST_PATH]: "package com.example.codec;\n\npublic class DecoderTest {}\n",
};

/** 组装好的 Vul4jExportInput（供适配层/harness 兼容测试直接消费） */
export const VUL4J_SAMPLE_RECORD_INPUT = {
  vulId: VUL4J_SAMPLE_VUL_ID,
  cveId: VUL4J_SAMPLE_CVE_ID,
  cweId: VUL4J_SAMPLE_CWE_ID,
  cweName: VUL4J_SAMPLE_CWE_NAME,
  repoSlug: VUL4J_SAMPLE_REPO_SLUG,
  fixCommitUrl: VUL4J_SAMPLE_FIX_COMMIT_URL,
  fixDiff: VUL4J_SAMPLE_FIX_DIFF,
  fixedSources: VUL4J_SAMPLE_FIXED_SOURCES,
  failingTests: VUL4J_SAMPLE_FAILING_TESTS,
} as const;
