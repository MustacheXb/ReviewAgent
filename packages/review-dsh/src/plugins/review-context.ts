/**
 * review-context：核内上下文插件——MR 输入 → 对话消息（Zone C 起点 / Zone B 挂载点）。
 *
 * MR intro 模板 1:1 移植自冻结 harness src/loop/messages.ts buildInitialUserMessage：
 * caseId、issue 描述、unified diff；Zone B（config B 确定性上下文注入）在本插件
 * 后续形态中挂到 system 之后、MR intro 之前。
 */

import type { Context, Plugin } from "@deepseek-ai/cordis";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

/** MR 输入（Zone C 起点的全部材料） */
export interface MrInput {
  readonly caseId: string;
  readonly issueDescription: string;
  readonly diff: string;
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
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    reviewContext: ReviewContextService;
  }
}

/** review-context 插件胚胎：MR intro 装配服务 */
export const reviewContext: Plugin.Object = {
  name: "review-context",
  apply(ctx: Context) {
    const service: ReviewContextService = {
      buildMrIntro: (input) =>
        createUserMessage({
          content: [{ type: "text", text: buildMrIntroText(input) }],
          source: { kind: "user" },
        }),
    };
    return ctx.provide("reviewContext", service);
  },
};
