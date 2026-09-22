/**
 * #61 第一步：单 MR 检视运行单元的共享实现——CLI 与 kernel-host 消重复。
 *
 * 两处原实现（cli/orchestration.ts 的 dshSingleMrRunner 与 kernel-host/main.ts
 * 的 handleReviewRun 本体）语义同源，收敛为单一来源（AC6）：
 * - profile-per-run：每片（含直通单片）全新 Context + assembleReviewProfile +
 *   适配器实例（reviewCache / 工具预算 / Ledger / wire 字节捕获均挂 ctx 与
 *   适配器实例，跨片复用即跨片污染审计）；
 * - 运行后独立落盘审计（runId 命名文件）；
 * - finally 树拆卸（半挂树同样拆——失败片不污染下一片的内核状态）。
 *
 * 运行输入 = MrInput（repoPath 可选：host 侧契约保留缺席语义，config A 零工具
 * 时合法缺席；MRCase 结构满足 MrInput，编排层分片 mrCase 直传）。组装输入的
 * model / language 可缺席 = policy 不带该字段（内核回落 DEFAULT_MODEL / en——
 * host 侧现状语义；CLI 恒携带解析层缺省值，行为等价）。
 */

import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";

import type { ConfigId } from "../../../../src/contracts/config.js";
import type { OutputLanguage } from "../../../../src/contracts/output-language.js";
import type { SingleMrRunner, SingleMrRun } from "../../../../src/sharding/orchestrate-review.js";
import { writeAuditFile } from "../../../../src/audit/audit-writer.js";
import { toAuditFileContent, type DshAuditFileContent } from "../audit/audit-export.js";
import { DeepSeekLlmAdapter } from "../llm/deepseek-adapter.js";
import type { MrInput } from "../plugins/review-context.js";
import type { ReviewRunResult } from "../plugins/review-runtime.js";
import { assembleReviewProfile, realApiReviewPolicy } from "../profile/assemble.js";

/** 运行单元的组装输入（CLI 旗标 / host 请求参数原样下传：config / model / language / 输出根目录） */
export interface SingleMrRunnerInputs {
  readonly config: ConfigId;
  /** 被测模型（#45）：缺席 = policy 不带 model（内核回落 DEFAULT_MODEL）；CLI 恒携带解析层缺省 */
  readonly model?: string;
  /** 输出语言（#58）：缺席 = policy 不带 outputLanguage（内核缺省 en）；CLI 恒携带 */
  readonly language?: OutputLanguage;
  /** 输出根目录：sessions/（会话 jsonl）与 audit/（审计文件）在其下按片创建 */
  readonly outDir: string;
}

/** 生产运行单元产出：SingleMrRun 最小面 + DSH 结果与导出审计（呈现单一来源） */
export interface ProductionMrRun extends SingleMrRun {
  /** 审计落盘路径（本 runner 恒落盘——窄化根库可选契约为必填，呈现面直接消费） */
  readonly auditPath: string;
  /** DSH 运行结果本体 */
  readonly result: ReviewRunResult;
  /** 导出审计文件内容（冻结件 toAuditFileContent 组装） */
  readonly content: DshAuditFileContent;
  /** cmdline 行请求的退出码（wrapper 不注入 cmdline 时恒 null；保真透传） */
  readonly requestedExitCode: number | null;
}

/**
 * DSH 单 MR 检视运行单元（#56 决策 12 生产侧 / #61 kernel-host 共享）：
 * profile-per-run + 每次独立审计落盘。run 输入为 MrInput（repoPath 可选），
 * 满足根库 SingleMrRunner 注入面（MRCase 结构兼容 MrInput）。
 */
export function dshSingleMrRunner(
  inputs: SingleMrRunnerInputs,
): SingleMrRunner<ProductionMrRun> & { run(input: MrInput): Promise<ProductionMrRun> } {
  return {
    run: async (input: MrInput): Promise<ProductionMrRun> => {
      const sessionParent = join(inputs.outDir, "sessions");
      await mkdir(sessionParent, { recursive: true });
      const sessionRoot = await mkdtemp(join(sessionParent, "run-"));
      const ctx = new Context();
      try {
        const handle = await assembleReviewProfile(ctx, {
          sessionRoot,
          adapter: new DeepSeekLlmAdapter(),
          policy: realApiReviewPolicy(inputs.config, inputs.model, inputs.language),
        });
        const result = await ctx.reviewRuntime.run({
          caseId: input.caseId,
          issueDescription: input.issueDescription,
          diff: input.diff,
          // repoPath falsy 归一回缺席（host 侧 MRCase 必填 string → 空串占位；
          // 缺席语义保留——config A 零工具时合法，与 #27 既有行为一致）
          ...(input.repoPath ? { repoPath: input.repoPath } : {}),
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
