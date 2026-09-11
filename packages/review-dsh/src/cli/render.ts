/**
 * #26 CLI 结果呈现（进程内主缝）：stdout 形状契约。
 *
 * 整个 stdout = 单个 JSON 文档（机器可读、烟测锁形状）：ok 标志 + 运行标识 +
 * 计数摘要 + 结构化 Finding 集 + 审计文件路径。错误走 stderr，stdout 保持干净。
 */

import type { AuditFileContent } from "../../../../src/audit/audit-writer.js";

/**
 * 一次检视的呈现面：导出审计的顶层摘要经 Pick 锚定（审计字段漂移即编译错，
 * 不靠手抄对齐）+ 审计文件路径。
 */
export type ReviewOutcome = Pick<
  AuditFileContent,
  "caseId" | "configId" | "runId" | "truncated" | "rounds" | "toolCalls" | "findings"
> & { readonly auditPath: string };

export function renderReviewOutcome(outcome: ReviewOutcome): string {
  return `${JSON.stringify({ ok: true, ...outcome }, null, 2)}\n`;
}
