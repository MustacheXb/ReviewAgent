/**
 * review-context：核内上下文插件——MR 输入 → 对话消息 + 工具挂载 + 预取注入材料
 * （Zone C 起点 / Zone B 挂载点）。
 *
 * MR intro 模板 1:1 移植自冻结 harness src/loop/messages.ts buildInitialUserMessage：
 * caseId、issue 描述、unified diff；repoPath 不进 intro 字节（Zone A/B 稳定前缀纪律），
 * 只作工具与预取的数据源。Zone B（config B 确定性上下文注入）经 buildPrefetch
 * 供给注入材料，运行时把它编排到 system 之后、MR intro 之前（POC1 请求 1 布局）。
 *
 * #20 工具接线：buildToolkit 把 MR 输入交给冻结 harness 的 buildReviewToolkit
 * （7 个 review.* 工具 + codeintel/zoneb 复用 + run 私有 Context Ledger），
 * DSH 注册面形状转换见 context/review-tools.ts；本插件同时向 SystemPrompt 声明
 * 7 个工具名的 knownNames（schema 缺席但名字已知——config A 零注册下
 * toolOrder 配置仍可通过校验，见 profile/assemble.ts）。
 */

import type { Context, Plugin } from "@deepseek-ai/cordis";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

import { REVIEW_TOOL_ORDER } from "../../../../src/tools/registry.js";
import { buildReviewToolkit, type ReviewToolkit } from "../../../../src/tools/toolkit.js";
import { buildPrefetchInjection, type PrefetchInjection } from "../context/prefetch-context.js";

/** MR 输入（Zone C 起点的全部材料） */
export interface MrInput {
  readonly caseId: string;
  readonly issueDescription: string;
  readonly diff: string;
  /** 仓库根（工具挂载数据源；config A 零工具时合法缺席） */
  readonly repoPath?: string;
}

/** MR intro 用户消息模板（逐字节稳定；issue 描述为空时落 "(none)"） */
export function buildMrIntroText(input: MrInput): string {
  const issueDescription = input.issueDescription.trim().length > 0 ? input.issueDescription : "(none)";
  return [
    "Merge request under review.",
    "",
    `Case ID: ${input.caseId}`,
    "Issue description:",
    issueDescription,
    "",
    "Unified diff:",
    "```diff",
    input.diff,
    "```",
  ].join("\n");
}

/** reviewContext 服务：检视会话的上下文装配 */
export interface ReviewContextService {
  /** Zone C 起点：MR intro 用户消息（DSH UserMessage 形态，source=user） */
  buildMrIntro(input: MrInput): UserMessage;
  /**
   * 工具挂载（toolsEnabled 政策）：MR 输入 → POC1 工具箱（run 私有 Ledger；
   * ledger=true 为功能态 config E 语义，缺省惰性态 A/B/C/D 行为零变化）。
   * repoPath 缺失时 fail fast（工具已启用但无仓库可读是装配错误，不静默）。
   */
  buildToolkit(input: MrInput, options: { readonly ledger: boolean }): ReviewToolkit;
  /**
   * config B 确定性预取（prefetch 政策）：MR 输入 → Zone B 消息 + 三层预取
   * 消息 + 注入层记账（POC1 buildPrefetchContext 1:1；同仓库同 diff 字节级
   * 相同）。注入位次由运行时编排（Zone B 在 MR intro 前、三层在其后）。
   * repoPath 缺失时 fail fast。
   */
  buildPrefetch(input: MrInput): Promise<PrefetchInjection>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    reviewContext: ReviewContextService;
  }
}

/** review-context 插件胚胎：MR intro 装配服务 + 工具挂载 + knownNames 声明 */
export const reviewContext: Plugin.Object = {
  name: "review-context",
  inject: ["systemPrompt"],
  apply(ctx: Context) {
    // 固定 7 工具名单：schema 由 ToolRuntime 按注册面提供（toolsEnabled 时 7 个、
    // 否则零个），knownNames 恒定声明——toolOrder 配置在零注册配置下不 fail
    const offKnownNames = ctx.systemPrompt.tools(() => ({ schemas: [], knownNames: [...REVIEW_TOOL_ORDER] }));

    const service: ReviewContextService = {
      buildMrIntro: (input) =>
        createUserMessage({
          content: [{ type: "text", text: buildMrIntroText(input) }],
          source: { kind: "user" },
        }),
      buildToolkit: (input, options) => {
        if (input.repoPath === undefined || input.repoPath.trim().length === 0) {
          throw new Error(
            "review-context: buildToolkit requires MrInput.repoPath (tools are enabled but no repository path was provided)",
          );
        }
        return buildReviewToolkit({
          repoPath: input.repoPath,
          diff: input.diff,
          ...(options.ledger ? { ledger: true } : {}),
        });
      },
      buildPrefetch: (input) => buildPrefetchInjection(input),
    };
    const disposeService = ctx.provide("reviewContext", service);
    return () => {
      disposeService();
      offKnownNames();
    };
  },
};
