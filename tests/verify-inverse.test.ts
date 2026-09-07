import { describe, expect, it } from "vitest";
import { verifyInverseSemantics } from "../src/dataset/verify-inverse.js";
import { convertDefectRecord } from "../src/dataset/inverse-patch.js";
import { DEFECT_RECORD } from "./fixtures/defect-pair.js";

const OPTS = { repoPath: "D:/repos/example-fixed" };

describe("verifyInverseSemantics（逆补丁语义自检）", () => {
  it("完整 defectRecord：三项校验全过", () => {
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
    expect(verification.value).toEqual({
      caseId: "Example-1",
      applyOk: true,
      buggyMatches: true,
      roundTripOk: true,
      detail: expect.any(String),
    });
  });

  it("未提供 buggy 快照时 buggyMatches 为 null，但回环校验仍执行", () => {
    const { buggySources: _omit, ...recordWithoutBuggy } = DEFECT_RECORD;
    const converted = convertDefectRecord(recordWithoutBuggy, OPTS);
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    const verification = verifyInverseSemantics(recordWithoutBuggy, converted.value);
    expect(verification.ok).toBe(true);
    if (!verification.ok) {
      return;
    }
    expect(verification.value.buggyMatches).toBeNull();
    expect(verification.value.roundTripOk).toBe(true);
  });

  it("buggy 快照与合入结果不一致时显式报告", () => {
    const converted = convertDefectRecord(DEFECT_RECORD, OPTS);
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    const wrongBuggy = {
      ...DEFECT_RECORD,
      buggySources: { ...DEFECT_RECORD.buggySources!, "extra/File.java": "class X {}\n" },
    };
    const verification = verifyInverseSemantics(wrongBuggy, converted.value);
    expect(verification.ok).toBe(true);
    if (!verification.ok) {
      return;
    }
    expect(verification.value.buggyMatches).toBe(false);
  });

  it("MR diff 无法应用时 applyOk=false 且 detail 说明原因", () => {
    const converted = convertDefectRecord(DEFECT_RECORD, OPTS);
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    const shifted = {
      ...DEFECT_RECORD,
      fixedSources: { ...DEFECT_RECORD.fixedSources, [Object.keys(DEFECT_RECORD.fixedSources)[0]!]: "changed content\n" },
    };
    const verification = verifyInverseSemantics(shifted, converted.value);
    expect(verification.ok).toBe(true);
    if (!verification.ok) {
      return;
    }
    expect(verification.value.applyOk).toBe(false);
    expect(verification.value.detail).toContain("无法应用");
  });

  it("caseId 与 recordId 不一致时报错", () => {
    const converted = convertDefectRecord(DEFECT_RECORD, OPTS);
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    const verification = verifyInverseSemantics(
      { ...DEFECT_RECORD, recordId: "Other-9" },
      converted.value,
    );
    expect(verification.ok).toBe(false);
    if (!verification.ok) {
      expect(verification.error.code).toBe("MISMATCH");
    }
  });
});
