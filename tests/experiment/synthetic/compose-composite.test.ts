import { describe, expect, it } from "vitest";
import type { SourceSnapshot } from "../../../src/dataset/diff/apply-unified-diff.js";
import { applyUnifiedDiff } from "../../../src/dataset/diff/apply-unified-diff.js";
import { parseUnifiedDiff } from "../../../src/dataset/diff/parse-unified-diff.js";
import { composeComposite } from "../../../src/experiment/synthetic/compose-composite.js";
import {
  FIX_PATCH_PARSER,
  FIX_PATCH_REPORT,
  FIX_PATCH_SERVICE,
  PARSER_PATH,
  PARSER_FIXED,
  REPORT_DRIFTED,
  REPORT_FIXED,
  REPORT_PATH,
  SERVICE_FIXED,
  SERVICE_PATH,
  makeCandidate,
  mrDiffOf,
  snapshotV2,
  standardCandidates,
} from "./fixtures.js";

const CASE_FILES = [PARSER_PATH, SERVICE_PATH, REPORT_PATH];
const STANDARD_FILL = { targetFiles: 6, targetDiffLines: 24 };

function compose(
  candidates = standardCandidates(),
  fill: { targetFiles: number; targetDiffLines: number } = STANDARD_FILL,
  compositeId = "COMP-1",
) {
  return composeComposite({ compositeId, candidates, fill });
}

describe("composeComposite（锚定规则与入选决策）", () => {
  it("锚 = fix commit 最新者：base / repoPath / extensions 均取锚案例", () => {
    const result = compose();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const { mrCase, manifest } = result.value;
    expect(manifest.anchorCaseId).toBe("VUL4J-2");
    expect(manifest.anchorFixCommitAt).toBe("2024-06-15T00:00:00Z");
    // 原始输入序（重放时候选尝试序的依据）与入选结果序并存
    expect(manifest.inputCaseIds).toEqual(["VUL4J-1", "VUL4J-2", "VUL4J-3", "VUL4J-4"]);
    expect(mrCase.caseId).toBe("COMP-1");
    expect(mrCase.repoPath).toBe("D:/repos/example");
    expect(mrCase.extensions).toMatchObject({
      composite: "true",
      anchorCaseId: "VUL4J-2",
      includedCaseIds: "VUL4J-2,VUL4J-1,VUL4J-4",
      droppedCaseIds: "VUL4J-3",
    });
  });

  it("同刻 fix commit：caseId 大者锚定（确定性 tie-break）", () => {
    const candidates = standardCandidates().map((candidate) => ({
      ...candidate,
      fixCommitAt: "2024-06-15T00:00:00Z",
    }));
    const result = compose(candidates);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // VUL4J-4 字典序最大 → 锚；其逆补丁套用于 V2 快照（Report 修复态）成立
    expect(result.value.manifest.anchorCaseId).toBe("VUL4J-4");
  });

  it("同文件案例被拒（file-overlap）且留构造痕；其余照常入选", () => {
    const result = compose();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const { manifest } = result.value;
    expect(manifest.includedCaseIds).toEqual(["VUL4J-2", "VUL4J-1", "VUL4J-4"]);
    expect(manifest.droppedCases).toHaveLength(1);
    expect(manifest.droppedCases[0]).toMatchObject({
      caseId: "VUL4J-3",
      reason: "file-overlap",
    });
    expect(manifest.droppedCases[0]!.detail).toContain(SERVICE_PATH);
  });

  it("套用冲突案例被弃（apply-conflict）且 detail 含冲突信息", () => {
    const result = compose(standardCandidates(REPORT_DRIFTED));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const { manifest } = result.value;
    expect(manifest.includedCaseIds).toEqual(["VUL4J-2", "VUL4J-1"]);
    expect(manifest.droppedCases).toHaveLength(2);
    const conflict = manifest.droppedCases.find((drop) => drop.reason === "apply-conflict");
    expect(conflict).toBeDefined();
    expect(conflict!.caseId).toBe("VUL4J-4");
    expect(conflict!.detail.length).toBeGreaterThan(0);
  });
});

describe("composeComposite（真值并集与合成 MR）", () => {
  it("真值 = 入选案例真值并集，行号逐案例不漂移", () => {
    const result = compose();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const truth = result.value.mrCase.truth!;
    expect(truth.locations).toEqual([
      { file: SERVICE_PATH, lineStart: 5, lineEnd: 5, defectNature: "NullCheck" },
      { file: PARSER_PATH, lineStart: 5, lineEnd: 5, defectNature: "NullCheck" },
      { file: REPORT_PATH, lineStart: 5, lineEnd: 5, defectNature: "ReturnValue" },
    ]);
    expect(truth.fixPatch).toBe(FIX_PATCH_SERVICE + FIX_PATCH_PARSER + FIX_PATCH_REPORT);
  });

  it("issueDescription = 入选案例描述拼接；复合 diff = 锚 diff + 其余案例 diff + 填充 diff", () => {
    const result = compose();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const { mrCase } = result.value;
    expect(mrCase.issueDescription).toBe("issue of VUL4J-2\n\nissue of VUL4J-1\n\nissue of VUL4J-4");
    // 拼接序：锚案例 diff 在最前，其后按输入序
    expect(mrCase.diff.startsWith(mrDiffOf(FIX_PATCH_SERVICE))).toBe(true);
    expect(mrCase.diff).toContain(mrDiffOf(FIX_PATCH_PARSER));
    expect(mrCase.diff).toContain(mrDiffOf(FIX_PATCH_REPORT));
  });

  it("复合 diff 是可解析的整体（多文件单文档）", () => {
    const result = compose();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const parsed = parseUnifiedDiff(result.value.mrCase.diff);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value).toHaveLength(result.value.manifest.composite.files);
  });
});

describe("composeComposite（良性填充与 manifest）", () => {
  it("填充与全部候选案例文件（含弃用案例）文件级不相交；双维目标达标", () => {
    const result = compose();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const { manifest } = result.value;
    for (const edit of manifest.fill.edits) {
      expect(CASE_FILES).not.toContain(edit.file);
    }
    expect(manifest.composite.files).toBeGreaterThanOrEqual(STANDARD_FILL.targetFiles);
    expect(manifest.composite.diffLines).toBeGreaterThanOrEqual(STANDARD_FILL.targetDiffLines);
    expect(manifest.fill.seed).toBe("COMP-1");
    expect(manifest.fill.filesTouched.length).toBeGreaterThanOrEqual(1);
  });

  it("manifest 记录全部构造参数：同输入重放可得相同合成 MR（确定性）", () => {
    const first = compose();
    const second = compose();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(JSON.stringify(first.value.manifest)).toBe(JSON.stringify(second.value.manifest));
    expect(JSON.stringify(first.value.mrCase)).toBe(JSON.stringify(second.value.mrCase));
  });

  it("round-trip：复合 diff 套用 base 得 buggy，fixPatch 并集套用还原案例文件", () => {
    const base = snapshotV2();
    const result = compose();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const buggy = applyUnifiedDiff(base, result.value.mrCase.diff);
    expect(buggy.ok).toBe(true);
    if (!buggy.ok) {
      return;
    }
    const buggyAll: SourceSnapshot = { ...base, ...buggy.value.sources };
    const restored = applyUnifiedDiff(buggyAll, result.value.mrCase.truth!.fixPatch);
    expect(restored.ok).toBe(true);
    if (!restored.ok) {
      return;
    }
    const restoredAll: SourceSnapshot = { ...buggyAll, ...restored.value.sources };
    // 案例文件经「逆补丁 → 修复补丁」往返后与 base 逐字节一致
    expect(restoredAll[PARSER_PATH]).toBe(PARSER_FIXED);
    expect(restoredAll[SERVICE_PATH]).toBe(SERVICE_FIXED);
    expect(restoredAll[REPORT_PATH]).toBe(REPORT_FIXED);
  });
});

describe("composeComposite（labels 合并）", () => {
  it("riskClass 取最强；allowedConfigs 交集（按锚案例顺序）", () => {
    const candidates = standardCandidates().map((candidate) => ({
      ...candidate,
      mrCase: {
        ...candidate.mrCase,
        labels: {
          ...candidate.mrCase.labels,
          riskClass: candidate.mrCase.caseId === "VUL4J-1" ? ("Low" as const) : ("High" as const),
          allowedConfigs:
            candidate.mrCase.caseId === "VUL4J-2"
              ? (["C", "B", "D"] as const)
              : (["B", "C", "E"] as const),
        },
      },
    }));
    const result = compose(candidates);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.mrCase.labels.riskClass).toBe("High");
    expect(result.value.mrCase.labels.allowedConfigs).toEqual(["C", "B"]);
  });

  it("source 不一致：fail fast", () => {
    const candidates = standardCandidates().map((candidate) =>
      candidate.mrCase.caseId === "VUL4J-1"
        ? { ...candidate, mrCase: { ...candidate.mrCase, labels: { ...candidate.mrCase.labels, source: "msb-java" } } }
        : candidate,
    );
    const result = compose(candidates);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("COMPOSITE_INPUT_INVALID");
    expect(result.error.message).toContain("source");
  });

  it("allowedConfigs 交集为空：fail fast", () => {
    const candidates = standardCandidates().map((candidate) =>
      candidate.mrCase.caseId === "VUL4J-2"
        ? { ...candidate, mrCase: { ...candidate.mrCase, labels: { ...candidate.mrCase.labels, allowedConfigs: ["D", "E"] as const } } }
        : { ...candidate, mrCase: { ...candidate.mrCase, labels: { ...candidate.mrCase.labels, allowedConfigs: ["A", "B", "C"] as const } } },
    );
    const result = compose(candidates);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("COMPOSITE_INPUT_INVALID");
    expect(result.error.message).toContain("allowedConfigs");
  });
});

describe("composeComposite（失败路径与输入校验）", () => {
  it("锚案例逆补丁无法干净套用自身快照：COMPOSITE_ANCHOR_APPLY_FAILED", () => {
    const buggyServiceSnapshot: SourceSnapshot = { ...snapshotV2(), [SERVICE_PATH]: SERVICE_FIXED.replace("        if (value == null) {\n            return 0;\n        }\n", "") };
    const anchor = makeCandidate(
      "VUL4J-9",
      "2025-01-01T00:00:00Z",
      FIX_PATCH_SERVICE,
      { locations: [{ file: SERVICE_PATH, lineStart: 5, lineEnd: 5, defectNature: "NullCheck" }], fixPatch: FIX_PATCH_SERVICE },
      buggyServiceSnapshot,
    );
    const [early] = standardCandidates();
    const result = compose([anchor, early!]);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("COMPOSITE_ANCHOR_APPLY_FAILED");
    expect(result.error.message).toContain("VUL4J-9");
  });

  it("填充候选耗尽：上抛 COMPOSITE_FILL_EXHAUSTED（不静默短缺）", () => {
    const result = compose(standardCandidates(), { targetFiles: 99, targetDiffLines: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("COMPOSITE_FILL_EXHAUSTED");
  });

  it.each([
    { name: "候选不足 2 个", mutate: (cs: ReturnType<typeof standardCandidates>) => cs.slice(0, 1) },
    { name: "caseId 重复", mutate: (cs: ReturnType<typeof standardCandidates>) => [cs[0]!, { ...cs[1]!, mrCase: { ...cs[0]!.mrCase } }] },
    { name: "fixCommitAt 不可解析", mutate: (cs: ReturnType<typeof standardCandidates>) => [{ ...cs[0]!, fixCommitAt: "not-a-date" }, cs[1]!] },
    { name: "truth 缺失", mutate: (cs: ReturnType<typeof standardCandidates>) => [{ ...cs[0]!, mrCase: { ...cs[0]!.mrCase, truth: null } }, cs[1]!] },
    { name: "fill 目标为负", mutate: (cs: ReturnType<typeof standardCandidates>) => cs },
  ])("输入校验（$name）：COMPOSITE_INPUT_INVALID", ({ mutate }) => {
    const candidates = mutate(standardCandidates());
    const fill = { targetFiles: -1, targetDiffLines: 0 };
    const result = composeComposite({ compositeId: "COMP-BAD", candidates, fill });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("COMPOSITE_INPUT_INVALID");
  });

  it("候选案例跨仓（repoPath 不一致）：fail fast", () => {
    const candidates = standardCandidates().map((candidate) =>
      candidate.mrCase.caseId === "VUL4J-1"
        ? { ...candidate, mrCase: { ...candidate.mrCase, repoPath: "D:/repos/other" } }
        : candidate,
    );
    const result = compose(candidates);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("COMPOSITE_INPUT_INVALID");
    expect(result.error.message).toContain("repoPath");
  });

  it("fixCommitAt 非 ISO 8601 形态（06/15/2024 可被 Date.parse 解析）：fail fast", () => {
    const candidates = standardCandidates().map((candidate) =>
      candidate.mrCase.caseId === "VUL4J-1" ? { ...candidate, fixCommitAt: "06/15/2024" } : candidate,
    );
    const result = compose(candidates);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("COMPOSITE_INPUT_INVALID");
    expect(result.error.message).toContain("fixCommitAt");
  });

  it("compositeId 为空：fail fast", () => {
    const result = composeComposite({
      compositeId: "",
      candidates: standardCandidates(),
      fill: { targetFiles: 6, targetDiffLines: 24 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("COMPOSITE_INPUT_INVALID");
  });
});
