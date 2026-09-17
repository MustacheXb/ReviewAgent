/**
 * #26/#56 CLI 结果呈现（进程内主缝）：stdout 形状契约。
 *
 * 整个 stdout = 单个 JSON 文档（机器可读、烟测锁形状）：ok 标志 + 运行标识 +
 * 计数摘要 + 结构化 Finding 集 + 审计文件路径。错误走 stderr，stdout 保持干净。
 *
 * 两个呈现面（#56 切分内建）：
 * - 域内 MR（renderReviewOutcome）：与 #26 原形状逐字节一致，零改动；
 * - 超界 MR 切分合并（renderShardedReviewOutcome）：跨片求和摘要（rounds /
 *   toolCalls / usage = 各片之和——决策 13 计量口径在呈现面落地，truncated
 *   任一片截断即 true）+ shards 节（每片 runId / auditPath 可关联独立审计）+
 *   合并 findings（携带 shardIds 溯源）。顶层不带单 runId / auditPath——超界
 *   检视由多次运行组成，关联键在各片条目。
 */

import type { AuditFileContent } from "../../../../src/audit/audit-writer.js";
import type { MergedFinding } from "../../../../src/sharding/merge-findings.js";
import type { ShardsSection } from "../../../../src/sharding/orchestrate-review.js";

/** ok 包络 + 两空格缩进 JSON 整写（两个呈现面的共同形状，单一来源） */
function renderOutcomeJson(outcome: object): string {
  return `${JSON.stringify({ ok: true, ...outcome }, null, 2)}\n`;
}

/**
 * 一次检视的呈现面：导出审计的顶层摘要经 Pick 锚定（审计字段漂移即编译错，
 * 不靠手抄对齐）+ 审计文件路径。
 */
export type ReviewOutcome = Pick<
  AuditFileContent,
  "caseId" | "configId" | "runId" | "truncated" | "rounds" | "toolCalls" | "findings"
> & { readonly auditPath: string };

export function renderReviewOutcome(outcome: ReviewOutcome): string {
  return renderOutcomeJson(outcome);
}

/**
 * 超界 MR（切分合并）的呈现面：与域内呈现共面的字段经 Pick 同源锚定（审计
 * 字段漂移即编译错），其中跨片求和语义（usage / rounds / toolCalls 之和、
 * truncated 任一片）由编排层算好后传入；caseId 为原 MR id（各片审计的
 * caseId 是派生分片 id），findings / shards 为超界增量。
 */
export interface ShardedReviewOutcome
  extends Pick<AuditFileContent, "configId" | "truncated" | "rounds" | "toolCalls" | "usage"> {
  /** 原 MR 的 caseId（非任一分片的派生 id） */
  readonly caseId: string;
  /** 合并层产出（同锚点键去重、首见保留；每条携带 shardIds 溯源——决策 11） */
  readonly findings: readonly MergedFinding[];
  /** 分片元数据节（reason / boundary / count / entries：每片 runId + auditPath） */
  readonly shards: ShardsSection;
}

export function renderShardedReviewOutcome(outcome: ShardedReviewOutcome): string {
  return renderOutcomeJson(outcome);
}
