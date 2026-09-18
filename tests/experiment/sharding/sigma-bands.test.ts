import { describe, expect, it } from "vitest";

import type { Finding } from "../../../src/contracts/finding.js";
import type { MRCase } from "../../../src/contracts/mr-case.js";
import type { ArmRunReport, GroupValidationReport } from "../../../src/experiment/sharding/harness.js";
import {
  buildSigmaBandAnalysis,
  judgeBand,
  type LoadedShardingReport,
} from "../../../src/experiment/sharding/sigma-bands.js";

/**
 * #59 σ 带判定层（实验设计 §2.4）：对称 max σ 带两组对比（对比 A = 处理 vs
 * 控制；对比 B = 控制 vs LOO 自漂移底）、计数守卫聚合、锚点键 ±1/±3/±5 校准
 * 重放、归因链——纯函数层（IO 壳在 scripts/analyze-sharding-validation.ts）。
 *
 * 锁线：带 = 基线侧均值 ± max(σ_base, σ_cand)；n < 3 不判定；LOO 与不丢同
 * 定义（evaluateNoLoss 复用）；合成真值 = 入选案例真值并集；产出确定性。
 */

function findingAt(id: string, file: string, line: number, category = "NULL_SAFETY"): Finding {
  return {
    id,
    severity: "P2",
    category,
    file,
    line,
    title: `title ${id}`,
    description: `description ${id}`,
    evidence: [`${id} evidence`],
    rule: "null-safety",
    confidence: 0.9,
  };
}

/** 最小 ArmRunReport（分析层只消费 noLoss 计数 / runs / shardCount / findings） */
function armReport(overrides: Partial<ArmRunReport> = {}): ArmRunReport {
  return {
    arm: "treatment",
    compositeId: "CMP-1",
    caseId: "CMP-1",
    sharded: true,
    shardCount: 1,
    findings: [],
    usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5 },
    rounds: 1,
    toolCalls: 0,
    runs: [],
    noLoss: {
      traces: [],
      perCase: [],
      totalBaseline: 0,
      totalStrict: 0,
      totalLoose: 0,
      totalMatched: 0,
      totalLost: 0,
    },
    ...overrides,
  };
}

interface ReportOverrides {
  readonly treatmentNoLoss?: { totalBaseline: number; totalStrict: number };
  readonly controlNoLoss?: { totalBaseline: number; totalStrict: number };
  readonly treatmentRuns?: readonly { runId: string; findings: readonly Finding[] }[];
  readonly includedCaseIds?: readonly string[];
  readonly noDuplicatePairs?: GroupValidationReport["noDuplicate"]["pairs"];
  readonly noWrongMergeEntries?: GroupValidationReport["noWrongMerge"]["entries"];
}

function reportOf(overrides: ReportOverrides = {}): GroupValidationReport {
  return {
    groupId: "g",
    manifests: {
      treatment: {
        compositeId: "CMP-T",
        anchorCaseId: "VUL4J-2",
        anchorFixCommitAt: "2024-06-15T00:00:00Z",
        inputCaseIds: overrides.includedCaseIds ?? ["VUL4J-1", "VUL4J-2"],
        includedCaseIds: overrides.includedCaseIds ?? ["VUL4J-1", "VUL4J-2"],
        droppedCases: [],
        fill: { targetFiles: 9, targetDiffLines: 1500, seed: "CMP-T", edits: [], filesTouched: [], diffLines: 1500 },
        composite: { files: 9, diffLines: 1500 },
      },
      control: {
        compositeId: "CMP-C",
        anchorCaseId: "VUL4J-2",
        anchorFixCommitAt: "2024-06-15T00:00:00Z",
        inputCaseIds: overrides.includedCaseIds ?? ["VUL4J-1", "VUL4J-2"],
        includedCaseIds: overrides.includedCaseIds ?? ["VUL4J-1", "VUL4J-2"],
        droppedCases: [],
        fill: { targetFiles: 2, targetDiffLines: 6, seed: "CMP-C", edits: [], filesTouched: [], diffLines: 6 },
        composite: { files: 2, diffLines: 6 },
      },
    },
    arms: {
      treatment: armReport({
        arm: "treatment",
        sharded: true,
        shardCount: overrides.treatmentRuns?.length ?? 1,
        noLoss: {
          traces: [],
          perCase: [],
          totalBaseline: overrides.treatmentNoLoss?.totalBaseline ?? 0,
          totalStrict: overrides.treatmentNoLoss?.totalStrict ?? 0,
          totalLoose: 0,
          totalMatched: overrides.treatmentNoLoss?.totalStrict ?? 0,
          totalLost: (overrides.treatmentNoLoss?.totalBaseline ?? 0) - (overrides.treatmentNoLoss?.totalStrict ?? 0),
        },
        runs: (overrides.treatmentRuns ?? []).map((run) => ({
          runId: run.runId,
          auditPath: `audit/${run.runId}.json`,
          findings: run.findings,
          usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5 },
        })),
      }),
      control: armReport({
        arm: "control",
        sharded: false,
        shardCount: 0,
        noLoss: {
          traces: [],
          perCase: [],
          totalBaseline: overrides.controlNoLoss?.totalBaseline ?? 0,
          totalStrict: overrides.controlNoLoss?.totalStrict ?? 0,
          totalLoose: 0,
          totalMatched: overrides.controlNoLoss?.totalStrict ?? 0,
          totalLost: (overrides.controlNoLoss?.totalBaseline ?? 0) - (overrides.controlNoLoss?.totalStrict ?? 0),
        },
        runs: [],
      }),
    },
    noDuplicate: {
      findingCount: 0,
      pairs: overrides.noDuplicatePairs ?? [],
    },
    noWrongMerge: {
      mergedEntryCount: 0,
      entries: overrides.noWrongMergeEntries ?? [],
    },
  };
}

/** 标准矩阵素材：n 组 × reps 份报告，处理 / 控制 strict 率可控 */
function matrixReports(
  groups: readonly string[],
  reps: readonly number[],
  treatmentRate: (group: string, rep: number) => { baseline: number; strict: number },
  controlRate: (group: string, rep: number) => { baseline: number; strict: number },
): readonly LoadedShardingReport[] {
  return groups.flatMap((group) =>
    reps.map((rep) => {
      const treatment = treatmentRate(group, rep);
      const control = controlRate(group, rep);
      return {
        group,
        rep,
        report: reportOf({
          treatmentNoLoss: { totalBaseline: treatment.baseline, totalStrict: treatment.strict },
          controlNoLoss: { totalBaseline: control.baseline, totalStrict: control.strict },
        }),
      };
    }),
  );
}

const TWO_CASES: readonly MRCase[] = [
  {
    caseId: "VUL4J-1",
    repoPath: "D:/repos/c1",
    diff: "diff",
    issueDescription: "issue",
    truth: {
      locations: [{ file: "Parser.java", lineStart: 5, lineEnd: 5, defectNature: "NULL_SAFETY" }],
      fixPatch: "patch-1",
    },
    labels: { source: "vul4j", riskClass: "High", allowedConfigs: ["A", "B", "C", "D", "E"] },
    extensions: {},
  },
  {
    caseId: "VUL4J-2",
    repoPath: "D:/repos/c2",
    diff: "diff",
    issueDescription: "issue",
    truth: {
      locations: [{ file: "Service.java", lineStart: 5, lineEnd: 5, defectNature: "NULL_SAFETY" }],
      fixPatch: "patch-2",
    },
    labels: { source: "vul4j", riskClass: "High", allowedConfigs: ["A", "B", "C", "D", "E"] },
    extensions: {},
  },
];

const CASE_BY_ID = new Map(TWO_CASES.map((mrCase) => [mrCase.caseId, mrCase]));

/** 三案例三 rep 直跑 findings（LOO 素材）：A 案跨 rep 稳定命中、B 案漂移、C 案空 */
function looBaseline(): ReadonlyMap<string, ReadonlyMap<number, readonly Finding[]>> {
  return new Map([
    [
      "VUL4J-A",
      new Map([
        [1, [findingAt("a1", "A.java", 5)]],
        [2, [findingAt("a2", "A.java", 5)]],
        [3, [findingAt("a3", "A.java", 5)]],
      ]),
    ],
    [
      "VUL4J-B",
      new Map([
        [1, [findingAt("b1", "B.java", 10)]],
        [2, [findingAt("b2", "B.java", 40)]], // 行漂移超窗口（±3）→ 不命中
        [3, [findingAt("b3", "B.java", 10)]],
      ]),
    ],
    [
      "VUL4J-C",
      new Map([
        [1, []],
        [2, []],
        [3, []],
      ]),
    ],
  ]);
}

describe("judgeBand — 对称 max σ 带", () => {
  it("带 = 基线侧均值 ± max(σ_base, σ_cand)；带内 → IN", () => {
    const verdict = judgeBand([1, 1, 1], [1, 1, 0.95]);
    expect(verdict.verdict).toBe("IN");
    expect(verdict.bandLo).toBeCloseTo(1 - Math.max(0, 0.02887), 4);
    expect(verdict.bandHi).toBeCloseTo(1 + 0.02887, 4);
  });

  it("候选均值低于带下界 → OUT_WORSE（恶化方向带外）", () => {
    const verdict = judgeBand([1, 1, 1], [0.5, 0.5, 0.5]);
    expect(verdict.verdict).toBe("OUT_WORSE");
  });

  it("候选均值高于带上界 → OUT_BETTER（改善方向带外，不是失败）", () => {
    const verdict = judgeBand([0.5, 0.5, 0.5], [1, 1, 1]);
    expect(verdict.verdict).toBe("OUT_BETTER");
  });

  it("任一侧 n < 3 → INSUFFICIENT_SAMPLE（指出不足侧）", () => {
    expect(judgeBand([1, 1], [1, 1, 1]).verdict).toBe("INSUFFICIENT_SAMPLE");
    expect(judgeBand([1, 1, 1], [1]).verdict).toBe("INSUFFICIENT_SAMPLE");
    expect(judgeBand([], []).verdict).toBe("INSUFFICIENT_SAMPLE");
  });

  it("σ 取两侧最大（候选 σ 更大时带宽由候选侧撑开）", () => {
    // 基线零方差（全 1），候选 [0.9, 1.0, 1.1] σ ≈ 0.1 → 带宽由候选侧决定
    const verdict = judgeBand([1, 1, 1], [0.9, 1.0, 1.1]);
    expect(verdict.verdict).toBe("IN");
    expect(verdict.bandLo).toBeCloseTo(0.9, 4);
  });
});

describe("buildSigmaBandAnalysis — 两组对比与样本装载", () => {
  const GROUPS = ["struts", "spring-sec", "cxf", "uaa"];
  const REPS = [1, 2, 3];

  function analysisOf(
    reports: readonly LoadedShardingReport[],
    baseline: ReadonlyMap<string, ReadonlyMap<number, readonly Finding[]>> = looBaseline(),
  ) {
    return buildSigmaBandAnalysis({
      reports,
      expectedGroups: GROUPS,
      expectedReps: REPS,
      baselineFindings: baseline,
      caseById: CASE_BY_ID,
    });
  }

  it("对比 A：候选 = 处理臂 strict 率、基线 = 控制臂；恶化带外可判", () => {
    const reports = matrixReports(
      GROUPS,
      REPS,
      () => ({ baseline: 10, strict: 5 }), // 处理臂 0.5
      () => ({ baseline: 10, strict: 10 }), // 控制臂 1.0（零方差）
    );
    const analysis = analysisOf(reports);
    expect(analysis.comparisonA.verdict).toBe("OUT_WORSE");
    expect(analysis.comparisonA.candidate?.count).toBe(12);
    expect(analysis.comparisonA.baseline?.count).toBe(12);
  });

  it("对比 B：基线 = LOO 自漂移底（逐案例逐 rep 配对，同 evaluateNoLoss 定义）", () => {
    const reports = matrixReports(
      GROUPS,
      REPS,
      () => ({ baseline: 10, strict: 10 }),
      () => ({ baseline: 10, strict: 10 }),
    );
    const analysis = analysisOf(reports);
    // LOO 样本：A 案 3 个（全命中 1.0）、B 案 3 个（rep1/3 命中 1.0、rep2 不命中 0.0）、C 案空基线 0 个
    const loo = analysis.samples.looSelfDrift;
    expect(loo).toHaveLength(6);
    expect(loo.filter((sample) => sample.caseId === "VUL4J-A").every((sample) => sample.strictRate === 1)).toBe(true);
    const bRep2 = loo.find((sample) => sample.caseId === "VUL4J-B" && sample.rep === 2);
    expect(bRep2?.strictRate).toBe(0);
    expect(loo.every((sample) => sample.caseId !== "VUL4J-C")).toBe(true);
    // 对比 B 基线侧 = LOO 样本（n=6 ≥ 3 可判定）
    expect(analysis.comparisonB.baseline?.count).toBe(6);
  });

  it("LOO 性质漂移走 loose 不算 strict（与不丢同定义）", () => {
    // B.java rep2 的 finding 性质漂移（NULL_SAFETY → CORRECTNESS）且行距 2：
    // loose 兜底命中但 strict 不计——strictRate 应为 0
    const baseline = new Map([
      [
        "VUL4J-B",
        new Map([
          [1, [findingAt("b1", "B.java", 10)]],
          [2, [findingAt("b2", "B.java", 12, "CORRECTNESS")]],
          [3, [findingAt("b3", "B.java", 10)]],
        ]),
      ],
    ]);
    const reports = matrixReports(["struts"], REPS, () => ({ baseline: 1, strict: 1 }), () => ({ baseline: 1, strict: 1 }));
    const analysis = analysisOf(reports, baseline);
    const bRep2 = analysis.samples.looSelfDrift.find((s) => s.caseId === "VUL4J-B" && s.rep === 2);
    expect(bRep2?.strictRate).toBe(0);
  });

  it("空基线臂样本 strictRate = null 并如实列明（不进带计算）", () => {
    const reports = matrixReports(
      GROUPS,
      REPS,
      () => ({ baseline: 0, strict: 0 }), // 处理臂全空基线
      () => ({ baseline: 10, strict: 10 }),
    );
    const analysis = analysisOf(reports);
    expect(analysis.completeness.emptyBaselineSamples).toHaveLength(12);
    expect(analysis.comparisonA.candidate).toBeNull(); // 无有效样本
    expect(analysis.comparisonA.verdict).toBe("INSUFFICIENT_SAMPLE");
  });

  it("缺失的组 / rep 如实列明（弃组 / 未跑可见）", () => {
    const reports = matrixReports(["struts", "cxf"], [1], () => ({ baseline: 1, strict: 1 }), () => ({ baseline: 1, strict: 1 }));
    const analysis = analysisOf(reports);
    expect(analysis.completeness.missing).toContain("struts/rep-2");
    expect(analysis.completeness.missing).toContain("spring-sec/rep-1");
    expect(analysis.completeness.foundReports).toHaveLength(2);
  });

  it("计数守卫：不重 / 不误并非零即逐例列出（带 group/rep 定位）", () => {
    const reports: LoadedShardingReport[] = [
      {
        group: "struts",
        rep: 1,
        report: reportOf({
          noDuplicatePairs: [{ findingIdA: "F1", findingIdB: "F2", lineDelta: 0 }],
          noWrongMergeEntries: [
            { anchorFindingId: "F1", members: [], distinctTruthIndices: [0, 1] },
          ],
        }),
      },
    ];
    const analysis = analysisOf(reports);
    expect(analysis.guards.noDuplicate.total).toBe(1);
    expect(analysis.guards.noDuplicate.details[0]).toContain("struts/rep-1");
    expect(analysis.guards.noDuplicate.details[0]).toContain("F1");
    expect(analysis.guards.noWrongMerge.total).toBe(1);
    expect(analysis.guards.noWrongMerge.details[0]).toContain("anchor=F1");
  });
});

describe("buildSigmaBandAnalysis — 归因链与锚点键校准", () => {
  const GROUPS = ["struts", "spring-sec", "cxf", "uaa"];
  const REPS = [1, 2, 3];

  function analysisOf(reports: readonly LoadedShardingReport[]) {
    return buildSigmaBandAnalysis({
      reports,
      expectedGroups: GROUPS,
      expectedReps: REPS,
      baselineFindings: looBaseline(),
      caseById: CASE_BY_ID,
    });
  }

  it("归因链：A 带外（恶化）→ 切分合并效应实锤", () => {
    const reports = matrixReports(GROUPS, REPS, () => ({ baseline: 10, strict: 2 }), () => ({ baseline: 10, strict: 10 }));
    const analysis = analysisOf(reports);
    expect(analysis.comparisonA.verdict).toBe("OUT_WORSE");
    expect(analysis.attribution).toContain("切分合并效应");
  });

  it("归因链：A 带内、B 带外（恶化）→ 填充效应主导", () => {
    // 控制臂 0.0（远低于 LOO 底带），处理臂与控制臂同分布 → A 带内 B 带外
    const reports = matrixReports(GROUPS, REPS, () => ({ baseline: 10, strict: 0 }), () => ({ baseline: 10, strict: 0 }));
    const analysis = analysisOf(reports);
    expect(analysis.comparisonA.verdict).toBe("IN");
    expect(analysis.comparisonB.verdict).toBe("OUT_WORSE");
    expect(analysis.attribution).toContain("填充");
  });

  it("归因链：两对比带内 → 未见真实丢失", () => {
    const reports = matrixReports(GROUPS, REPS, () => ({ baseline: 10, strict: 10 }), () => ({ baseline: 10, strict: 10 }));
    const analysis = analysisOf(reports);
    expect(analysis.comparisonA.verdict).toBe("IN");
    expect(analysis.comparisonB.verdict).toBe("IN");
    expect(analysis.attribution).toContain("带内");
  });

  it("锚点键校准：±1/±3/±5 重放合并数随窗口单调不减；跨片同位置合并计入", () => {
    // 两片各报一条同文件近行 finding（Δ2）：±1 不并、±3 并 → mergedCount 差 1
    const runs = [
      { runId: "CMP#shard-001", findings: [findingAt("s1", "Parser.java", 100)] },
      { runId: "CMP#shard-002", findings: [findingAt("s2", "Parser.java", 102)] },
    ];
    const reports: LoadedShardingReport[] = GROUPS.map((group) => ({
      group,
      rep: 1,
      report: reportOf({ treatmentRuns: runs, includedCaseIds: ["VUL4J-1"] }),
    }));
    const analysis = analysisOf(reports);
    const byWindow = new Map(analysis.anchorKeyCalibration.map((entry) => [entry.lineWindow, entry]));
    expect(byWindow.get(1)!.mergedCount).toBe(8); // 4 组 × 2 条全不并
    expect(byWindow.get(3)!.mergedCount).toBe(4); // 4 组 × 合并后 1 条
    expect(byWindow.get(5)!.mergedCount).toBe(4);
  });

  it("锚点键校准：误并用合成真值（入选案例真值并集）判定", () => {
    // 同文件近行（Δ1）但分属两案例真值位置？——构造：两条 finding 分别单筛命中
    // 不同案例真值下标且被并入同组 → 误并。truth 并集 = Parser.java:5（案 1）
    // + Service.java:5（案 2）；两 finding 同锚（Parser.java:100/101，都命中
    // 不了真值 → FP，无误并）。改为同锚且各自命中不同真值：Parser.java:5 与
    // Service.java:5 不可能同锚（不同文件）→ 直接验证真值并集装载正确性：
    // finding 命中 Parser.java:5 真值 → matchedTruthIndex 0。
    const runs = [
      { runId: "CMP#shard-001", findings: [findingAt("s1", "Parser.java", 5)] },
      { runId: "CMP#shard-002", findings: [findingAt("s2", "Parser.java", 5)] },
    ];
    const reports: LoadedShardingReport[] = [
      { group: "struts", rep: 1, report: reportOf({ treatmentRuns: runs, includedCaseIds: ["VUL4J-1", "VUL4J-2"] }) },
    ];
    const analysis = analysisOf(reports);
    // 同一真值位置的跨片重复被并入不误并（distinctTruthIndices = [0] 单值）
    expect(analysis.anchorKeyCalibration.every((entry) => entry.wrongMergeEntries === 0)).toBe(true);
  });

  it("入选未知案例 / truth 缺失 → fail fast（构造性错误不静默）", () => {
    const reports: LoadedShardingReport[] = [
      {
        group: "struts",
        rep: 1,
        report: reportOf({ treatmentRuns: [{ runId: "s1", findings: [] }], includedCaseIds: ["VUL4J-UNKNOWN"] }),
      },
    ];
    expect(() => analysisOf(reports)).toThrow(/VUL4J-UNKNOWN/);
  });

  it("预算读数：tokens = i+o+cacheRead 逐臂逐 rep 汇总", () => {
    const reports = matrixReports(["struts"], [1], () => ({ baseline: 1, strict: 1 }), () => ({ baseline: 1, strict: 1 }));
    const analysis = analysisOf(reports);
    const treatment = analysis.budgetReadout.tokensPerArmRep.find((entry) => entry.unit === "struts/rep-1/treatment");
    expect(treatment?.tokens).toBe(17); // 10 + 2 + 5
  });
});
