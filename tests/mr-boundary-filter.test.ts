import { describe, expect, it } from "vitest";
import type { MRCase } from "../src/contracts/mr-case.js";
import {
  DEFAULT_MR_BOUNDARY,
  filterMrCase,
  filterMrCases,
  measureDiffBoundary,
} from "../src/dataset/mr-boundary-filter.js";
import { DEFECT_RECORD } from "./fixtures/defect-pair.js";
import { convertDefectRecord } from "../src/dataset/inverse-patch.js";

const OPTS = { repoPath: "D:/repos/x" };

function fileBlock(path: string, changedLineCount: number): string {
  const adds = Array.from({ length: changedLineCount }, (_, i) => `+line ${i + 1}`);
  return [
    `--- ${path}`,
    `+++ ${path}`,
    `@@ -1,2 +1,${2 + changedLineCount} @@`,
    " base",
    ...adds,
    " tail",
  ].join("\n") + "\n";
}

function makeCase(caseId: string, diff: string, source = "defects4j"): MRCase {
  return {
    caseId,
    repoPath: "D:/repos/x",
    diff,
    issueDescription: "irrelevant for filtering",
    truth: { locations: [], fixPatch: "" },
    labels: { source, riskClass: "Medium", allowedConfigs: ["A", "B", "C", "D", "E"] },
  };
}

describe("measureDiffBoundary（口径）", () => {
  it("变更行数 = 新增 + 删除，不含 context 与头部", () => {
    const converted = convertDefectRecord(DEFECT_RECORD, OPTS);
    expect(converted.ok).toBe(true);
    if (!converted.ok) {
      return;
    }
    const metrics = measureDiffBoundary(converted.value.diff);
    expect(metrics.ok).toBe(true);
    if (!metrics.ok) {
      return;
    }
    // fixture 逆 diff（MR diff）：原补丁新增 4 行/删除 1 行 → 逆 diff 新增 1 行/删除 4 行（互换）
    expect(metrics.value).toEqual({
      files: 2,
      addedLines: 1,
      removedLines: 4,
      changedLines: 5,
      totalDiffLines: expect.any(Number),
    });
    // 逆 diff 与原补丁的边界口径数值恒等
    const fixMetrics = measureDiffBoundary(DEFECT_RECORD.fixPatch);
    expect(fixMetrics.ok).toBe(true);
    if (fixMetrics.ok) {
      expect(fixMetrics.value.changedLines).toBe(metrics.value.changedLines);
      expect(fixMetrics.value.files).toBe(metrics.value.files);
    }
  });

  it("非法 diff 返回错误", () => {
    expect(measureDiffBoundary("garbage").ok).toBe(false);
  });
});

describe("filterMrCase（MR 边界过滤）", () => {
  it("10 个文件且 ≤2000 变更行：通过", () => {
    const diff = Array.from({ length: 10 }, (_, i) => fileBlock(`src/F${i}.java`, 1)).join("");
    expect(filterMrCase(makeCase("ok-10-files", diff)).accepted).toBe(true);
  });

  it("11 个文件：拒绝（too-many-files）", () => {
    const diff = Array.from({ length: 11 }, (_, i) => fileBlock(`src/F${i}.java`, 1)).join("");
    const outcome = filterMrCase(makeCase("too-many-files", diff));
    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toBe("too-many-files");
    expect(outcome.metrics?.files).toBe(11);
  });

  it("恰好 2000 变更行：通过（边界含端点）", () => {
    const diff = fileBlock("src/Big.java", 2000);
    const outcome = filterMrCase(makeCase("ok-2000", diff));
    expect(outcome.accepted).toBe(true);
    expect(outcome.metrics?.changedLines).toBe(2000);
  });

  it("2001 变更行：拒绝（diff-too-large）", () => {
    const diff = fileBlock("src/Big.java", 2001);
    const outcome = filterMrCase(makeCase("too-large", diff));
    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toBe("diff-too-large");
    expect(outcome.metrics?.changedLines).toBe(2001);
  });

  it("context 行不计入变更行数（大量 context 不触发过滤）", () => {
    const context = Array.from({ length: 2500 }, (_, i) => ` unchanged ${i}`);
    const diff = [
      "--- src/Wide.java",
      "+++ src/Wide.java",
      "@@ -1,2501 +1,2501 @@",
      ...context.map((l) => ` ${l}`),
      "-old",
      "+new",
    ].join("\n") + "\n";
    const outcome = filterMrCase(makeCase("wide-context", diff));
    expect(outcome.accepted).toBe(true);
    expect(outcome.metrics?.changedLines).toBe(2);
    expect(outcome.metrics?.totalDiffLines).toBeGreaterThan(2000);
  });

  it("自定义边界参数生效", () => {
    const diff = fileBlock("src/F.java", 5);
    const outcome = filterMrCase(makeCase("custom", diff), { maxFiles: 10, maxDiffLines: 4 });
    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toBe("diff-too-large");
  });

  it("非法 diff：拒绝（malformed-diff）", () => {
    const outcome = filterMrCase(makeCase("bad-diff", "not a diff at all"));
    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toBe("malformed-diff");
  });
});

describe("filterMrCases（批量过滤与留痕报告）", () => {
  it("验收 3：超边界的记录被过滤并全量留痕", () => {
    const cases = [
      makeCase("case-ok", fileBlock("src/A.java", 3)),
      makeCase("case-files", Array.from({ length: 12 }, (_, i) => fileBlock(`src/B${i}.java`, 1)).join("")),
      makeCase("case-lines", fileBlock("src/C.java", 2500)),
      makeCase("case-bad", "garbage"),
    ];
    const { accepted, report } = filterMrCases(cases);
    expect(accepted.map((c) => c.caseId)).toEqual(["case-ok"]);
    expect(report.total).toBe(4);
    expect(report.acceptedCount).toBe(1);
    expect(report.rejectedCount).toBe(3);
    expect(report.rejectedByReason).toEqual({
      "too-many-files": 1,
      "diff-too-large": 1,
      "malformed-diff": 1,
    });
    expect(report.rejected.map((r) => ({ caseId: r.caseId, reason: r.reason }))).toEqual([
      { caseId: "case-files", reason: "too-many-files" },
      { caseId: "case-lines", reason: "diff-too-large" },
      { caseId: "case-bad", reason: "malformed-diff" },
    ]);
    expect(report.rejected[0]?.metrics?.files).toBe(12);
    expect(report.rejected[1]?.metrics?.changedLines).toBe(2500);
    expect(report.rejected[2]?.metrics).toBeNull();
    expect(report.rejected.every((r) => r.message.length > 0)).toBe(true);
  });

  it("报告携带边界参数（默认 ≤10 文件 / ≤2000 行）", () => {
    const { report } = filterMrCases([]);
    expect(report.boundary).toEqual(DEFAULT_MR_BOUNDARY);
    expect(report.total).toBe(0);
  });

  it("不修改输入数组（纯函数）", () => {
    const cases = [makeCase("case-ok", fileBlock("src/A.java", 3))];
    const before = JSON.stringify(cases);
    filterMrCases(cases);
    expect(JSON.stringify(cases)).toBe(before);
  });
});
