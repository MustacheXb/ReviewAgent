import { describe, expect, it } from "vitest";

import type { MRTruth } from "../../../src/contracts/mr-case.js";
import { DEFAULT_MERGE_CONFIG } from "../../../src/sharding/merge-findings.js";
import {
  evaluateNoDuplicate,
  evaluateNoLoss,
  evaluateNoWrongMerge,
} from "../../../src/experiment/sharding/criteria.js";
import { finding } from "./fixtures.js";
import {
  PARSER_PATH as PARSER,
  REPORT_PATH as REPORT,
  SERVICE_PATH as SERVICE,
} from "../synthetic/fixtures.js";

/**
 * #57 三判据纯函数（spec #48 实现决策 15）：不丢（切分合并后基线检出的
 * 缺陷仍在）、不重（同锚点键近行重复未被合并吸收）、不误并（合并把映射
 * 到相异真值的 findings 并成一条）。
 *
 * 锁线：不丢两级匹配（strict 性质等价优先 / loose 同文件行距内兜底）与
 * 择优规则（行距最小、平局首见）及 strict/loose 汇总分列、不重锚点键与
 * 合并层同源、不误并经公开 mergeShardFindings 同配置重放 + 判定链
 * screenFindings 逐成员单筛。
 */

function truthAt(file: string, line: number, nature = "NULL_SAFETY"): MRTruth {
  return { locations: [{ file, lineStart: line, lineEnd: line, defectNature: nature }], fixPatch: "fix" };
}

describe("evaluateNoLoss（判据一：不丢）", () => {
  it("两级匹配去向：strict（同文件 + 性质等价 + 行距内）/ loose（同文件 + 行距内，性质漂移）/ 丢失（无同文件候选）", () => {
    const report = evaluateNoLoss({
      baseline: [
        {
          caseId: "VUL4J-1",
          rep: 1,
          findings: [
            finding("B1", { file: PARSER, line: 5 }),
            finding("B2", { file: SERVICE, line: 5 }),
            finding("B3", { file: REPORT, line: 5 }),
          ],
        },
      ],
      findings: [
        // 路径归一（b/ 前缀剥离）+ 性质大小写不敏感 → strict
        finding("F001", { file: `b/${PARSER}`, line: 5, category: "null_safety" }),
        // 同文件、行距 1 内、但性质不同（NULL_SAFETY vs InputValidation）→ loose
        finding("F002", { file: SERVICE, line: 6, category: "InputValidation" }),
        // REPORT 无任何候选
      ],
      matchWindow: 3,
      screening: { lineTolerance: 0, natureAliases: {} },
    });

    expect(report.traces).toEqual([
      { caseId: "VUL4J-1", rep: 1, findingId: "B1", matchedFindingId: "F001", matchKind: "strict", lineDelta: 0 },
      { caseId: "VUL4J-1", rep: 1, findingId: "B2", matchedFindingId: "F002", matchKind: "loose", lineDelta: 1 },
      { caseId: "VUL4J-1", rep: 1, findingId: "B3", matchedFindingId: null, matchKind: null, lineDelta: null },
    ]);
    expect(report.perCase).toEqual([
      {
        caseId: "VUL4J-1",
        repCount: 1,
        baselineFindings: 3,
        strictMatched: 1,
        looseMatched: 1,
        lost: 1,
      },
    ]);
    expect(report.totalBaseline).toBe(3);
    expect(report.totalStrict).toBe(1);
    expect(report.totalLoose).toBe(1);
    expect(report.totalMatched).toBe(2);
    expect(report.totalLost).toBe(1);
  });

  it("行距边界：Δ = matchWindow 命中；Δ = matchWindow + 1 丢失", () => {
    const at = (resultLine: number) =>
      evaluateNoLoss({
        baseline: [{ caseId: "c1", rep: 1, findings: [finding("B1", { file: PARSER, line: 5 })] }],
        findings: [finding("F001", { file: PARSER, line: resultLine })],
        matchWindow: 3,
        screening: { lineTolerance: 0, natureAliases: {} },
      });

    const boundary = at(8);
    expect(boundary.traces[0]?.matchedFindingId).toBe("F001");
    expect(boundary.traces[0]?.lineDelta).toBe(3);

    const beyond = at(9);
    expect(beyond.traces[0]?.matchedFindingId).toBeNull();
    expect(beyond.totalLost).toBe(1);
  });

  it("择优规则：strict 候选非空不落 loose；strict 集内行距最小者胜", () => {
    const report = evaluateNoLoss({
      baseline: [{ caseId: "c1", rep: 1, findings: [finding("B1", { file: PARSER, line: 5 })] }],
      findings: [
        // loose 候选行距最近（Δ1），但性质不同
        finding("F001", { file: PARSER, line: 6, category: "FormatCheck" }),
        finding("F002", { file: PARSER, line: 7 }),
        finding("F003", { file: PARSER, line: 4 }),
      ],
      matchWindow: 3,
      screening: { lineTolerance: 0, natureAliases: {} },
    });

    expect(report.traces[0]).toEqual({
      caseId: "c1",
      rep: 1,
      findingId: "B1",
      matchedFindingId: "F003",
      matchKind: "strict",
      lineDelta: 1,
    });
  });

  it("逐案例 × rep 分列与合计（σ 带判定的轨迹面：每条 trace 带 caseId + rep）", () => {
    const report = evaluateNoLoss({
      baseline: [
        { caseId: "c1", rep: 1, findings: [finding("B1", { file: PARSER, line: 5 }), finding("B2", { file: SERVICE, line: 5 })] },
        { caseId: "c1", rep: 2, findings: [finding("B1", { file: PARSER, line: 5 }), finding("B3", { file: REPORT, line: 5 })] },
        { caseId: "c2", rep: 1, findings: [finding("B2", { file: SERVICE, line: 5 })] },
      ],
      findings: [finding("F001", { file: PARSER, line: 5 }), finding("F002", { file: SERVICE, line: 5 })],
      matchWindow: 3,
      screening: { lineTolerance: 0, natureAliases: {} },
    });

    expect(report.traces.map((t) => [t.caseId, t.rep, t.findingId, t.matchKind])).toEqual([
      ["c1", 1, "B1", "strict"],
      ["c1", 1, "B2", "strict"],
      ["c1", 2, "B1", "strict"],
      ["c1", 2, "B3", null],
      ["c2", 1, "B2", "strict"],
    ]);
    expect(report.perCase).toEqual([
      { caseId: "c1", repCount: 2, baselineFindings: 4, strictMatched: 3, looseMatched: 0, lost: 1 },
      { caseId: "c2", repCount: 1, baselineFindings: 1, strictMatched: 1, looseMatched: 0, lost: 0 },
    ]);
    expect(report.totalBaseline).toBe(5);
    expect(report.totalStrict).toBe(4);
    expect(report.totalLoose).toBe(0);
    expect(report.totalMatched).toBe(4);
    expect(report.totalLost).toBe(1);
  });
});

describe("evaluateNoDuplicate（判据二：不重）", () => {
  it("同锚点键（file + rule + category）且行距 ≤ 窗口 → 重复对（含 Δ0）", () => {
    const report = evaluateNoDuplicate(
      [
        finding("F001", { file: PARSER, line: 5 }),
        finding("F002", { file: PARSER, line: 7 }),
        finding("F003", { file: REPORT, line: 9, rule: "logging" }),
        finding("F004", { file: REPORT, line: 9, rule: "logging" }),
      ],
      3,
    );

    expect(report.findingCount).toBe(4);
    expect(report.pairs).toEqual([
      { findingIdA: "F001", findingIdB: "F002", lineDelta: 2 },
      { findingIdA: "F003", findingIdB: "F004", lineDelta: 0 },
    ]);
  });

  it("异键（rule / file 不同）或行距超窗 → 不算重复", () => {
    const report = evaluateNoDuplicate(
      [
        // 同键但行距 4 > 窗口 3
        finding("F001", { file: PARSER, line: 5 }),
        finding("F002", { file: PARSER, line: 9 }),
        // 同文件同行但 rule 不同 → 异键
        finding("F003", { file: PARSER, line: 5, rule: "format" }),
        // 同 rule 同 category 但文件不同 → 异键
        finding("F004", { file: SERVICE, line: 5 }),
      ],
      3,
    );

    expect(report.pairs).toEqual([]);
    expect(report.findingCount).toBe(4);
  });

  it("组内两两判定：三成员近远混合只出近距对（远者不与近组配对）", () => {
    const report = evaluateNoDuplicate(
      [
        finding("F001", { file: PARSER, line: 5 }),
        finding("F002", { file: PARSER, line: 6 }),
        finding("F003", { file: PARSER, line: 20 }),
      ],
      3,
    );

    expect(report.pairs).toEqual([{ findingIdA: "F001", findingIdB: "F002", lineDelta: 1 }]);
  });
});

describe("evaluateNoWrongMerge（判据三：不误并）", () => {
  it("误并检出：合并组成员各自单筛命中相异真值下标 → 记误并条目", () => {
    const result = evaluateNoWrongMerge({
      shards: [
        {
          shardId: "s1",
          findings: [finding("F001", { file: PARSER, line: 5 }), finding("F002", { file: PARSER, line: 6 })],
        },
      ],
      merge: DEFAULT_MERGE_CONFIG,
      truth: {
        locations: [
          { file: PARSER, lineStart: 5, lineEnd: 5, defectNature: "NULL_SAFETY" },
          { file: PARSER, lineStart: 6, lineEnd: 6, defectNature: "NULL_SAFETY" },
        ],
        fixPatch: "fix",
      },
      screening: { lineTolerance: 0, natureAliases: {} },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.mergedEntryCount).toBe(1);
    expect(result.value.entries).toEqual([
      {
        anchorFindingId: "F001",
        members: [
          { findingId: "F001", shardId: "s1", matchedTruthIndex: 0 },
          { findingId: "F002", shardId: "s1", matchedTruthIndex: 1 },
        ],
        distinctTruthIndices: [0, 1],
      },
    ]);
  });

  it("TP/FP 混合不判（严格口径）：成员只有一个命中真值 → 不记误并，但计入合并条目数", () => {
    const result = evaluateNoWrongMerge({
      shards: [
        {
          shardId: "s1",
          findings: [finding("F001", { file: PARSER, line: 5 }), finding("F002", { file: PARSER, line: 6 })],
        },
      ],
      merge: DEFAULT_MERGE_CONFIG,
      // 真值只有第 5 行一处：F002 单筛为 FP（matchedTruthIndex = null）
      truth: truthAt(PARSER, 5),
      screening: { lineTolerance: 0, natureAliases: {} },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.mergedEntryCount).toBe(1);
    expect(result.value.entries).toEqual([]);
  });

  it("跨片并入成组、单成员键不成组（合并条目数只数 ≥2 成员组）", () => {
    const result = evaluateNoWrongMerge({
      shards: [
        {
          shardId: "s1",
          findings: [finding("F001", { file: PARSER, line: 5 }), finding("F003", { file: SERVICE, line: 5, rule: "logging", category: "FormatCheck" })],
        },
        { shardId: "s2", findings: [finding("F002", { file: PARSER, line: 6 })] },
      ],
      merge: DEFAULT_MERGE_CONFIG,
      truth: truthAt(PARSER, 5),
      screening: { lineTolerance: 0, natureAliases: {} },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // F001（s1）+ F002（s2）同键近行跨片并入成组；F003 单成员键不成组
    expect(result.value.mergedEntryCount).toBe(1);
    expect(result.value.entries).toEqual([]);
  });

  it("合并层拒绝原样透传（MERGE_CONFIG_INVALID）", () => {
    const result = evaluateNoWrongMerge({
      shards: [{ shardId: "s1", findings: [finding("F001")] }],
      merge: { lineWindow: 0 },
      truth: truthAt(PARSER, 5),
      screening: { lineTolerance: 0, natureAliases: {} },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("MERGE_CONFIG_INVALID");
  });
});
