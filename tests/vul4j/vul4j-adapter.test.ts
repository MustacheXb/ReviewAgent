import { describe, expect, it } from "vitest";
import { applyUnifiedDiff } from "../../src/dataset/diff/apply-unified-diff.js";
import type { SourceSnapshot } from "../../src/dataset/diff/apply-unified-diff.js";
import type { RiskClass } from "../../src/dataset/risk-class.js";
import {
  extractFixSha,
  stripTestSections,
  vul4jToDefectRecord,
  vul4jToMrCase,
  vul4jToMrCases,
  type Vul4jExportInput,
} from "../../src/dataset/vul4j/adapter.js";
import { verifyInverseSemantics } from "../../src/dataset/verify-inverse.js";
import {
  VUL4J_SAMPLE_ALL_TEST_DIFF,
  VUL4J_SAMPLE_BINARY_PATH,
  VUL4J_SAMPLE_BUGGY_DECODER,
  VUL4J_SAMPLE_CVE_ID,
  VUL4J_SAMPLE_CWE_ID,
  VUL4J_SAMPLE_CWE_NAME,
  VUL4J_SAMPLE_FAILING_TESTS,
  VUL4J_SAMPLE_FIX_COMMIT_URL,
  VUL4J_SAMPLE_FIX_DIFF,
  VUL4J_SAMPLE_FIXED_DECODER,
  VUL4J_SAMPLE_FIXED_SOURCES,
  VUL4J_SAMPLE_FIX_SHA,
  VUL4J_SAMPLE_REPO_SLUG,
  VUL4J_SAMPLE_SRC_PATCH,
  VUL4J_SAMPLE_SRC_PATH,
  VUL4J_SAMPLE_TEST_PATH,
  VUL4J_SAMPLE_VUL_ID,
} from "../fixtures/vul4j-sample.js";

interface SampleOverrides {
  readonly vulId?: string;
  readonly cveId?: string;
  readonly cweId?: string;
  readonly cweName?: string;
  readonly repoSlug?: string;
  readonly fixCommitUrl?: string;
  readonly fixDiff?: string;
  readonly fixedSources?: SourceSnapshot;
  readonly failingTests?: string;
  readonly issueDescription?: string;
  readonly riskClass?: RiskClass;
}

function sampleInput(overrides: SampleOverrides = {}): Vul4jExportInput {
  const base: Vul4jExportInput = {
    vulId: VUL4J_SAMPLE_VUL_ID,
    cveId: VUL4J_SAMPLE_CVE_ID,
    cweId: VUL4J_SAMPLE_CWE_ID,
    cweName: VUL4J_SAMPLE_CWE_NAME,
    repoSlug: VUL4J_SAMPLE_REPO_SLUG,
    fixCommitUrl: VUL4J_SAMPLE_FIX_COMMIT_URL,
    fixDiff: VUL4J_SAMPLE_FIX_DIFF,
    fixedSources: VUL4J_SAMPLE_FIXED_SOURCES,
    failingTests: VUL4J_SAMPLE_FAILING_TESTS,
  };
  return { ...base, ...overrides };
}

const REPO_PATH = "D:/repos/codec-fixed";

describe("stripTestSections（测试/二进制剥离 + 留痕）", () => {
  it("剥离测试节与非测试二进制节，仅保留源码节，明细全量留痕", () => {
    const stripped = stripTestSections(VUL4J_SAMPLE_FIX_DIFF, []);
    expect(stripped.ok).toBe(true);
    if (!stripped.ok) {
      return;
    }
    expect(stripped.value.srcDiff).toBe(VUL4J_SAMPLE_SRC_PATCH);
    expect(stripped.value.trace).toEqual({
      excludedTestFiles: [VUL4J_SAMPLE_TEST_PATH],
      excludedBinaryFiles: [VUL4J_SAMPLE_BINARY_PATH],
    });
  });

  it("显式测试路径前缀可剥离路径段启发式覆盖不到的测试文件", () => {
    const helperSection = [
      "diff --git a/core/util/HelperTestUtil.java b/core/util/HelperTestUtil.java",
      "index 1111111..2222222 100644",
      "--- a/core/util/HelperTestUtil.java",
      "+++ b/core/util/HelperTestUtil.java",
      "@@ -1,3 +1,3 @@",
      " class HelperTestUtil {",
      "-    int ratio() { return 1; }",
      "+    int ratio() { return 2; }",
      " }",
      "",
    ].join("\n");
    // core/util 路径无 test 路径段，启发式保留；显式前缀应剥离它
    const stripped = stripTestSections(VUL4J_SAMPLE_SRC_PATCH + helperSection, ["core/util"]);
    expect(stripped.ok).toBe(true);
    if (stripped.ok) {
      expect(stripped.value.trace.excludedTestFiles).toEqual(["core/util/HelperTestUtil.java"]);
      expect(stripped.value.srcDiff).toBe(VUL4J_SAMPLE_SRC_PATCH);
    }
  });

  it("全部节均为测试/二进制 → NO_SOURCE_FILES 显式报错（不产出空补丁）", () => {
    const stripped = stripTestSections(VUL4J_SAMPLE_ALL_TEST_DIFF, []);
    expect(stripped.ok).toBe(false);
    if (!stripped.ok) {
      expect(stripped.error.code).toBe("NO_SOURCE_FILES");
      expect(stripped.error.message).toContain(VUL4J_SAMPLE_TEST_PATH);
    }
  });

  it("不含 `diff --git` 文件节（非 GitHub commit diff 形态）→ INVALID_FIX_DIFF", () => {
    const stripped = stripTestSections("--- a/x.java\n+++ b/x.java\n@@ -1,1 +1,1 @@\n-x\n+y\n", []);
    expect(stripped.ok).toBe(false);
    if (!stripped.ok) {
      expect(stripped.error.code).toBe("INVALID_FIX_DIFF");
    }
  });
});

describe("vul4jToDefectRecord（导出物 → DefectRecord）", () => {
  it("剥离后的源码补丁作 fixPatch，CWE-20 → SECURITY，riskClass 缺省 High，source=vul4j", () => {
    const result = vul4jToDefectRecord(sampleInput());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toEqual({
      recordId: VUL4J_SAMPLE_VUL_ID,
      fixedSources: VUL4J_SAMPLE_FIXED_SOURCES,
      fixPatch: VUL4J_SAMPLE_SRC_PATCH,
      issueDescription:
        `Vulnerability ${VUL4J_SAMPLE_CVE_ID} (${VUL4J_SAMPLE_CWE_ID}: ${VUL4J_SAMPLE_CWE_NAME}) ` +
        `in ${VUL4J_SAMPLE_REPO_SLUG}. Fixed by ${VUL4J_SAMPLE_FIX_COMMIT_URL}. ` +
        `Proof-of-vulnerability test: ${VUL4J_SAMPLE_FAILING_TESTS}.`,
      defectNatures: { [VUL4J_SAMPLE_SRC_PATH]: "SECURITY" },
      source: "vul4j",
      riskClass: "High",
    });
  });

  it("issueDescription 覆盖优先；riskClass 可覆盖", () => {
    const overridden = vul4jToDefectRecord(
      sampleInput({ issueDescription: "custom description", riskClass: "Low" }),
    );
    expect(overridden.ok).toBe(true);
    if (overridden.ok) {
      expect(overridden.value.issueDescription).toBe("custom description");
      expect(overridden.value.riskClass).toBe("Low");
    }
  });

  it("未映射 CWE（如 CWE-19）→ defectNatures 显式 OTHER", () => {
    const result = vul4jToDefectRecord(sampleInput({ cweId: "CWE-19" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.defectNatures).toEqual({ [VUL4J_SAMPLE_SRC_PATH]: "OTHER" });
    }
  });

  it("fixedSources 缺少补丁触碰的文件 → fail fast 显式报错", () => {
    const result = vul4jToDefectRecord(
      sampleInput({ fixedSources: { "src/main/java/com/example/Other.java": "class Other {}\n" } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_FIX_PATCH");
      expect(result.error.message).toContain(VUL4J_SAMPLE_SRC_PATH);
    }
  });
});

describe("vul4jToMrCase（导出物 → MRCase，逆补丁法）", () => {
  const converted = vul4jToMrCase(sampleInput(), { repoPath: REPO_PATH });

  it("labels：source=vul4j、riskClass=High（spec：驱动 C2/C3 深加载）、allowedConfigs 缺省全量", () => {
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    expect(converted.value.labels).toEqual({
      source: "vul4j",
      riskClass: "High",
      allowedConfigs: ["A", "B", "C", "D", "E"],
    });
    expect(converted.value.caseId).toBe(VUL4J_SAMPLE_VUL_ID);
    expect(converted.value.repoPath).toBe(REPO_PATH);
  });

  it("diff = 源码修复补丁的逆 diff（diff -u 风格，路径归一为仓库相对）", () => {
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    const expected = [
      `--- ${VUL4J_SAMPLE_SRC_PATH}`,
      `+++ ${VUL4J_SAMPLE_SRC_PATH}`,
      "@@ -7,4 +7,4 @@",
      "         if (input == null) {",
      "+            return new byte[0];",
      '-            throw new IllegalArgumentException("input required");',
      "         }",
      "         return Base64.getDecoder().decode(input);",
      "",
    ].join("\n");
    expect(converted.value.diff).toBe(expected);
  });

  it("truth = 源码修复补丁的行位（buggy 坐标系）与性质（SECURITY）", () => {
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    expect(converted.value.truth).toEqual({
      locations: [{ file: VUL4J_SAMPLE_SRC_PATH, lineStart: 8, lineEnd: 8, defectNature: "SECURITY" }],
      fixPatch: VUL4J_SAMPLE_SRC_PATCH,
    });
  });

  it("extensions 携带 CVE/CWE/fixSha 与剥离留痕（全 string 值）", () => {
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    expect(converted.value.extensions).toEqual({
      vulId: VUL4J_SAMPLE_VUL_ID,
      repoSlug: VUL4J_SAMPLE_REPO_SLUG,
      fixCommitUrl: VUL4J_SAMPLE_FIX_COMMIT_URL,
      fixSha: VUL4J_SAMPLE_FIX_SHA,
      nature: "SECURITY",
      natureMatched: "true",
      cveId: VUL4J_SAMPLE_CVE_ID,
      cweId: VUL4J_SAMPLE_CWE_ID,
      cweName: VUL4J_SAMPLE_CWE_NAME,
      excludedTestFiles: VUL4J_SAMPLE_TEST_PATH,
      excludedBinaryFiles: VUL4J_SAMPLE_BINARY_PATH,
    });
  });

  it("未映射 CWE 的条目在 extensions 留下 nature=OTHER / natureMatched=false", () => {
    const unmapped = vul4jToMrCase(sampleInput({ cweId: "CWE-19" }), { repoPath: REPO_PATH });
    expect(unmapped.ok).toBe(true);
    if (unmapped.ok) {
      expect(unmapped.value.extensions?.nature).toBe("OTHER");
      expect(unmapped.value.extensions?.natureMatched).toBe("false");
      expect(unmapped.value.truth?.locations[0]?.defectNature).toBe("OTHER");
    }
  });

  it("逆补丁语义自检：MR diff 应用于 fixed 快照还原出 buggy，修复补丁可回放（round-trip）", () => {
    expect(converted.ok).toBe(true);
    const record = vul4jToDefectRecord(sampleInput());
    expect(record.ok).toBe(true);
    if (!converted.ok || !record.ok) {
      return;
    }
    const applied = applyUnifiedDiff(VUL4J_SAMPLE_FIXED_SOURCES, converted.value.diff);
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.value.sources[VUL4J_SAMPLE_SRC_PATH]).toBe(VUL4J_SAMPLE_BUGGY_DECODER);
    }

    const buggySnapshot: SourceSnapshot = {
      ...VUL4J_SAMPLE_FIXED_SOURCES,
      [VUL4J_SAMPLE_SRC_PATH]: VUL4J_SAMPLE_BUGGY_DECODER,
    };
    const verification = verifyInverseSemantics(
      { ...record.value, buggySources: buggySnapshot },
      converted.value,
    );
    expect(verification.ok).toBe(true);
    if (verification.ok) {
      expect(verification.value.applyOk).toBe(true);
      expect(verification.value.buggyMatches).toBe(true);
      expect(verification.value.roundTripOk).toBe(true);
    }
  });
});

describe("输入校验（边界输入显式失败，不静默）", () => {
  it.each([
    ["vulId 非法", sampleInput({ vulId: "vul4j-1" }), "vulId"],
    ["vulId 空串", sampleInput({ vulId: "" }), "vulId"],
    ["repoSlug 空串", sampleInput({ repoSlug: " " }), "repoSlug"],
    ["fixCommitUrl 非 GitHub", sampleInput({ fixCommitUrl: "https://bitbucket.org/x/y/commit/abc" }), "fixCommitUrl"],
    ["fixDiff 空串", sampleInput({ fixDiff: "" }), "fixDiff"],
    ["fixedSources 空", sampleInput({ fixedSources: {} }), "fixedSources"],
  ])("%s → INVALID_INPUT", (_name, input, field) => {
    const result = vul4jToMrCase(input, { repoPath: REPO_PATH });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
      expect(result.error.message).toContain(field);
    }
  });
});

describe("extractFixSha", () => {
  it("commit 直链取完整 SHA；compare 取 `..` 右侧（修复侧）", () => {
    const head = "b".repeat(40);
    expect(extractFixSha(VUL4J_SAMPLE_FIX_COMMIT_URL)).toBe(VUL4J_SAMPLE_FIX_SHA);
    expect(extractFixSha(`https://github.com/example/codec/compare/${"1".repeat(40)}..${head}`)).toBe(head);
    expect(extractFixSha("https://github.com/example/codec/tree/main")).toBe("");
  });
});

describe("vul4jToMrCases（批量转换）", () => {
  it("逐条转换，失败项显式收集不静默跳过", () => {
    const { cases, failures } = vul4jToMrCases(
      [sampleInput(), sampleInput({ vulId: "VUL4J-100" }), sampleInput({ vulId: "bad-id" })],
      () => REPO_PATH,
    );
    expect(cases).toHaveLength(2);
    expect(cases.map((c) => c.caseId)).toEqual([VUL4J_SAMPLE_VUL_ID, "VUL4J-100"]);
    expect(failures).toEqual([
      { vulId: "bad-id", code: "INVALID_INPUT", message: expect.stringContaining("vulId") },
    ]);
  });
});
