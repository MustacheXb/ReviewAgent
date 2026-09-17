import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ConfigId } from "../../contracts/config.js";
import type { Finding } from "../../contracts/finding.js";
import type { LlmUsage } from "../../contracts/llm-client.js";
import { DEFAULT_SCREENING_OPTIONS, type ScreeningOptions } from "../../metrics/types.js";
import type { RunRecord } from "../run-store.js";
import { DEFAULT_ORCHESTRATION_CONFIG, orchestrateReview, type OrchestratedReview, type OrchestrationConfig } from "../../sharding/orchestrate-review.js";
import type { ShardFindings } from "../../sharding/merge-findings.js";
import {
  type ShardingArms,
  type ShardingGroupSpec,
  composeShardingArms,
} from "./arms.js";
import {
  type BaselineRunInput,
  evaluateNoDuplicate,
  evaluateNoLoss,
  evaluateNoWrongMerge,
  type NoDuplicateReport,
  type NoLossReport,
  type NoWrongMergeReport,
} from "./criteria.js";
import {
  type ExperimentMrRun,
  type ExperimentUnitExecutor,
  experimentSingleMrRunner,
} from "./runner-adapter.js";
import type { CompositeManifest, CompositeMr } from "../synthetic/compose-composite.js";

/**
 * 验证 harness（spec #48 用户故事 15–19，ticket #57）：把双臂构造（arms）、
 * 实验侧运行器适配（runner-adapter）与三判据（criteria）接线为一次可判定的
 * 验证运行——每组的处理臂（切分 + 合并）与控制臂（同款填充、域内直通）都
 * 经同一编排函数 orchestrateReview 执行，验证结论直接对生产形态生效。
 *
 * - 组失败隔离：任一组在任一阶段失败（构造 / 基线 / 处理臂 / 控制臂）只记
 *   failure，不拖垮他组；arms 与 baseline 阶段零 LLM 成本即拒绝。
 * - 臂内 fail-fast：处理臂失败即弃组（控制臂不再执行——省 LLM 成本，组已
 *   不完整无对照价值）；已执行单元的审计文件保留（重跑见落盘记录）。
 * - 基线口径：每个入选案例须有 caseId + configId + model 匹配的 Phase 2
 *   main 侧直跑记录，判据消费 record.baseline（单遍自证快照）——双臂跑的
 *   是同一单遍内核（无 verifier），同口径比较才成立；verifier-on 记录的
 *   effective 会混入二遍复核效应，不用。不约束 source：caseId 按数据集
 *   命名规范全仓唯一（VUL4J-N / MSB-N 形态）。rep 数不设下限——3-rep 等
 *   实验设计参数属 #59。
 * - 判据分列：不丢双臂各算一次；不重 / 不误并只算处理臂（控制臂直通无
 *   合并）。σ 带判定（#30 对称 max σ 带）属实验设计层（#59/#60），本层
 *   只产出逐案例 × rep 轨迹。
 * - 无断点续跑：组粒度重跑即重烧（#59 议题，真跑前权衡预算）。
 * - 报告确定性：产出全 JSON 可序列化、无时间戳，同输入必同报告。
 */

/** 验证运行配置（orchestration / screening / matchWindow 缺省补全后回显于产出） */
export interface ShardingValidationConfig {
  readonly configId: ConfigId;
  readonly model: string;
  readonly orchestration?: OrchestrationConfig;
  readonly screening?: ScreeningOptions;
  /** 不丢匹配行距容差；缺省 = 合并层 lineWindow */
  readonly matchWindow?: number;
}

/** 缺省补全后的配置回显（报告自包含重放上下文） */
export interface ResolvedShardingValidationConfig {
  readonly configId: ConfigId;
  readonly model: string;
  readonly orchestration: OrchestrationConfig;
  readonly screening: ScreeningOptions;
  readonly matchWindow: number;
}

export interface ShardingHarnessDeps {
  /** 单元执行面：DSH 内核驱动 / POC1 runReview 由调用方注入（测试用 fake） */
  readonly executeUnit: ExperimentUnitExecutor;
  /** 审计根目录（每单元目录 = auditRoot / groupId / arm / sanitize(caseId)） */
  readonly auditRoot: string;
}

/** 组输入：双臂构造规格 + 该组候选案例的基线直跑记录 */
export interface ShardingGroupInput {
  readonly spec: ShardingGroupSpec;
  readonly baseline: readonly RunRecord[];
}

export type ShardingFailureStage = "arms" | "baseline" | "treatment" | "control";

export interface GroupFailure {
  readonly groupId: string;
  readonly stage: ShardingFailureStage;
  /** 领域错误码（DatasetError.code）；运行期异常无码为 null */
  readonly code: string | null;
  readonly message: string;
}

/** 臂内单次运行（直通 = 1 条；切分 = 每片一条）的报告分列；runId 即单元 caseId（实验侧适配契约） */
export interface ArmUnitRun {
  readonly runId: string;
  readonly auditPath: string;
  readonly findings: readonly Finding[];
  readonly usage: LlmUsage;
}

/** 单臂运行报告：编排产出 + 不丢判据（不重 / 不误并属组级，只算处理臂） */
export interface ArmRunReport {
  readonly arm: "treatment" | "control";
  readonly compositeId: string;
  readonly caseId: string;
  readonly sharded: boolean;
  readonly shardCount: number;
  readonly findings: readonly Finding[];
  readonly usage: LlmUsage;
  readonly rounds: number;
  readonly toolCalls: number;
  readonly runs: readonly ArmUnitRun[];
  readonly noLoss: NoLossReport;
}

/** 组验证报告：双臂构造 manifest + 双臂运行 + 组级判据（不重 / 不误并） */
export interface GroupValidationReport {
  readonly groupId: string;
  readonly manifests: {
    readonly treatment: CompositeManifest;
    readonly control: CompositeManifest;
  };
  readonly arms: {
    readonly treatment: ArmRunReport;
    readonly control: ArmRunReport;
  };
  readonly noDuplicate: NoDuplicateReport;
  readonly noWrongMerge: NoWrongMergeReport;
}

export interface ShardingValidationOutcome {
  readonly config: ResolvedShardingValidationConfig;
  readonly groups: readonly GroupValidationReport[];
  readonly failures: readonly GroupFailure[];
}

export async function runShardingValidation(params: {
  readonly config: ShardingValidationConfig;
  readonly deps: ShardingHarnessDeps;
  readonly groups: readonly ShardingGroupInput[];
}): Promise<ShardingValidationOutcome> {
  const orchestration = params.config.orchestration ?? DEFAULT_ORCHESTRATION_CONFIG;
  const resolved: ResolvedShardingValidationConfig = {
    configId: params.config.configId,
    model: params.config.model,
    orchestration,
    screening: params.config.screening ?? DEFAULT_SCREENING_OPTIONS,
    matchWindow: params.config.matchWindow ?? orchestration.merge.lineWindow,
  };
  const groups: GroupValidationReport[] = [];
  const failures: GroupFailure[] = [];
  for (const group of params.groups) {
    const report = await runGroup(group, resolved, params.deps);
    if ("failure" in report) {
      failures.push(report.failure);
    } else {
      groups.push(report.report);
    }
  }
  return { config: resolved, groups, failures };
}

/** 组内单臂执行结果（失败即弃组；成功携带报告与编排产出） */
type ArmOutcome =
  | { readonly failure: GroupFailure }
  | { readonly report: ArmRunReport; readonly review: OrchestratedReview<ExperimentMrRun> };

async function runGroup(
  group: ShardingGroupInput,
  resolved: ResolvedShardingValidationConfig,
  deps: ShardingHarnessDeps,
): Promise<{ readonly failure: GroupFailure } | { readonly report: GroupValidationReport }> {
  const groupId = group.spec.groupId;

  // 阶段 1：双臂构造 + 臂不变式预检（零 LLM 成本）
  const arms = composeShardingArms(group.spec, resolved.orchestration.shard);
  if (!arms.ok) {
    return {
      failure: { groupId, stage: "arms", code: arms.error.code, message: arms.error.message },
    };
  }

  // 阶段 2：基线校验（零 LLM 成本）：每个入选案例须有同 configId + model 的直跑记录
  const baselineInputs: BaselineRunInput[] = [];
  const missing: string[] = [];
  for (const caseId of arms.value.treatment.manifest.includedCaseIds) {
    const records = group.baseline.filter(
      (record) =>
        record.caseId === caseId &&
        record.configId === resolved.configId &&
        record.model === resolved.model,
    );
    if (records.length === 0) {
      missing.push(caseId);
      continue;
    }
    for (const record of records) {
      baselineInputs.push({
        caseId: record.caseId,
        rep: record.rep,
        findings: record.baseline.findings,
      });
    }
  }
  if (missing.length > 0) {
    return {
      failure: {
        groupId,
        stage: "baseline",
        code: "HARNESS_BASELINE_MISSING",
        message: `基线记录缺失：${missing.join("、")}（需 caseId + configId ${resolved.configId} + model ${resolved.model} 匹配的 Phase 2 main 侧直跑记录）`,
      },
    };
  }

  // 阶段 3：处理臂（fail-fast：首臂失败即弃组，控制臂不再执行）
  const treatment = await runArm("treatment", arms.value, groupId, baselineInputs, resolved, deps);
  if ("failure" in treatment) {
    return { failure: treatment.failure };
  }
  // 阶段 4：控制臂
  const control = await runArm("control", arms.value, groupId, baselineInputs, resolved, deps);
  if ("failure" in control) {
    return { failure: control.failure };
  }

  // 阶段 5：组级判据（只算处理臂——控制臂直通无合并）
  const noDuplicate = evaluateNoDuplicate(
    treatment.report.findings,
    resolved.orchestration.merge.lineWindow,
  );
  // 不误并重放原料：执行序 = 片序（orchestrateReview 契约），runs 与 shards.entries 按下标对位
  const shardsForReplay: ShardFindings[] = treatment.review.runs.map((run, index) => ({
    shardId: treatment.review.shards!.entries[index]!.shardId,
    findings: run.findings,
  }));
  const noWrongMerge = evaluateNoWrongMerge({
    shards: shardsForReplay,
    merge: resolved.orchestration.merge,
    // composeComposite 契约：入选案例 truth 非 null，合成真值 = 并集
    truth: arms.value.treatment.mrCase.truth!,
    screening: resolved.screening,
  });
  if (!noWrongMerge.ok) {
    return {
      failure: {
        groupId,
        stage: "treatment",
        code: noWrongMerge.error.code,
        message: noWrongMerge.error.message,
      },
    };
  }

  return {
    report: {
      groupId,
      manifests: {
        treatment: arms.value.treatment.manifest,
        control: arms.value.control.manifest,
      },
      arms: { treatment: treatment.report, control: control.report },
      noDuplicate,
      noWrongMerge: noWrongMerge.value,
    },
  };
}

/** 单臂执行：适配器 + 同一编排函数 + 臂不变式后验 + 不丢判据 */
async function runArm(
  arm: "treatment" | "control",
  arms: ShardingArms,
  groupId: string,
  baselineInputs: readonly BaselineRunInput[],
  resolved: ResolvedShardingValidationConfig,
  deps: ShardingHarnessDeps,
): Promise<ArmOutcome> {
  const composite: CompositeMr = arm === "treatment" ? arms.treatment : arms.control;
  const runner = experimentSingleMrRunner({
    configId: resolved.configId,
    model: resolved.model,
    auditRoot: join(deps.auditRoot, groupId, arm),
    executeUnit: deps.executeUnit,
  });
  try {
    const result = await orchestrateReview(composite.mrCase, runner, resolved.orchestration);
    if (!result.ok) {
      return {
        failure: { groupId, stage: arm, code: result.error.code, message: result.error.message },
      };
    }
    const review = result.value;
    // 臂不变式后验（与构造预检同款配置，违背即 harness 缺陷信号——不静默产出）
    if (arm === "treatment" && !review.sharded) {
      throw new Error("处理臂运行结果未切分（与构造预检矛盾）——harness 缺陷，请上报");
    }
    if (arm === "control" && review.sharded) {
      throw new Error("控制臂运行结果被切分（与构造预检矛盾）——harness 缺陷，请上报");
    }
    const noLoss = evaluateNoLoss({
      baseline: baselineInputs,
      findings: review.findings,
      matchWindow: resolved.matchWindow,
      screening: resolved.screening,
    });
    const report: ArmRunReport = {
      arm,
      compositeId: composite.manifest.compositeId,
      caseId: composite.mrCase.caseId,
      sharded: review.sharded,
      shardCount: review.shards?.count ?? 0,
      findings: review.findings,
      usage: review.usage,
      rounds: review.runs.reduce((sum, run) => sum + run.rounds, 0),
      toolCalls: review.runs.reduce((sum, run) => sum + run.toolCalls, 0),
      runs: review.runs.map((run) => ({
        runId: run.runId,
        auditPath: run.auditPath,
        findings: run.findings,
        usage: run.usage,
      })),
      noLoss,
    };
    return { report, review };
  } catch (error) {
    // 运行期异常（单元执行 / 判据输入形状）：无领域码，按臂归因弃组
    return {
      failure: {
        groupId,
        stage: arm,
        code: null,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** 验证报告落盘：<reportDir>/report.json（确定性全量 JSON；返回写入路径） */
export function writeShardingValidationReport(
  reportDir: string,
  outcome: ShardingValidationOutcome,
): string {
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, "report.json");
  writeFileSync(reportPath, `${JSON.stringify(outcome, null, 2)}\n`, "utf8");
  return reportPath;
}
