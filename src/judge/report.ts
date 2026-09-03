/**
 * 判定链批量报告（Ticket 11）：对一组 EvaluationInput 跑 规则粗筛 → judge 复核，
 * 产出双口径（规则 / judge）聚合统计。
 *
 * 指标回填路径：JudgeRunResult → flattenJudgeRun(result, mode) → FlatMetrics
 * （T10 的扁平投影形状）→ summarizeFlatMetrics（T10 纯函数）——即 judge 裁定结果
 * 经 T10 纯函数重算，走同一套 Metrics 计算管线。
 *
 * 口径说明：judge 匹配为单一语义层级（LLM-Hit-Judge 协议无 line/file 之分），
 * 扁平投影的 file* 字段镜像 line 计数以保持 FlatMetrics 形状兼容；
 * 双口径质量指标不分冷热（rep1/rep2+ 的质量口径一致，分层缓存协议只影响 token 口径，
 * 见 T10 aggregate.ts 头注）；token / 工具 / 轮次字段与规则口径同源（同一次 Run）。
 */

import type { ConfigId } from "../contracts/config.js";
import { CONFIGS } from "../contracts/config.js";
import type { EvaluationInput, FlatMetrics, MetricsStats } from "../metrics/types.js";
import { summarizeFlatMetrics } from "../metrics/index.js";
import type { JudgeClient } from "./contracts.js";
import { judgeRun } from "./orchestrate.js";
import type { JudgeChainOptions, JudgeRunResult } from "./orchestrate.js";

/** 一个 MR × 一个 config 的判定链结果（reps 顺序 = 重复运行顺序，rep1 在前） */
export interface JudgeConfigCaseReport {
  readonly configId: ConfigId;
  readonly reps: readonly JudgeRunResult[];
}

/** 一个 MR 的判定链报告 */
export interface JudgeCaseReport {
  readonly caseId: string;
  readonly perConfig: Readonly<Partial<Record<ConfigId, JudgeConfigCaseReport>>>;
}

/** 跨 case 的 config 级双口径汇总（全部重复运行合并；质量口径不分冷热） */
export interface JudgeConfigSummary {
  readonly configId: ConfigId;
  readonly runCount: number;
  /** 规则口径统计 */
  readonly rule: MetricsStats;
  /** judge 口径统计 */
  readonly judge: MetricsStats;
}

export interface JudgeChainReport {
  readonly caseCount: number;
  readonly perCase: readonly JudgeCaseReport[];
  readonly perConfig: Readonly<Partial<Record<ConfigId, JudgeConfigSummary>>>;
  /** 全部运行结果平铺（含 repIndex），供 10% 人工抽检构建抽样单元 */
  readonly runs: readonly JudgeRunResult[];
}

/** 批量入口：evaluations（T10 EvaluationInput 形状）→ 双口径判定链报告 */
export async function judgeEvaluations(
  evaluations: readonly EvaluationInput[],
  judgeClient: JudgeClient,
  options: JudgeChainOptions = {},
): Promise<JudgeChainReport> {
  if (!Array.isArray(evaluations) || evaluations.length === 0) {
    throw new Error("evaluations must be a non-empty array of EvaluationInput");
  }
  const configIds = Object.keys(CONFIGS) as ConfigId[];
  const runs: JudgeRunResult[] = [];
  const perCase: JudgeCaseReport[] = [];
  for (const evaluation of evaluations) {
    const perConfig: Partial<Record<ConfigId, JudgeConfigCaseReport>> = {};
    for (const configId of configIds) {
      const configRuns = evaluation.runsByConfig[configId];
      if (configRuns === undefined || configRuns.length === 0) {
        continue;
      }
      const reps: JudgeRunResult[] = [];
      for (const [repIndex, run] of configRuns.entries()) {
        // 顺序执行（与官方脚本一致：确定性顺序、天然限速）
        const result = await judgeRun(run, evaluation.mrCase, judgeClient, options);
        reps.push({ ...result, repIndex });
      }
      perConfig[configId] = { configId, reps };
      runs.push(...reps);
    }
    perCase.push({ caseId: evaluation.mrCase.caseId, perConfig });
  }
  return {
    caseCount: perCase.length,
    perCase,
    perConfig: summarizePerConfig(perCase),
    runs,
  };
}

/** 单次 Run 双口径扁平投影（T10 FlatMetrics 形状；file* 镜像 line 计数） */
export function flattenJudgeRun(result: JudgeRunResult, mode: "rule" | "judge"): FlatMetrics {
  const counts = mode === "rule" ? result.ruleCounts : result.judgeCounts;
  const prf = mode === "rule" ? result.rulePrf : result.judgePrf;
  const efficiency = mode === "rule" ? result.ruleEfficiency : result.judgeEfficiency;
  return {
    lineTp: counts.tp,
    lineFp: counts.fp,
    lineFn: counts.fn,
    lineRecall: prf.recall,
    linePrecision: prf.precision,
    lineF1: prf.f1,
    fileTp: counts.tp,
    fileFp: counts.fp,
    fileFn: counts.fn,
    fileRecall: prf.recall,
    filePrecision: prf.precision,
    fileF1: prf.f1,
    uncachedInputTokens: result.tokens.uncachedInputTokens,
    cachedInputTokens: result.tokens.cachedInputTokens,
    cacheWriteTokens: result.tokens.cacheWriteTokens,
    outputTokens: result.tokens.outputTokens,
    totalInputTokens: result.tokens.totalInputTokens,
    totalTokens: result.tokens.totalTokens,
    cacheHitRate: result.tokens.cacheHitRate,
    rie: efficiency.rie,
    carc: efficiency.carc,
    toolCostTokens: result.toolCostTokens,
    toolCalls: result.toolCalls,
    rounds: result.rounds,
  };
}

function summarizePerConfig(
  perCase: readonly JudgeCaseReport[],
): Readonly<Partial<Record<ConfigId, JudgeConfigSummary>>> {
  const configIds = Object.keys(CONFIGS) as ConfigId[];
  const perConfig: Partial<Record<ConfigId, JudgeConfigSummary>> = {};
  for (const configId of configIds) {
    const reps = perCase.flatMap((caseReport) => caseReport.perConfig[configId]?.reps ?? []);
    if (reps.length === 0) {
      continue;
    }
    perConfig[configId] = {
      configId,
      runCount: reps.length,
      rule: summarizeFlatMetrics(reps.map((rep) => flattenJudgeRun(rep, "rule"))),
      judge: summarizeFlatMetrics(reps.map((rep) => flattenJudgeRun(rep, "judge"))),
    };
  }
  return perConfig;
}
