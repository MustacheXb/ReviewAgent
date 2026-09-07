import { describe, expect, it } from "vitest";
import { convertDefectRecord, convertDefectRecords, type ConvertOptions } from "../src/dataset/inverse-patch.js";
import { verifyInverseSemantics } from "../src/dataset/verify-inverse.js";
import { applyUnifiedDiff } from "../src/dataset/diff/apply-unified-diff.js";
import {
  BUGGY_SOURCES,
  DEFECT_RECORD,
  FIXED_SOURCES,
  FIX_PATCH,
  ISSUE_DESCRIPTION,
  PARSER_PATH,
  UTIL_PATH,
} from "./fixtures/defect-pair.js";

const OPTS: ConvertOptions = { repoPath: "D:/repos/example-fixed" };

describe("convertDefectRecord（逆补丁法 MR 构造器）", () => {
  it("验收 1：MR 合入后代码状态等于历史 buggy 版本（逆 diff 语义正确）", () => {
    const converted = convertDefectRecord(DEFECT_RECORD, OPTS);
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    const mrCase = converted.value;
    const applied = applyUnifiedDiff(FIXED_SOURCES, mrCase.diff);
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }
    expect(applied.value.sources).toEqual(BUGGY_SOURCES);
    expect(applied.value.deletedPaths).toEqual([]);
  });

  it("验收 1（三重自检）：applyOk / buggyMatches / roundTripOk 全真", () => {
    const converted = convertDefectRecord(DEFECT_RECORD, OPTS);
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    const verification = verifyInverseSemantics(DEFECT_RECORD, converted.value);
    expect(verification.ok).toBe(true);
    if (!verification.ok) {
      return;
    }
    expect(verification.value.applyOk).toBe(true);
    expect(verification.value.buggyMatches).toBe(true);
    expect(verification.value.roundTripOk).toBe(true);
  });

  it("验收 2：真值精确到最小修复补丁的行位与性质，附 issue 描述", () => {
    const converted = convertDefectRecord(DEFECT_RECORD, OPTS);
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    const { truth, issueDescription } = converted.value;
    expect(issueDescription).toBe(ISSUE_DESCRIPTION);
    expect(truth?.fixPatch).toBe(FIX_PATCH);
    expect(truth?.locations).toEqual([
      // Parser 修复为纯新增 null 防御：锚定插入点后的第一条现存 buggy 行（return 行，第 5 行）
      { file: PARSER_PATH, lineStart: 5, lineEnd: 5, defectNature: "NULL_SAFETY" },
      // Util 修复为单行替换：remove 行即 buggy 第 5 行
      { file: UTIL_PATH, lineStart: 5, lineEnd: 5, defectNature: "BOUNDARY" },
    ]);
  });

  it("真值行位落在 MR diff 的新增行上（buggy 坐标系一致性）", () => {
    const converted = convertDefectRecord(DEFECT_RECORD, OPTS);
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    // Util 的真值行（buggy 第 5 行）在逆 diff 中必须是被新增（+）回 buggy 的行
    expect(converted.value.diff).toContain("+        return Math.max(hi, Math.min(lo, v));");
    // buggy 第 5 行恰为该缺陷行
    expect(BUGGY_SOURCES[UTIL_PATH]?.split("\n")[4]).toBe("        return Math.max(hi, Math.min(lo, v));");
  });

  it("产出 MRCase 的基本字段与缺省标签", () => {
    const converted = convertDefectRecord(DEFECT_RECORD, OPTS);
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    const mrCase = converted.value;
    expect(mrCase.caseId).toBe("Example-1");
    expect(mrCase.repoPath).toBe("D:/repos/example-fixed");
    expect(mrCase.labels).toEqual({
      source: "defects4j",
      riskClass: "Medium",
      allowedConfigs: ["A", "B", "C", "D", "E"],
    });
  });

  it("选项可覆盖标签（source / riskClass / allowedConfigs）", () => {
    const converted = convertDefectRecord(DEFECT_RECORD, {
      repoPath: "D:/repos/example-fixed",
      source: "vul4j",
      riskClass: "High",
      allowedConfigs: ["C", "E"],
    });
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    expect(converted.value.labels).toEqual({
      source: "vul4j",
      riskClass: "High",
      allowedConfigs: ["C", "E"],
    });
  });

  it("record 内置缺省标签在无选项覆盖时生效", () => {
    const converted = convertDefectRecord(
      { ...DEFECT_RECORD, source: "msb-java", riskClass: "Low", allowedConfigs: ["A"] },
      OPTS,
    );
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    expect(converted.value.labels).toEqual({ source: "msb-java", riskClass: "Low", allowedConfigs: ["A"] });
  });

  it("拒绝空 repoPath", () => {
    const converted = convertDefectRecord(DEFECT_RECORD, { repoPath: "  " });
    expect(converted.ok).toBe(false);
    if (!converted.ok) {
      expect(converted.error.code).toBe("INVALID_OPTIONS");
    }
  });

  it("拒绝 fixPatch 触碰的文件不在 fixedSources 中", () => {
    const converted = convertDefectRecord(
      { ...DEFECT_RECORD, fixedSources: { "other/File.java": "class A {}\n" } },
      OPTS,
    );
    expect(converted.ok).toBe(false);
    if (!converted.ok) {
      expect(converted.error.code).toBe("INVALID_FIX_PATCH");
    }
  });

  it("拒绝非法缺陷性质", () => {
    const converted = convertDefectRecord(
      { ...DEFECT_RECORD, defectNatures: { [PARSER_PATH]: "NOT_IN_VOCAB" } },
      OPTS,
    );
    expect(converted.ok).toBe(false);
    if (!converted.ok) {
      expect(converted.error.code).toBe("INVALID_NATURE");
    }
  });

  it("空 issue 描述允许（Defects4J 无 issue 正文时降级），产出为空串", () => {
    const converted = convertDefectRecord({ ...DEFECT_RECORD, issueDescription: "" }, OPTS);
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    expect(converted.value.issueDescription).toBe("");
  });

  it("缺省 issue 描述（字段缺省）产出为空串", () => {
    const { issueDescription: _omit, ...recordWithoutIssue } = DEFECT_RECORD;
    const converted = convertDefectRecord(recordWithoutIssue, OPTS);
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    expect(converted.value.issueDescription).toBe("");
  });

  it("拒绝含重命名文件的补丁", () => {
    const renamePatch = "--- a/A.java\n+++ b/B.java\n@@ -1 +1 @@\n-x\n+y\n";
    const converted = convertDefectRecord(
      { ...DEFECT_RECORD, fixPatch: renamePatch },
      OPTS,
    );
    expect(converted.ok).toBe(false);
    if (!converted.ok) {
      expect(converted.error.code).toBe("INVALID_FIX_PATCH");
      expect(converted.error.message).toContain("重命名");
    }
  });

  it("批量转换：失败项显式留痕，不静默跳过", () => {
    const badRecord = { ...DEFECT_RECORD, recordId: "Bad-1", fixedSources: { "other/File.java": "class A {}\n" } };
    const { cases, failures } = convertDefectRecords(
      [DEFECT_RECORD, badRecord],
      () => "D:/repos/x",
    );
    expect(cases).toHaveLength(1);
    expect(cases[0]?.caseId).toBe("Example-1");
    expect(failures).toEqual([
      { recordId: "Bad-1", code: "INVALID_FIX_PATCH", message: expect.stringContaining("不在 fixedSources") },
    ]);
  });
});
