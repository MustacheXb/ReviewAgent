import type { MRCase } from "../contracts/mr-case.js";
import type { Finding } from "../contracts/finding.js";
import type { LlmUsage } from "../contracts/llm-client.js";
import type { MrBoundary } from "../dataset/mr-boundary-filter.js";
import { type Result, err, ok } from "../dataset/diff/types.js";
import { addUsage, ZERO_USAGE } from "../loop/usage.js";
import {
  type MergeConfig,
  DEFAULT_MERGE_CONFIG,
  mergeShardFindings,
  validateMergeConfig,
} from "./merge-findings.js";
import {
  type ShardConfig,
  type ShardReason,
  DEFAULT_SHARD_CONFIG,
  planShards,
} from "./plan-shards.js";

/**
 * 骨架外编排入口（spec #48 实现决策 1、10–13，ADR-0009，ticket #54）：
 * 串联切分器与合并层，以注入的单 MR 运行器执行——域内 MRCase 直通
 * （单次直接运行，结果不携带任何新字段）；超界 MR 切分串行下发，各片
 * 产出按锚点键去重合并为单份检视结果。
 *
 * - 执行语义：分片间串行（决策 10——兑现 Zone A / Zone B 跨片前缀缓存）。
 * - 审计与计量：每片一份独立运行留痕（runId / auditPath），合并结果经
 *   shards 节 entries 与 runs 引用各片审计；usage / token 口径 = 各片之和
 *   （冻结 addUsage 聚合语义单一来源）。
 * - 结果形状（决策 11）：shards 节与 Finding 的 shardIds 仅在切分发生时
 *   出现；域内直通结果不携带任何新字段。
 * - 拒绝语义：计划类拒绝（非法配置 / diff 不可解析 / 分片数超限）经
 *   Result 可区分上抛（零运行成本）；运行器自身失败自然抛出（调用方
 *   ——如生产 CLI——据两类失败分别给退出语义）。
 * - 普通库，不进 DSH 插件树（决策 1）；生产侧适配 DSH 检视运行单元，
 *   实验 harness 适配既有单元运行路径，测试用 fake 运行器（决策 12）。
 */

/** 单次运行对编排层可见的最小产出面 */
export interface SingleMrRun {
  /** 该次运行的最终 findings（已过 Evidence Gate） */
  readonly findings: readonly Finding[];
  /** 该次运行的 usage（LlmUsage 口径） */
  readonly usage: LlmUsage;
  /** 该次运行的审计关联键（每片独立留痕，被合并结果引用） */
  readonly runId: string;
  /** 审计落盘路径（运行器落盘时在场） */
  readonly auditPath?: string;
}

/** 单 MR 运行器注入接口（决策 12）：执行一次标准域内运行 */
export interface SingleMrRunner<TRun extends SingleMrRun = SingleMrRun> {
  run(mrCase: MRCase): Promise<TRun>;
}

/** 编排配置：切分器与合并层参数统一入口 */
export interface OrchestrationConfig {
  /** 切分器配置（边界阈值 + 分片数上限） */
  readonly shard: ShardConfig;
  /** 合并层配置（锚点键行号窗口，起步值 3） */
  readonly merge: MergeConfig;
}

export const DEFAULT_ORCHESTRATION_CONFIG: Readonly<OrchestrationConfig> = Object.freeze({
  shard: DEFAULT_SHARD_CONFIG,
  merge: DEFAULT_MERGE_CONFIG,
});

/** shards 节的单片条目：分片元数据 + 该片运行审计关联 */
export interface ShardEntry {
  readonly shardId: string;
  readonly files: number;
  readonly diffLines: number;
  readonly outOfDomain: boolean;
  readonly runId: string;
  readonly auditPath?: string;
}

/** 结果 shards 节（决策 11；仅切分发生时出现） */
export interface ShardsSection {
  /** 首个超界维度 */
  readonly reason: ShardReason;
  /** 本次生效的验证域边界 */
  readonly boundary: MrBoundary;
  readonly count: number;
  readonly entries: readonly ShardEntry[];
}

/** 编排产出：单份检视结果 + 运行引用（+ 切分时的 shards 节） */
export interface OrchestratedReview<TRun extends SingleMrRun = SingleMrRun> {
  /** 域内直通 = false（未切分） */
  readonly sharded: boolean;
  /** 单份检视结果：直通 = 单次运行 findings 原样透传；切分 = 合并层产出（携带 shardIds） */
  readonly findings: readonly Finding[];
  /** usage / token：直通 = 单次运行原样；切分 = 各片之和 */
  readonly usage: LlmUsage;
  /** 各次运行产出（直通 = 1 条；切分 = 每片一条，按执行序） */
  readonly runs: readonly TRun[];
  /** 分片元数据节；仅切分发生时出现 */
  readonly shards?: ShardsSection;
}

export async function orchestrateReview<TRun extends SingleMrRun>(
  mrCase: MRCase,
  runner: SingleMrRunner<TRun>,
  config: OrchestrationConfig = DEFAULT_ORCHESTRATION_CONFIG,
): Promise<Result<OrchestratedReview<TRun>>> {
  // 合并配置先行校验（切分器配置由 planShards 自校验）：非法配置零运行成本拒绝
  const mergeConfigError = validateMergeConfig(config.merge);
  if (mergeConfigError !== undefined) {
    return err(mergeConfigError);
  }
  const plan = planShards(mrCase, config.shard);
  if (!plan.ok) {
    return err(plan.error);
  }
  if (!plan.value.sharded) {
    // 域内直通（决策 11）：单次直接运行原 MRCase，结果不携带任何新字段
    const run = await runner.run(mrCase);
    return ok({
      sharded: false,
      findings: run.findings,
      usage: run.usage,
      runs: [run],
    });
  }
  const shardPlan = plan.value;
  // 分片串行下发（决策 10）：顺序 await 保证执行序无交错
  const runs: TRun[] = [];
  for (const shard of shardPlan.shards) {
    runs.push(await runner.run(shard.mrCase));
  }
  // 片 × 运行对位（执行序 = 片序），合并输入与 entries 共用
  const shardRuns = shardPlan.shards.map((shard, index) => ({ shard, run: runs[index]! }));
  const merged = mergeShardFindings(
    shardRuns.map(({ shard, run }) => ({ shardId: shard.shardId, findings: run.findings })),
    config.merge,
  );
  if (!merged.ok) {
    return err(merged.error);
  }
  return ok({
    sharded: true,
    findings: merged.value.findings,
    // 冻结 addUsage 直用（reduce + ZERO_USAGE）：聚合语义与内核事件流同源
    usage: runs.reduce((sum, run) => addUsage(sum, run.usage), ZERO_USAGE),
    runs,
    shards: {
      // sharded = true 时 reason 必非空（直通分支已提前返回）
      reason: shardPlan.reason!,
      boundary: shardPlan.boundary,
      count: shardPlan.shards.length,
      entries: shardRuns.map(({ shard, run }) => ({
        shardId: shard.shardId,
        files: shard.files,
        diffLines: shard.diffLines,
        outOfDomain: shard.outOfDomain,
        runId: run.runId,
        ...(run.auditPath !== undefined ? { auditPath: run.auditPath } : {}),
      })),
    },
  });
}
