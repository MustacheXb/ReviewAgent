import { describe, expect, it } from "vitest";
import { defects4jToDefectRecord } from "../src/dataset/defects4j/adapter.js";
import { convertDefectRecord } from "../src/dataset/inverse-patch.js";
import { verifyInverseSemantics } from "../src/dataset/verify-inverse.js";
import { applyUnifiedDiff } from "../src/dataset/diff/apply-unified-diff.js";

const REPO_PATH = "org/apache/commons/lang3/math/Fraction.java";
const FULL_PATH = `src/java/${REPO_PATH}`;

const BUGGY_FRACTION = [
  "package org.apache.commons.lang3.math;",
  "",
  "public class Fraction extends Number {",
  "    public Fraction reduce() {",
  "        return this;",
  "    }",
  "}",
  "",
].join("\n");

const FIXED_FRACTION = [
  "package org.apache.commons.lang3.math;",
  "",
  "public class Fraction extends Number {",
  "    public Fraction reduce() {",
  "        int gcd = greatestCommonDivisor(numerator, denominator);",
  "        return Fraction.getFraction(numerator / gcd, denominator / gcd);",
  "    }",
  "}",
  "",
].join("\n");

/**
 * Defects4J `<bid>.src.patch` 原生方向：fixed→buggy 的人工最小化逆补丁
 * （官方 README：patching the fixed version with this patch will reintroduce the fault）。
 */
const SRC_PATCH = [
  `--- ${REPO_PATH}`,
  `+++ ${REPO_PATH}`,
  "@@ -3,6 +3,5 @@",
  " public class Fraction extends Number {",
  "     public Fraction reduce() {",
  "-        int gcd = greatestCommonDivisor(numerator, denominator);",
  "-        return Fraction.getFraction(numerator / gcd, denominator / gcd);",
  "+        return this;",
  "     }",
  " }",
].join("\n") + "\n";

function makeInput() {
  return {
    project: "Lang",
    bugId: 33,
    srcPatch: SRC_PATCH,
    fixedFiles: { [FULL_PATH]: FIXED_FRACTION },
    issueDescription: "Fraction.reduce does not reduce the fraction to its lowest terms.",
    reportUrl: "https://issues.apache.org/jira/browse/LANG-663",
    defectNatures: { [REPO_PATH]: "CORRECTNESS" },
    patchPathPrefix: "src/java/",
  };
}

describe("defects4jToDefectRecord（Defects4J 适配层）", () => {
  it("srcPatch（fixed→buggy）求反为 fixPatch（buggy→fixed），路径重写为仓库相对路径", () => {
    const result = defects4jToDefectRecord(makeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const record = result.value;
    expect(record.recordId).toBe("Lang-33");
    expect(record.source).toBe("defects4j");
    expect(record.reportUrl).toBe("https://issues.apache.org/jira/browse/LANG-663");
    // fixPatch 方向为 buggy→fixed：删除 buggy 的 return this; 行
    expect(record.fixPatch).toContain("-        return this;");
    expect(record.fixPatch).toContain(`--- ${FULL_PATH}`);
    expect(record.fixPatch).toContain(`+++ ${FULL_PATH}`);
    expect(record.fixedSources[FULL_PATH]).toBe(FIXED_FRACTION);
  });

  it("buggyFiles 缺省时按定义自动求出：buggy = fixed + srcPatch", () => {
    const result = defects4jToDefectRecord(makeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.buggySources).toEqual({ [FULL_PATH]: BUGGY_FRACTION });
  });

  it("缺陷性质键随前缀重映射", () => {
    const result = defects4jToDefectRecord(makeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.defectNatures).toEqual({ [FULL_PATH]: "CORRECTNESS" });
  });

  it("issueDescription 缺省允许（d4j 不随仓库分发 issue 正文）", () => {
    const { issueDescription: _omit, ...inputWithoutIssue } = makeInput();
    const result = defects4jToDefectRecord(inputWithoutIssue);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.issueDescription).toBeUndefined();
  });

  it("srcPatch 无法应用于 fixed 快照时显式报错（base 错误防护）", () => {
    const result = defects4jToDefectRecord({
      ...makeInput(),
      fixedFiles: { [FULL_PATH]: "totally different content\n" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SRC_PATCH_NOT_APPLICABLE");
    }
  });

  it("适配 → 转换 → 语义自检 全链路（纯函数旁路）", () => {
    const record = defects4jToDefectRecord(makeInput());
    expect(record.ok).toBe(true);
    if (!record.ok) {
      return;
    }
    const converted = convertDefectRecord(record.value, { repoPath: "D:/datasets/d4j/Lang-33-fixed" });
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    const verification = verifyInverseSemantics(record.value, converted.value);
    expect(verification.ok).toBe(true);
    if (!verification.ok) {
      return;
    }
    expect(verification.value.applyOk).toBe(true);
    expect(verification.value.buggyMatches).toBe(true);
    expect(verification.value.roundTripOk).toBe(true);
    // 真值：remove 行（buggy 第 5 行 return this;）+ 性质
    expect(converted.value.truth?.locations).toEqual([
      { file: FULL_PATH, lineStart: 5, lineEnd: 5, defectNature: "CORRECTNESS" },
    ]);
  });

  it("MR diff 与原始 srcPatch 语义等价（都能把 fixed 变成 buggy）", () => {
    const record = defects4jToDefectRecord(makeInput());
    expect(record.ok).toBe(true);
    if (!record.ok) {
      return;
    }
    const converted = convertDefectRecord(record.value, { repoPath: "D:/datasets/d4j/Lang-33-fixed" });
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    // 原始 srcPatch 以源码根相对路径书写，用同键快照作对照
    const rootKeyed = { [REPO_PATH]: FIXED_FRACTION };
    const viaMrDiff = applyUnifiedDiff(record.value.fixedSources, converted.value.diff);
    const viaSrcPatch = applyUnifiedDiff(rootKeyed, SRC_PATCH);
    expect(viaMrDiff.ok).toBe(true);
    expect(viaSrcPatch.ok).toBe(true);
    if (viaMrDiff.ok && viaSrcPatch.ok) {
      expect(viaMrDiff.value.sources[FULL_PATH]).toBe(viaSrcPatch.value.sources[REPO_PATH]);
      expect(viaMrDiff.value.sources[FULL_PATH]).toBe(BUGGY_FRACTION);
    }
  });

  it("拒绝非法项目 key / bugId / 空补丁 / 空快照", () => {
    expect(defects4jToDefectRecord({ ...makeInput(), project: "not a key!" }).ok).toBe(false);
    expect(defects4jToDefectRecord({ ...makeInput(), bugId: 0 }).ok).toBe(false);
    expect(defects4jToDefectRecord({ ...makeInput(), bugId: 1.5 }).ok).toBe(false);
    expect(defects4jToDefectRecord({ ...makeInput(), srcPatch: "  " }).ok).toBe(false);
    expect(defects4jToDefectRecord({ ...makeInput(), fixedFiles: {} }).ok).toBe(false);
  });

  it("补丁不可解析时显式报错", () => {
    const result = defects4jToDefectRecord({ ...makeInput(), srcPatch: "garbage" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_FIX_PATCH");
    }
  });
});
