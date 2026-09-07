/**
 * Multi-SWE-bench Java 适配层测试夹具（Ticket 08）：模拟一条 HF java/ JSONL 记录。
 *
 * 形态对齐实测核验（HF ByteDance-Seed/Multi-SWE-bench java/ 9 文件 128 实例，
 * 2026-09-03 全量下载逐条解析；详见 .spec-notes/multi-swe-bench.md）：
 * - body 可为 null（实测 23 条）→ 适配层降级空串；
 * - fix_patch = 非测试代码修复 diff（git unified diff），直接作检视 diff。
 * 纯数据：期望值不在此处，断言在各测试文件。
 */

export const MSB_SAMPLE_INSTANCE_ID = "fasterxml__jackson-databind-4487";
export const MSB_SAMPLE_BASE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const MSB_SAMPLE_PATH = "src/main/java/com/example/Node.java";

/** fix_patch：一处修改 + 一处新增（新侧真值行段可手算） */
export const MSB_SAMPLE_FIX_PATCH = [
  `--- a/${MSB_SAMPLE_PATH}`,
  `+++ b/${MSB_SAMPLE_PATH}`,
  "@@ -3,3 +3,4 @@",
  " public class Node {",
  '-    public String text() { return null; }',
  '+    public String text() { return ""; }',
  '+    public String safeText() { return text() == null ? "" : text(); }',
  " }",
  "",
].join("\n");

/** HF JSONL 原始记录形状（字段与实测一致；多余字段透传忽略） */
export const MSB_SAMPLE_RECORD = {
  org: "fasterxml",
  repo: "jackson-databind",
  number: 4487,
  state: "closed",
  title: "Fix NPE in JsonNode.toString",
  body: null,
  base: { label: "master", ref: "master", sha: MSB_SAMPLE_BASE_SHA },
  resolved_issues: [
    {
      number: 4486,
      title: "NPE when node is null",
      body: "Steps: call toString on a node built from a null token.",
    },
  ],
  fix_patch: MSB_SAMPLE_FIX_PATCH,
  test_patch: "--- a/src/test/java/com/example/NodeTest.java\n+++ b/src/test/java/com/example/NodeTest.java\n@@ -1,2 +1,3 @@\n+new test\n",
  instance_id: MSB_SAMPLE_INSTANCE_ID,
  hints: "",
} as const;
