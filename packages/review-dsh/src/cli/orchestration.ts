/**
 * 生产 CLI 切分编排缝（spec #48 实现决策 2、10–13，ticket #56）：
 * CLI 输入 → MRCase 构造 + DSH 检视运行单元 → SingleMrRun 适配器。
 *
 * 生产与实验 harness 走同一编排函数（决策 12 / 用户故事 18）：review 命令统一
 * 经 orchestrateReview 下发——域内 MR 直通（呈现与审计写盘与 #26 原路径逐字节
 * 一致），超界 MR 分片串行执行后合并为单份结果。本模块只做两件适配：
 * - cliMrCase：CLI 四字段（caseId / repoPath / diff / issue）直传；truth 恒
 *   null、labels 为中性载体——生产路径无数据集语义，切分器与运行单元均不消费
 *   这两个字段（labels 仅因 MRCase 契约必填而在场，随分片派生原样透传）。
 * - dshSingleMrRunner：DSH 检视运行单元的编排适配——每片（含直通单片）全新
 *   Context + assembleReviewProfile + 适配器实例（profile-per-run，kernel-host
 *   单元隔离同款：reviewCache / 工具预算 / Ledger / wire 字节捕获均挂 ctx 与
 *   适配器实例，跨片复用即跨片污染审计），运行后独立落盘审计（runId 命名
 *   文件）并拆卸树（失败片不污染下一片的内核状态）。
 */

import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";

import { writeAuditFile } from "../../../../src/audit/audit-writer.js";
import type { ConfigId } from "../../../../src/contracts/config.js";
import type { MRCase } from "../../../../src/contracts/mr-case.js";
import type { SingleMrRun, SingleMrRunner } from "../../../../src/sharding/orchestrate-review.js";
import { toAuditFileContent, type DshAuditFileContent } from "../audit/audit-export.js";
import { DeepSeekLlmAdapter } from "../llm/deepseek-adapter.js";
import { assembleReviewProfile, realApiReviewPolicy } from "../profile/assemble.js";
import type { ReviewRunResult } from "../plugins/review-runtime.js";
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

/** 运行单元的组装输入（CLI 旗标原样下传：config / model / 输出根目录） */
export interface ProductionRunnerInputs {
  readonly config: ConfigId;
  readonly model: string;
  /** 输出根目录：sessions/（会话 jsonl）与 audit/（审计文件）在其下按片创建 */
  readonly outDir: string;
}

/** 生产运行单元产出：SingleMrRun 最小面 + DSH 结果与导出审计（呈现单一来源） */
export interface ProductionMrRun extends SingleMrRun {
  /** DSH 运行结果本体 */
  readonly result: ReviewRunResult;
  /** 导出审计文件内容（冻结件 toAuditFileContent 组装） */
  readonly content: DshAuditFileContent;
  /** 审计落盘路径（每片独立文件，runId 命名——合并结果经 shards 节关联） */
  readonly auditPath: string;
  /** cmdline 行请求的退出码（本 wrapper 不注入 cmdline，恒 null；保真透传） */
  readonly requestedExitCode: number | null;
}

/** DSH 检视运行单元 → 单 MR 运行器适配（决策 12 生产侧）：profile-per-run + 每片独立审计 */
export function dshSingleMrRunner(inputs: ProductionRunnerInputs): SingleMrRunner<ProductionMrRun> {
  return {
    run: async (mrCase) => {
      const sessionParent = join(inputs.outDir, "sessions");
      await mkdir(sessionParent, { recursive: true });
      const sessionRoot = await mkdtemp(join(sessionParent, "run-"));
      const ctx = new Context();
      try {
        const handle = await assembleReviewProfile(ctx, {
          sessionRoot,
          adapter: new DeepSeekLlmAdapter(),
          policy: realApiReviewPolicy(inputs.config, inputs.model),
        });
        const result = await ctx.reviewRuntime.run({
          caseId: mrCase.caseId,
          issueDescription: mrCase.issueDescription,
          diff: mrCase.diff,
          repoPath: mrCase.repoPath,
        });
        const content = toAuditFileContent(result);
        const auditPath = await writeAuditFile(join(inputs.outDir, "audit"), content);
        return {
          findings: result.findings,
          usage: result.audit.usage,
          runId: result.audit.runId,
          auditPath,
          result,
          content,
          requestedExitCode: handle.requestedExitCode(),
        };
      } finally {
        // 每片树拆卸（半挂树同样拆——失败片不污染下一片的内核状态）
        await ctx.fiber.dispose();
      }
    },
  };
}
