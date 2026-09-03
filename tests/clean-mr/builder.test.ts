import { describe, expect, it } from "vitest";
import type { MRCase } from "../../src/contracts/mr-case.js";
import { CONFIGS } from "../../src/contracts/config.js";
import { validateRunInputs } from "../../src/run/validate-inputs.js";
import { filterMrCases } from "../../src/dataset/mr-boundary-filter.js";
import { convertDefectRecord } from "../../src/dataset/inverse-patch.js";
import {
  buildCleanMrCase,
  buildCleanMrCaseId,
  buildCleanMrCases,
  CLEAN_MR_SOURCE,
  isCleanMrCaseId,
  isNegativeControl,
} from "../../src/dataset/clean-mr/builder.js";
import { DEFECT_RECORD } from "../fixtures/defect-pair.js";
import { SAMPLE_JAVA_DIFF } from "../fixtures/clean-mr.js";

const OPTS = { repoPath: "D:/repos/gson-at-base" };

describe("buildCleanMrCaseId", () => {
  it("caseId = clean-<org>__<repo>-<number>", () => {
    expect(buildCleanMrCaseId("fasterxml", "jackson-databind", 4213)).toBe(
      "clean-fasterxml__jackson-databind-4213",
    );
    expect(buildCleanMrCaseId("google", "gson", 3102)).toBe("clean-google__gson-3102");
  });

  it("isCleanMrCaseId 校验形制", () => {
    expect(isCleanMrCaseId("clean-google__gson-3102")).toBe(true);
    expect(isCleanMrCaseId("google__gson-3102")).toBe(false);
    expect(isCleanMrCaseId("clean-google__gson")).toBe(false);
    expect(isCleanMrCaseId("clean-google__gson-abc")).toBe(false);
    expect(isCleanMrCaseId("")).toBe(false);
  });
});

describe("buildCleanMrCase（阴性对照口径）", () => {
  it("truth 显式为 null——clean MR 无缺陷真值（工单验收 2）", () => {
    const result = buildCleanMrCase({ caseId: "clean-google__gson-3102", diff: SAMPLE_JAVA_DIFF }, OPTS);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.truth).toBeNull();
    expect(result.value.caseId).toBe("clean-google__gson-3102");
    expect(result.value.diff).toBe(SAMPLE_JAVA_DIFF);
  });

  it("issueDescription 为空串（契约：clean MR 无背景提示，检视不给真值线索）", () => {
    const result = buildCleanMrCase({ caseId: "clean-google__gson-3102", diff: SAMPLE_JAVA_DIFF }, OPTS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.issueDescription).toBe("");
    }
  });

  it("labels：source=clean-mr、riskClass 缺省 Medium、allowedConfigs 缺省全部五配置（A vs C 对比可用）", () => {
    const result = buildCleanMrCase({ caseId: "clean-google__gson-3102", diff: SAMPLE_JAVA_DIFF }, OPTS);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.labels).toEqual({
      source: CLEAN_MR_SOURCE,
      riskClass: "Medium",
      allowedConfigs: ["A", "B", "C", "D", "E"],
    });
    expect(result.value.labels.allowedConfigs).toContain("A");
    expect(result.value.labels.allowedConfigs).toContain("C");
  });

  it("显式 riskClass / allowedConfigs 覆盖缺省", () => {
    const result = buildCleanMrCase(
      { caseId: "clean-google__gson-3102", diff: SAMPLE_JAVA_DIFF, riskClass: "Low", allowedConfigs: ["A", "C"] },
      OPTS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.labels.riskClass).toBe("Low");
      expect(result.value.labels.allowedConfigs).toEqual(["A", "C"]);
    }
  });

  it("repoPath 透传", () => {
    const result = buildCleanMrCase({ caseId: "clean-google__gson-3102", diff: SAMPLE_JAVA_DIFF }, OPTS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.repoPath).toBe("D:/repos/gson-at-base");
    }
  });

  it("输入校验：caseId 形制、diff 非空可解析、repoPath 非空", () => {
    expect(buildCleanMrCase({ caseId: "gson-3102", diff: SAMPLE_JAVA_DIFF }, OPTS).ok).toBe(false);
    expect(buildCleanMrCase({ caseId: "clean-google__gson-3102", diff: "" }, OPTS).ok).toBe(false);
    expect(buildCleanMrCase({ caseId: "clean-google__gson-3102", diff: "garbage" }, OPTS).ok).toBe(false);
    expect(buildCleanMrCase({ caseId: "clean-google__gson-3102", diff: SAMPLE_JAVA_DIFF }, { repoPath: "" }).ok).toBe(
      false,
    );
  });
});

describe("isNegativeControl（FP 口径分流谓词，T10/T12 消费）", () => {
  it("clean MRCase（truth=null）为阴性对照", () => {
    const result = buildCleanMrCase({ caseId: "clean-google__gson-3102", diff: SAMPLE_JAVA_DIFF }, OPTS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(isNegativeControl(result.value)).toBe(true);
    }
  });

  it("带真值的 MRCase（逆补丁法构造）不是阴性对照", () => {
    const converted = convertDefectRecord(DEFECT_RECORD, { repoPath: "D:/repos/x" });
    expect(converted.ok).toBe(true);
    if (converted.ok) {
      expect(isNegativeControl(converted.value)).toBe(false);
    }
  });
});

describe("buildCleanMrCases（批量）", () => {
  it("逐条构造，失败显式收集不静默跳过", () => {
    const records = [
      { caseId: "clean-google__gson-3102", diff: SAMPLE_JAVA_DIFF },
      { caseId: "clean-google__gson-3103", diff: SAMPLE_JAVA_DIFF },
      { caseId: "bad-id", diff: SAMPLE_JAVA_DIFF },
      { caseId: "clean-google__gson-3104", diff: "not a diff" },
    ];
    const { cases, failures } = buildCleanMrCases(records, () => "D:/repos/gson");
    expect(cases).toHaveLength(2);
    expect(failures.map((f) => f.caseId)).toEqual(["bad-id", "clean-google__gson-3104"]);
    expect(failures.every((f) => f.message.length > 0)).toBe(true);
  });
});

describe("与 T01/T02 基座的衔接（旁路集成）", () => {
  function cleanCase(): MRCase {
    const result = buildCleanMrCase({ caseId: "clean-google__gson-3102", diff: SAMPLE_JAVA_DIFF }, OPTS);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.value;
  }

  it("T01 harness 输入校验接受 truth=null 的 clean MRCase（判定链按阴性对照口径可运行）", () => {
    const llmStub = { complete: async () => ({}) };
    expect(() => validateRunInputs(CONFIGS.A, cleanCase(), llmStub as never, {})).not.toThrow();
    expect(() => validateRunInputs(CONFIGS.C, cleanCase(), llmStub as never, {})).not.toThrow();
  });

  it("T02 边界过滤：样例 clean MR 通过（≤10 文件 / ≤2000 变更行）", () => {
    const { accepted, report } = filterMrCases([cleanCase()]);
    expect(accepted).toHaveLength(1);
    expect(report.rejected).toHaveLength(0);
    expect(report.acceptedCount).toBe(1);
  });
});
