import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ConfigId } from "../../../src/contracts/config.js";
import type { Finding } from "../../../src/contracts/finding.js";
import type { MRTruth } from "../../../src/contracts/mr-case.js";
import type { RunRecord } from "../../../src/experiment/run-store.js";
import type { ShardingGroupInput } from "../../../src/experiment/sharding/harness.js";
import {
  buildGroupInputs,
  loadRepoSnapshot,
  runValidationGroups,
} from "../../../src/experiment/sharding/validation-driver.js";
import type { ExperimentUnitExecutor, ExperimentUnitRequest } from "../../../src/experiment/sharding/runner-adapter.js";
import { DEFAULT_MERGE_CONFIG } from "../../../src/sharding/merge-findings.js";
import {
  FIX_PATCH_PARSER,
  FIX_PATCH_SERVICE,
  PARSER_PATH,
  SERVICE_PATH,
  makeCandidate,
  snapshotV2,
} from "../synthetic/fixtures.js";
import { SMALL_BOUNDARY, finding, specOf } from "./fixtures.js";

/**
 * #59 驱动层（实验设计 §2.1–2.5）：真跑矩阵的组装与执行编排——
 * 同仓案例组装（锚定 + repoPath/snapshot 统一）、Phase 2 基线装载、
 * 逐组 × 逐 rep 独立落盘（断点粒度 = 组 × rep）。
 *
 * 锁线：锚 = fix commit 最新者（组内 repoPath/snapshot 全统一到锚，干净
 * 套用校验兜内容匹配）；基线记录逐案 × rep 装载；快照按 repoPath memo；
 * 组装输入错误（案例/时间缺失）fail fast；断点 = report.json 存在即跳过。
 */

const WORK_DIRS: string[] = [];

async function withWorkDir(): Promise<string> {
  const dir = await Promise.resolve(mkdtempSync(join(tmpdir(), "sharding-driver-")));
  WORK_DIRS.push(dir);
  return dir;
}

afterEach(() => {
  while (WORK_DIRS.length > 0) {
    const dir = WORK_DIRS.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function truthOf(file: string, fixPatch: string): MRTruth {
  return {
    locations: [{ file, lineStart: 5, lineEnd: 5, defectNature: "NULL_SAFETY" }],
    fixPatch,
  };
}

/** 两案驱动素材：VUL4J-1（旧 fix，clone-1）+ VUL4J-2（新 fix = 锚，clone-2） */
function driverCases() {
  return [
    makeCandidate(
      "VUL4J-1",
      "2024-01-10T00:00:00Z",
      FIX_PATCH_PARSER,
      truthOf(PARSER_PATH, FIX_PATCH_PARSER),
      snapshotV2(),
      "D:/repos/clone-1",
    ),
    makeCandidate(
      "VUL4J-2",
      "2024-06-15T00:00:00Z",
      FIX_PATCH_SERVICE,
      truthOf(SERVICE_PATH, FIX_PATCH_SERVICE),
      snapshotV2(),
      "D:/repos/clone-2",
    ),
  ];
}

function baselineRecordOf(caseId: string, rep: number, model: string): RunRecord {
  return {
    source: "vul4j",
    caseId,
    configId: "B" as ConfigId,
    rep,
    model,
    verifier: "off",
    completedAt: "2026-09-01T00:00:00Z",
    baseline: {
      findings: [finding(`${caseId}-rep${rep}`, { file: PARSER_PATH, line: 5 })],
      usage: { inputTokens: 5, outputTokens: 1 },
      rounds: 1,
      toolCalls: 0,
      audit: { toolCallLog: [], phaseLog: [], rejections: [], truncated: false, truncationReasons: [] },
      auditPath: `runs/vul4j/${caseId}/B/rep-${rep}.json`,
    },
    effective: null,
    verifierPass: null,
  };
}

/** fake 单元执行面（harness.test 同款：按 diff 中的案例文件产出 finding） */
function fakeExecutor(log: ExperimentUnitRequest[]): ExperimentUnitExecutor {
  return async (request) => {
    log.push(request);
    const findings: Finding[] = [];
    if (request.diff.includes(PARSER_PATH)) {
      findings.push(finding(`${request.caseId}-parser`, { file: PARSER_PATH, line: 5 }));
    }
    if (request.diff.includes(SERVICE_PATH)) {
      findings.push(finding(`${request.caseId}-service`, { file: SERVICE_PATH, line: 5 }));
    }
    return {
      caseId: request.caseId,
      configId: request.configId,
      model: request.model,
      findings,
      usage: { inputTokens: 10, outputTokens: 2 },
      rounds: 1,
      toolCalls: 1,
      audit: {
        requests: [],
        toolCallLog: [],
        phaseLog: [],
        rejections: [],
        cacheBreaks: [],
        truncated: false,
        truncationReasons: [],
      },
      auditPath: join(request.auditDir, "audit.json"),
    };
  };
}

describe("loadRepoSnapshot — clone 目录 → SourceSnapshot", () => {
  it("递归收 .java 文件（相对路径键、posix 分隔）；非 .java 排除；路径排序确定性", async () => {
    const root = await withWorkDir();
    mkdirSync(join(root, "core", "src", "main"), { recursive: true });
    mkdirSync(join(root, "other"), { recursive: true });
    writeFileSync(join(root, "core", "src", "main", "A.java"), "class A {}\n", "utf8");
    writeFileSync(join(root, "other", "B.java"), "class B {}\n", "utf8");
    writeFileSync(join(root, "other", "notes.txt"), "not java\n", "utf8");
    writeFileSync(join(root, "pom.xml"), "<project/>\n", "utf8");

    const snapshot = await loadRepoSnapshot(root);
    expect(Object.keys(snapshot)).toEqual([
      "core/src/main/A.java",
      "other/B.java",
    ]);
    expect(snapshot["core/src/main/A.java"]).toBe("class A {}\n");
    // 同目录重读 = 确定性（键序稳定）
    const again = await loadRepoSnapshot(root);
    expect(Object.keys(again)).toEqual(Object.keys(snapshot));
  });

  it("目录不存在 → fail fast", async () => {
    const root = await withWorkDir();
    await expect(loadRepoSnapshot(join(root, "no-such-repo"))).rejects.toThrow(/no-such-repo/);
  });
});

describe("buildGroupInputs — 组装（锚统一 + 基线装载）", () => {
  const groupConfig = {
    groupId: "struts",
    caseIds: ["VUL4J-2", "VUL4J-1"], // 乱序输入：驱动层按 caseId 升序定尝试序
    treatmentFill: { targetFiles: 6, targetDiffLines: 20 },
    controlFill: { targetFiles: 2, targetDiffLines: 6 },
  };

  function driverDeps() {
    const candidates = driverCases();
    const snapshotCalls: string[] = [];
    return {
      candidates,
      snapshotCalls,
      loadSnapshot: async (repoPath: string) => {
        snapshotCalls.push(repoPath);
        return snapshotV2();
      },
      fixCommitDates: new Map(
        candidates.map((candidate) => [candidate.mrCase.caseId, candidate.fixCommitAt]),
      ),
    };
  }

  it("锚 = fix commit 最新者；组内 repoPath/snapshot 全统一到锚；快照按锚装载一次", async () => {
    const deps = driverDeps();
    const outcome = await buildGroupInputs({
      groups: [groupConfig],
      cases: deps.candidates.map((candidate) => candidate.mrCase),
      fixCommitDates: deps.fixCommitDates,
      loadSnapshot: deps.loadSnapshot,
      readBaseline: async (unit) => baselineRecordOf(unit.caseId, unit.rep, "test-model"),
      baselineReps: [1, 2],
      configId: "B",
      model: "test-model",
    });

    expect(outcome.groups.length).toBe(1);
    const built = outcome.groups[0]!;
    expect(built.anchorCaseId).toBe("VUL4J-2"); // 2024-06-15 最新
    // 全候选统一到锚 repoPath（clone-2）；snapshot 同一实例（锚快照）
    const paths = built.input.spec.candidates.map((candidate) => candidate.mrCase.repoPath);
    expect(paths).toEqual(["D:/repos/clone-2", "D:/repos/clone-2"]);
    const snapshots = built.input.spec.candidates.map((candidate) => candidate.snapshot);
    expect(new Set(snapshots).size).toBe(1);
    // 尝试序 = caseId 升序（确定性）
    expect(built.input.spec.candidates.map((candidate) => candidate.mrCase.caseId)).toEqual([
      "VUL4J-1",
      "VUL4J-2",
    ]);
    // 快照只装锚一次（memo：组内统一后仅锚 repoPath 在装载面）
    expect(deps.snapshotCalls).toEqual(["D:/repos/clone-2"]);
    // 档位透传
    expect(built.input.spec.treatmentFill).toEqual(groupConfig.treatmentFill);
    expect(built.input.spec.controlFill).toEqual(groupConfig.controlFill);
  });

  it("基线装载：逐案 × rep 全记录进 baseline（缺失记录不阻塞——harness 阶段 2 拦）", async () => {
    const deps = driverDeps();
    const outcome = await buildGroupInputs({
      groups: [groupConfig],
      cases: deps.candidates.map((candidate) => candidate.mrCase),
      fixCommitDates: deps.fixCommitDates,
      loadSnapshot: deps.loadSnapshot,
      readBaseline: async (unit) =>
        unit.caseId === "VUL4J-1" && unit.rep === 2 ? null : baselineRecordOf(unit.caseId, unit.rep, "test-model"),
      baselineReps: [1, 2],
      configId: "B",
      model: "test-model",
    });
    const baseline = outcome.groups[0]!.input.baseline;
    expect(baseline.map((record) => `${record.caseId}/rep-${record.rep}`).sort()).toEqual([
      "VUL4J-1/rep-1",
      "VUL4J-2/rep-1",
      "VUL4J-2/rep-2",
    ]);
  });

  it("案例缺失 / fixCommitAt 缺失 → fail fast（配置错误不进矩阵）", async () => {
    const deps = driverDeps();
    const base = {
      groups: [groupConfig],
      cases: deps.candidates.map((candidate) => candidate.mrCase),
      loadSnapshot: deps.loadSnapshot,
      readBaseline: async (unit: { readonly caseId: string; readonly rep: number }) =>
        baselineRecordOf(unit.caseId, unit.rep, "test-model"),
      baselineReps: [1, 2],
      configId: "B" as ConfigId,
      model: "test-model",
    };
    await expect(
      buildGroupInputs({
        ...base,
        cases: base.cases.slice(0, 1), // VUL4J-2 缺失
        fixCommitDates: deps.fixCommitDates,
      }),
    ).rejects.toThrow(/VUL4J-2/);
    await expect(
      buildGroupInputs({
        ...base,
        fixCommitDates: new Map([["VUL4J-1", "2024-01-10T00:00:00Z"]]), // VUL4J-2 无时间
      }),
    ).rejects.toThrow(/VUL4J-2/);
  });
});

describe("runValidationGroups — 逐组 × rep 执行与断点", () => {
  it("组优先 × rep 内层：逐组逐 rep 落盘 report.json；audit 按 rep 分目录", async () => {
    const reportRoot = await withWorkDir();
    const auditRoot = await withWorkDir();
    const log: ExperimentUnitRequest[] = [];
    const groups: ShardingGroupInput[] = [
      {
        spec: specOf("g1"),
        baseline: [
          baselineRecordOf("VUL4J-1", 1, "test-model"),
          baselineRecordOf("VUL4J-2", 1, "test-model"),
        ],
      },
    ];

    const outcome = await runValidationGroups({
      groups,
      config: {
        configId: "B",
        model: "test-model",
        orchestration: { shard: SMALL_BOUNDARY, merge: DEFAULT_MERGE_CONFIG },
      },
      deps: { executeUnit: fakeExecutor(log) },
      auditRoot,
      reportRoot,
      reps: [1, 2],
    });

    expect(outcome.executed).toEqual(["g1/rep-1", "g1/rep-2"]);
    expect(outcome.skipped).toEqual([]);
    // 逐 rep 报告可重读（断点判据 = 该文件存在）
    for (const rep of [1, 2]) {
      const raw = JSON.parse(
        readFileSync(join(reportRoot, "g1", `rep-${rep}`, "report.json"), "utf8"),
      ) as { readonly groups: readonly { readonly groupId: string }[] };
      expect(raw.groups[0]!.groupId).toBe("g1");
    }
    // audit 目录按 rep 分（executor 收到的 auditDir 带 rep 段）
    const repSegments = log.map((request) => request.auditDir.split("rep-")[1]?.split(/[\\/]/)[0]);
    expect(new Set(repSegments)).toEqual(new Set(["1", "2"]));
  });

  it("断点：已落盘的组 × rep 跳过（零执行、零 LLM 成本）", async () => {
    const reportRoot = await withWorkDir();
    const auditRoot = await withWorkDir();
    const log: ExperimentUnitRequest[] = [];
    const groups: ShardingGroupInput[] = [
      {
        spec: specOf("g1"),
        baseline: [
          baselineRecordOf("VUL4J-1", 1, "test-model"),
          baselineRecordOf("VUL4J-2", 1, "test-model"),
        ],
      },
    ];
    const params = {
      groups,
      config: {
        configId: "B" as ConfigId,
        model: "test-model",
        orchestration: { shard: SMALL_BOUNDARY, merge: DEFAULT_MERGE_CONFIG },
      },
      deps: { executeUnit: fakeExecutor(log) },
      auditRoot,
      reportRoot,
      reps: [1, 2] as const,
    };

    await runValidationGroups(params);
    const firstRunCalls = log.length;
    const rerun = await runValidationGroups(params);

    expect(rerun.executed).toEqual([]);
    expect(rerun.skipped).toEqual(["g1/rep-1", "g1/rep-2"]);
    expect(log.length).toBe(firstRunCalls); // 零新增执行
  });

  it("组失败隔离：失败组记入 failures 他组照常；重跑时成功组跳过、失败组重试", async () => {
    const reportRoot = await withWorkDir();
    const auditRoot = await withWorkDir();
    const log: ExperimentUnitRequest[] = [];
    // g1 的 baseline 为空 → HARNESS_BASELINE_MISSING 组失败；g2 正常
    const groups: ShardingGroupInput[] = [
      { spec: specOf("g1"), baseline: [] },
      {
        spec: specOf("g2"),
        baseline: [
          baselineRecordOf("VUL4J-1", 1, "test-model"),
          baselineRecordOf("VUL4J-2", 1, "test-model"),
        ],
      },
    ];
    const params = {
      groups,
      config: {
        configId: "B" as ConfigId,
        model: "test-model",
        orchestration: { shard: SMALL_BOUNDARY, merge: DEFAULT_MERGE_CONFIG },
      },
      deps: { executeUnit: fakeExecutor(log) },
      auditRoot,
      reportRoot,
      reps: [1] as const,
    };

    const outcome = await runValidationGroups(params);

    expect(outcome.failures.map((failure) => failure.groupId)).toEqual(["g1"]);
    expect(outcome.executed).toEqual(["g2/rep-1"]);
    // 重跑：成功组断点跳过（零重烧）；失败组无 report.json → 重试（baseline
    // 阶段零 LLM 成本即拒，重试不烧钱——暂时性 LLM 失败同理可重试）
    const rerun = await runValidationGroups(params);
    expect(rerun.skipped).toEqual(["g2/rep-1"]);
    expect(rerun.executed).toEqual([]); // g1 重试后仍失败（配置性失败）——无成功产物
    expect(rerun.failures.map((failure) => failure.groupId)).toEqual(["g1"]);
  });
});
