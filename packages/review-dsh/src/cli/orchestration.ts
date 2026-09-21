/**
 * 生产 CLI 切分编排缝（spec #48 实现决策 2、10–13，ticket #56）：
 * CLI 输入 → MRCase 构造 → 交 dshSingleMrRunner（#61 第一步起为共享实现，
 * 见 run-unit/single-mr-runner.ts——kernel-host 与本缝消重复，单一来源）。
 *
 * 生产与实验 harness 走同一编排函数（决策 12 / 用户故事 18）：review 命令统一
 * 经 orchestrateReview 下发——域内 MR 直通（呈现与审计写盘与 #26 原路径逐字节
 * 一致），超界 MR 分片串行执行后合并为单份结果。本模块只做 CLI 适配：
 * cliMrCase——CLI 四字段（caseId / repoPath / diff / issue）直传；truth 恒
 * null、labels 为中性载体——生产路径无数据集语义，切分器与运行单元均不消费
 * 这两个字段（labels 仅因 MRCase 契约必填而在场，随分片派生原样透传）。
 */

import type { MRCase } from "../../../../src/contracts/mr-case.js";
import type { ReviewCliArgs } from "./args.js";

/** CLI 输入 → MRCase（生产路径无数据集语义：truth 恒 null、labels 为中性载体） */
export function cliMrCase(args: ReviewCliArgs, repoPath: string, diff: string): MRCase {
  return {
    caseId: args.caseId,
    repoPath,
    diff,
    issueDescription: args.issue,
    truth: null,
    labels: { source: "production", riskClass: "Medium", allowedConfigs: [args.config] },
  };
}
