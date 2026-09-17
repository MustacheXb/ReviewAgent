import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ConfigId } from "../../../src/contracts/config.js";
import type { Finding } from "../../../src/contracts/finding.js";
import type { RunRecord } from "../../../src/experiment/run-store.js";
import {
  runShardingValidation,
  writeShardingValidationReport,
} from "../../../src/experiment/sharding/harness.js";
import {
  type ExperimentUnitRequest,
  type ExperimentUnitExecutor,
} from "../../../src/experiment/sharding/runner-adapter.js";
import { DEFAULT_MERGE_CONFIG } from "../../../src/sharding/merge-findings.js";
import { PARSER_PATH, SERVICE_PATH } from "../synthetic/fixtures.js";
import { SMALL_BOUNDARY, finding, specOf } from "./fixtures.js";

/**
 * #57 验证 harness（spec #48 用户故事 15–19）：双臂经同一编排函数
 * （orchestrateReview + 实验侧适配器）执行，产出三判据报告；失败按组隔离。
 *
 * 锁线：成功组全链路（双臂 manifest + 编排回显 + 不丢/不重/不误并分列）、
 * 组失败隔离（arms / baseline / treatment / control 四阶段不拖垮他组）、
 * 臂内 fail-fast（首臂失败不再烧控制臂）、报告落盘可重读。
 */

/** Phase 2 main 侧直跑基线记录（每案例 × 2 rep；findings 命中各自真值行位） */
function baselineRecords(caseIds: readonly string[] = ["VUL4J-1", "VUL4J-2"], model = "test-model"): RunRecord[] {
  const records: RunRecord[] = [];
  for (const caseId of caseIds) {
    for (const rep of [1, 2]) {
      records.push({
        source: "vul4j",
        caseId,
        configId: "B" as ConfigId,
        rep,
        model,
        verifier: "off",
        completedAt: "2026-09-01T00:00:00Z",
        baseline: {
          findings: [finding(`${caseId}-rep${rep}`, { file: caseId === "VUL4J-1" ? PARSER_PATH : SERVICE_PATH, line: 5 })],
          usage: { inputTokens: 5, outputTokens: 1 },
          rounds: 1,
          toolCalls: 0,
          audit: { toolCallLog: [], phaseLog: [], rejections: [], truncated: false, truncationReasons: [] },
          auditPath: `runs/vul4j/${caseId}/B/rep-${rep}.json`,
        },
        effective: null,
        verifierPass: null,
      });
    }
  }
  return records;
}

/** fake 单元执行面：按 diff 中的案例文件标记产出对应 finding，其余字段最小化 */
function recordingExecutor(
  log: ExperimentUnitRequest[],
  failOn?: (request: ExperimentUnitRequest) => string | undefined,
): ExperimentUnitExecutor {
  return async (request) => {
    log.push(request);
    const failure = failOn?.(request);
    if (failure !== undefined) {
      throw new Error(failure);
    }
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

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("runShardingValidation（#57 验证 harness）", () => {
  it("成功组全链路：双臂经同一编排执行，manifest / 判据 / 配置回显分列", async () => {
    const log: ExperimentUnitRequest[] = [];
    const auditRoot = join("audit-root");
    const outcome = await runShardingValidation({
      config: {
        configId: "B" as ConfigId,
        model: "test-model",
        orchestration: { shard: SMALL_BOUNDARY, merge: DEFAULT_MERGE_CONFIG },
      },
      deps: { auditRoot, executeUnit: recordingExecutor(log) },
      groups: [{ spec: specOf("g1"), baseline: baselineRecords() }],
    });

    expect(outcome.failures).toEqual([]);
    expect(outcome.groups.length).toBe(1);
    // 配置回显：缺省补全（screening 判定链缺省 / matchWindow = 合并窗口）
    expect(outcome.config).toEqual({
      configId: "B",
      model: "test-model",
      orchestration: { shard: SMALL_BOUNDARY, merge: { lineWindow: 3 } },
      screening: { lineTolerance: 0, natureAliases: {} },
      matchWindow: 3,
    });

    const group = outcome.groups[0]!;
    expect(group.groupId).toBe("g1");
    expect(group.manifests.treatment.compositeId).toBe("g1-treatment");
    expect(group.manifests.control.compositeId).toBe("g1-control");
    expect(group.manifests.treatment.includedCaseIds).toEqual(["VUL4J-2", "VUL4J-1"]);

    // 处理臂：切分 + 合并（usage / 轮次 = 各片之和；审计目录按组/臂/单元隔离）
    const treatment = group.arms.treatment;
    expect(treatment.arm).toBe("treatment");
    expect(treatment.sharded).toBe(true);
    expect(treatment.shardCount).toBeGreaterThanOrEqual(2);
    expect(treatment.runs.length).toBe(treatment.shardCount);
    expect(treatment.findings.map((f) => f.file).sort()).toEqual([PARSER_PATH, SERVICE_PATH].sort());
    expect(treatment.usage).toEqual({ inputTokens: 10 * treatment.shardCount, outputTokens: 2 * treatment.shardCount });
    expect(treatment.rounds).toBe(treatment.shardCount);
    expect(treatment.toolCalls).toBe(treatment.shardCount);
    expect(treatment.runs.every((run) => run.runId.startsWith("g1-treatment#shard-"))).toBe(true);
    expect(treatment.runs.every((run) => run.auditPath.startsWith(join(auditRoot, "g1", "treatment")))).toBe(true);

    // 控制臂：直通单跑（不切分）
    const control = group.arms.control;
    expect(control.arm).toBe("control");
    expect(control.sharded).toBe(false);
    expect(control.shardCount).toBe(0);
    expect(control.runs.map((run) => run.runId)).toEqual(["g1-control"]);
    expect(control.findings.length).toBe(2);
    expect(control.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(control.runs[0]?.auditPath).toBe(join(auditRoot, "g1", "control", "g1-control", "audit.json"));

    // 判据一（不丢）：双臂基线全中（2 案例 × 2 rep；strict 全中无 loose；
    // perCase 按 includedCaseIds 序）
    for (const arm of [treatment, control]) {
      expect(arm.noLoss.totalBaseline).toBe(4);
      expect(arm.noLoss.totalStrict).toBe(4);
      expect(arm.noLoss.totalLoose).toBe(0);
      expect(arm.noLoss.totalMatched).toBe(4);
      expect(arm.noLoss.totalLost).toBe(0);
      expect(
        arm.noLoss.perCase.map((entry) => [
          entry.caseId,
          entry.repCount,
          entry.strictMatched,
          entry.looseMatched,
          entry.lost,
        ]),
      ).toEqual([
        ["VUL4J-2", 2, 2, 0, 0],
        ["VUL4J-1", 2, 2, 0, 0],
      ]);
    }

    // 判据二（不重）：片不相交 + 片内无同键 → 无重复对
    expect(group.noDuplicate.findingCount).toBe(2);
    expect(group.noDuplicate.pairs).toEqual([]);

    // 判据三（不误并）：无实际并入组
    expect(group.noWrongMerge.mergedEntryCount).toBe(0);
    expect(group.noWrongMerge.entries).toEqual([]);

    // 单元请求面：configId / model / 审计根均按臂派生
    expect(log.length).toBe(treatment.shardCount + 1);
    expect(log.every((request) => request.configId === "B" && request.model === "test-model")).toBe(true);
    expect(log.filter((request) => request.caseId.includes("control")).length).toBe(1);
  });

  it("组失败隔离：arms / baseline 阶段失败零执行成本，不拖垮他组", async () => {
    const log: ExperimentUnitRequest[] = [];
    const outcome = await runShardingValidation({
      config: {
        configId: "B" as ConfigId,
        model: "test-model",
        orchestration: { shard: SMALL_BOUNDARY, merge: DEFAULT_MERGE_CONFIG },
      },
      deps: { auditRoot: "audit-root", executeUnit: recordingExecutor(log) },
      groups: [
        {
          // 档位配错：处理臂未超界 → 构造阶段拒绝
          spec: { ...specOf("g-bad"), treatmentFill: { targetFiles: 2, targetDiffLines: 6 } },
          baseline: baselineRecords(),
        },
        {
          // 基线缺失：VUL4J-2 无匹配记录 → 基线阶段失败（未烧任何 LLM 调用）
          spec: specOf("g-missing"),
          baseline: baselineRecords(["VUL4J-1"]),
        },
        { spec: specOf("g-good"), baseline: baselineRecords() },
      ],
    });

    expect(outcome.groups.map((group) => group.groupId)).toEqual(["g-good"]);
    expect(outcome.failures).toEqual([
      {
        groupId: "g-bad",
        stage: "arms",
        code: "HARNESS_ARM_INVALID",
        message: expect.stringContaining("treatment"),
      },
      {
        groupId: "g-missing",
        stage: "baseline",
        code: "HARNESS_BASELINE_MISSING",
        message: expect.stringContaining("VUL4J-2"),
      },
    ]);
    // 失败组零执行：全部请求都属于成功组
    expect(log.length).toBeGreaterThan(0);
    expect(log.every((request) => request.caseId.startsWith("g-good"))).toBe(true);
  });

  it("基线匹配口径：caseId 命中但 configId / model 不匹配视同缺失", async () => {
    const log: ExperimentUnitRequest[] = [];
    const outcome = await runShardingValidation({
      config: {
        configId: "B" as ConfigId,
        model: "test-model",
        orchestration: { shard: SMALL_BOUNDARY, merge: DEFAULT_MERGE_CONFIG },
      },
      deps: { auditRoot: "audit-root", executeUnit: recordingExecutor(log) },
      groups: [{ spec: specOf("g1"), baseline: baselineRecords(undefined, "other-model") }],
    });

    expect(outcome.groups).toEqual([]);
    expect(outcome.failures.length).toBe(1);
    expect(outcome.failures[0]?.stage).toBe("baseline");
    expect(outcome.failures[0]?.message).toContain("VUL4J-2");
    expect(log).toEqual([]);
  });

  it("臂内失败隔离 + fail-fast：处理臂单元执行失败 → 组失败于 treatment 阶段，控制臂不再执行", async () => {
    const log: ExperimentUnitRequest[] = [];
    const outcome = await runShardingValidation({
      config: {
        configId: "B" as ConfigId,
        model: "test-model",
        orchestration: { shard: SMALL_BOUNDARY, merge: DEFAULT_MERGE_CONFIG },
      },
      deps: {
        auditRoot: "audit-root",
        executeUnit: recordingExecutor(log, (request) =>
          request.caseId.startsWith("g1-treatment") ? "unit executor boom" : undefined,
        ),
      },
      groups: [{ spec: specOf("g1"), baseline: baselineRecords() }],
    });

    expect(outcome.groups).toEqual([]);
    expect(outcome.failures).toEqual([
      { groupId: "g1", stage: "treatment", code: null, message: "unit executor boom" },
    ]);
    // fail-fast：处理臂首片失败即弃组，控制臂（与后续片）未执行
    expect(log.length).toBe(1);
    expect(log[0]?.caseId.startsWith("g1-treatment")).toBe(true);
  });

  it("控制臂失败归因 control 阶段（处理臂已完成的执行留痕保留于审计目录）", async () => {
    const log: ExperimentUnitRequest[] = [];
    const outcome = await runShardingValidation({
      config: {
        configId: "B" as ConfigId,
        model: "test-model",
        orchestration: { shard: SMALL_BOUNDARY, merge: DEFAULT_MERGE_CONFIG },
      },
      deps: {
        auditRoot: "audit-root",
        executeUnit: recordingExecutor(log, (request) =>
          request.caseId === "g1-control" ? "control boom" : undefined,
        ),
      },
      groups: [{ spec: specOf("g1"), baseline: baselineRecords() }],
    });

    expect(outcome.groups).toEqual([]);
    expect(outcome.failures).toEqual([
      { groupId: "g1", stage: "control", code: null, message: "control boom" },
    ]);
  });

  it("报告落盘可重读：writeShardingValidationReport 写 report.json，内容与产出一致", async () => {
    const outcome = await runShardingValidation({
      config: {
        configId: "B" as ConfigId,
        model: "test-model",
        orchestration: { shard: SMALL_BOUNDARY, merge: DEFAULT_MERGE_CONFIG },
      },
      deps: { auditRoot: "audit-root", executeUnit: recordingExecutor([]) },
      groups: [{ spec: specOf("g1"), baseline: baselineRecords() }],
    });
    expect(outcome.groups.length).toBe(1);

    const reportDir = mkdtempSync(join(tmpdir(), "sharding-harness-"));
    tmpDirs.push(reportDir);
    const written = writeShardingValidationReport(reportDir, outcome);

    expect(written).toBe(join(reportDir, "report.json"));
    expect(JSON.parse(readFileSync(written, "utf8"))).toEqual(outcome);
  });
});
