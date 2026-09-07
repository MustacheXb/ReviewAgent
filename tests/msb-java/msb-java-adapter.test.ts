import { describe, expect, it } from "vitest";
import type { RiskClass } from "../../src/dataset/risk-class.js";
import {
  buildMsbIssueDescription,
  buildNewSideTruthLocations,
  MSB_JAVA_ALLOWED_CONFIGS,
  MSB_JAVA_SOURCE,
  msbRecordToMrCase,
  msbRecordsToMrCases,
  validateMsbRecord,
  type MsbRecord,
} from "../../src/dataset/msb-java/adapter.js";
import {
  MSB_SAMPLE_BASE_SHA,
  MSB_SAMPLE_FIX_PATCH,
  MSB_SAMPLE_INSTANCE_ID,
  MSB_SAMPLE_PATH,
  MSB_SAMPLE_RECORD,
} from "../fixtures/msb-sample.js";

const REPO_PATH = "D:/repos/jackson-databind-base";

interface RecordOverrides {
  readonly body?: string | null;
  readonly riskClass?: RiskClass;
}

function withBody(overrides: RecordOverrides = {}): Record<string, unknown> {
  return { ...MSB_SAMPLE_RECORD, body: "Replaces null with empty string.", ...overrides };
}

describe("validateMsbRecord（HF JSONL 形状校验）", () => {
  it("夹具记录校验通过；body=null 降级空串（实测 23 条 null）", () => {
    const validated = validateMsbRecord(MSB_SAMPLE_RECORD);
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.value).toEqual({
        instanceId: MSB_SAMPLE_INSTANCE_ID,
        org: "fasterxml",
        repo: "jackson-databind",
        number: 4487,
        title: "Fix NPE in JsonNode.toString",
        body: "",
        baseSha: MSB_SAMPLE_BASE_SHA,
        fixPatch: MSB_SAMPLE_FIX_PATCH,
        resolvedIssues: [
          {
            number: 4486,
            title: "NPE when node is null",
            body: "Steps: call toString on a node built from a null token.",
          },
        ],
      } satisfies MsbRecord);
    }
  });

  it.each([
    ["非对象", "just-a-string"],
    ["数组", [1, 2]],
    ["缺 instance_id", { ...MSB_SAMPLE_RECORD, instance_id: undefined }],
    ["instance_id 空串", { ...MSB_SAMPLE_RECORD, instance_id: "" }],
    ["缺 org", { ...MSB_SAMPLE_RECORD, org: undefined }],
    ["number 非正整数", { ...MSB_SAMPLE_RECORD, number: 0 }],
    ["number 为字符串", { ...MSB_SAMPLE_RECORD, number: "4487" }],
    ["title 空", { ...MSB_SAMPLE_RECORD, title: " " }],
    ["body 非字符串非 null", { ...MSB_SAMPLE_RECORD, body: 42 }],
    ["base.sha 短哈希", { ...MSB_SAMPLE_RECORD, base: { label: "master", ref: "master", sha: "abc123" } }],
    ["fix_patch 空", { ...MSB_SAMPLE_RECORD, fix_patch: "" }],
    ["resolved_issues 空数组", { ...MSB_SAMPLE_RECORD, resolved_issues: [] }],
    ["resolved_issues 项缺 number", { ...MSB_SAMPLE_RECORD, resolved_issues: [{ title: "x" }] }],
    ["resolved_issues 项 body 非法", { ...MSB_SAMPLE_RECORD, resolved_issues: [{ number: 1, title: "x", body: 7 }] }],
  ])("%s → INVALID_RECORD 显式报错", (_name, record) => {
    const validated = validateMsbRecord(record);
    expect(validated.ok).toBe(false);
    if (!validated.ok) {
      expect(validated.error.code).toBe("INVALID_RECORD");
    }
  });

  it("resolved_issues[].body 为 null 合法（降级空串）", () => {
    const validated = validateMsbRecord({
      ...MSB_SAMPLE_RECORD,
      resolved_issues: [{ number: 4486, title: "NPE when node is null", body: null }],
    });
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.value.resolvedIssues[0]?.body).toBe("");
    }
  });
});

describe("buildNewSideTruthLocations（fix_patch 新侧真值行段，手算期望）", () => {
  it("夹具补丁：remove+add+add 连续变更段 → 新侧 4..5", () => {
    const locations = buildNewSideTruthLocations(MSB_SAMPLE_FIX_PATCH);
    expect(locations.ok).toBe(true);
    if (locations.ok) {
      expect(locations.value).toEqual([
        { file: MSB_SAMPLE_PATH, lineStart: 4, lineEnd: 5, defectNature: "CORRECTNESS" },
      ]);
    }
  });

  it("纯删除段（段后有 context）锚定删除点后第一条现存新侧行", () => {
    const patch = [
      "--- a/src/main/java/com/example/Service.java",
      "+++ b/src/main/java/com/example/Service.java",
      "@@ -2,4 +2,3 @@",
      " public class Service {",
      "-    buggy();",
      "     return ok();",
      " }",
      "",
    ].join("\n");
    const locations = buildNewSideTruthLocations(patch);
    expect(locations.ok).toBe(true);
    if (locations.ok) {
      expect(locations.value).toEqual([
        { file: "src/main/java/com/example/Service.java", lineStart: 3, lineEnd: 3, defectNature: "CORRECTNESS" },
      ]);
    }
  });

  it("纯删除段位于 hunk 末尾锚定其前最后一行", () => {
    const patch = [
      "--- a/src/main/java/com/example/Service.java",
      "+++ b/src/main/java/com/example/Service.java",
      "@@ -3,3 +3,2 @@",
      "     public Result run() {",
      "         return ok();",
      "-        logBuggy();",
      "",
    ].join("\n");
    const locations = buildNewSideTruthLocations(patch);
    expect(locations.ok).toBe(true);
    if (locations.ok) {
      expect(locations.value).toEqual([
        { file: "src/main/java/com/example/Service.java", lineStart: 4, lineEnd: 4, defectNature: "CORRECTNESS" },
      ]);
    }
  });

  it("新建文件 → 新侧 1..N", () => {
    const patch = [
      "--- /dev/null",
      "+++ b/src/main/java/com/example/New.java",
      "@@ -0,0 +1,2 @@",
      "+package com.example;",
      "+class New {}",
      "",
    ].join("\n");
    const locations = buildNewSideTruthLocations(patch);
    expect(locations.ok).toBe(true);
    if (locations.ok) {
      expect(locations.value).toEqual([
        { file: "src/main/java/com/example/New.java", lineStart: 1, lineEnd: 2, defectNature: "CORRECTNESS" },
      ]);
    }
  });

  it("删除整个文件无新侧行位——跳过；与修改文件混合时仅产出修改文件的真值", () => {
    const deletion = [
      "--- a/src/main/java/com/example/Old.java",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-goodbye",
      "",
    ].join("\n");
    const locations = buildNewSideTruthLocations(MSB_SAMPLE_FIX_PATCH + deletion);
    expect(locations.ok).toBe(true);
    if (locations.ok) {
      expect(locations.value).toEqual([
        { file: MSB_SAMPLE_PATH, lineStart: 4, lineEnd: 5, defectNature: "CORRECTNESS" },
      ]);
    }
  });

  it("全部文件被删除 → EMPTY_TRUTH 显式报错（真实 PR 形态真值不可构造）", () => {
    const patch = [
      "--- a/src/main/java/com/example/Old.java",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-goodbye",
      "",
    ].join("\n");
    const locations = buildNewSideTruthLocations(patch);
    expect(locations.ok).toBe(false);
    if (!locations.ok) {
      expect(locations.error.code).toBe("EMPTY_TRUTH");
    }
  });

  it("非法补丁 → MALFORMED_FIX_PATCH；defectNature 可覆盖", () => {
    expect(buildNewSideTruthLocations("not a diff").ok).toBe(false);
    const overridden = buildNewSideTruthLocations(MSB_SAMPLE_FIX_PATCH, "NULL_SAFETY");
    expect(overridden.ok).toBe(true);
    if (overridden.ok) {
      expect(overridden.value[0]?.defectNature).toBe("NULL_SAFETY");
    }
  });
});

describe("msbRecordToMrCase（JSONL 记录 → MRCase，真实 PR 形态）", () => {
  const converted = msbRecordToMrCase(MSB_SAMPLE_RECORD, { repoPath: REPO_PATH });

  it("diff = fix_patch 原文（不走逆补丁反转，base = base.sha 的 PR 前版本）", () => {
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    expect(converted.value.diff).toBe(MSB_SAMPLE_FIX_PATCH);
    expect(converted.value.caseId).toBe(MSB_SAMPLE_INSTANCE_ID);
    expect(converted.value.repoPath).toBe(REPO_PATH);
  });

  it("labels：source=msb-java、riskClass 缺省 Medium、allowedConfigs=[C,E]（spec：只跑 C/E）", () => {
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    expect(converted.value.labels).toEqual({
      source: MSB_JAVA_SOURCE,
      riskClass: "Medium",
      allowedConfigs: MSB_JAVA_ALLOWED_CONFIGS,
    });
  });

  it("truth = fix_patch 新侧行段（MR 合入后坐标）+ fixPatch 原文；defectNature 缺省 CORRECTNESS", () => {
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    expect(converted.value.truth).toEqual({
      locations: [{ file: MSB_SAMPLE_PATH, lineStart: 4, lineEnd: 5, defectNature: "CORRECTNESS" }],
      fixPatch: MSB_SAMPLE_FIX_PATCH,
    });
  });

  it("issueDescription：PR 标题/正文 + 关联 issue 标题/正文（body=null 降级跳过）", () => {
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    expect(converted.value.issueDescription).toBe(
      "PR #4487: Fix NPE in JsonNode.toString\n\n" +
        "Linked issue #4486: NPE when node is null\n\n" +
        "Steps: call toString on a node built from a null token.",
    );
  });

  it("extensions 携带 baseSha/org/repo/number/prUrl（T12 checkout 与溯源依据）", () => {
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    expect(converted.value.extensions).toEqual({
      instanceId: MSB_SAMPLE_INSTANCE_ID,
      org: "fasterxml",
      repo: "jackson-databind",
      number: "4487",
      baseSha: MSB_SAMPLE_BASE_SHA,
      prUrl: "https://github.com/fasterxml/jackson-databind/pull/4487",
    });
  });

  it("记录含 body 时拼入正文；riskClass/allowedConfigs 可覆盖", () => {
    const withOverrides = msbRecordToMrCase(withBody(), {
      repoPath: REPO_PATH,
      riskClass: "High",
      allowedConfigs: ["C"],
    });
    expect(withOverrides.ok).toBe(true);
    if (withOverrides.ok) {
      expect(withOverrides.value.issueDescription).toContain("Replaces null with empty string.");
      expect(withOverrides.value.labels.riskClass).toBe("High");
      expect(withOverrides.value.labels.allowedConfigs).toEqual(["C"]);
    }
  });

  it("repoPath 空 → INVALID_OPTIONS；非法记录原样透传校验错误", () => {
    const badPath = msbRecordToMrCase(MSB_SAMPLE_RECORD, { repoPath: " " });
    expect(badPath.ok).toBe(false);
    if (!badPath.ok) {
      expect(badPath.error.code).toBe("INVALID_OPTIONS");
    }
    const badRecord = msbRecordToMrCase({ instance_id: "x" }, { repoPath: REPO_PATH });
    expect(badRecord.ok).toBe(false);
    if (!badRecord.ok) {
      expect(badRecord.error.code).toBe("INVALID_RECORD");
    }
  });
});

describe("buildMsbIssueDescription 与批量转换", () => {
  it("多关联 issue 依序拼接", () => {
    const description = buildMsbIssueDescription({
      instanceId: MSB_SAMPLE_INSTANCE_ID,
      org: "fasterxml",
      repo: "jackson-databind",
      number: 100,
      title: "T",
      body: "B",
      baseSha: MSB_SAMPLE_BASE_SHA,
      fixPatch: MSB_SAMPLE_FIX_PATCH,
      resolvedIssues: [
        { number: 1, title: "first", body: "b1" },
        { number: 2, title: "second", body: "" },
      ],
    });
    expect(description).toBe("PR #100: T\n\nB\n\nLinked issue #1: first\n\nb1\n\nLinked issue #2: second");
  });

  it("msbRecordsToMrCases 逐条转换，失败项显式收集", () => {
    const { cases, failures } = msbRecordsToMrCases(
      [MSB_SAMPLE_RECORD, withBody(), { instance_id: "broken" }],
      () => REPO_PATH,
    );
    expect(cases).toHaveLength(2);
    expect(cases.map((c) => c.caseId)).toEqual([MSB_SAMPLE_INSTANCE_ID, MSB_SAMPLE_INSTANCE_ID]);
    expect(failures).toEqual([
      { instanceId: "broken", code: "INVALID_RECORD", message: expect.stringContaining("org") },
    ]);
  });
});
