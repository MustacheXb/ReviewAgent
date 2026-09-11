/**
 * POC1 预取管线 → DSH 注入材料适配器（config B 形态，#22）。
 *
 * 冻结 harness 的 buildPrefetchContext 零改写复用（同 #20 工具箱姿态）：
 * 同一仓库 + 同一 diff → 字节级相同的 Zone B 消息与 Symbol / Reference /
 * Call Chain 三层消息。预算恒取 POC1 缺省（16k / 8k / 6k / 6k 字符）——
 * 截断机制由 POC1 自有测试锁定，内核不暴露覆盖面。
 *
 * 注入位次（POC1 messages.ts 落锤布局，运行时负责编排）：
 * Zone B 在 system（Zone A）之后、MR intro 之前；三层在 MR intro 之后。
 */

import { resolvePrefetchBudgets } from "../../../../src/contracts/prefetch.js";
import type { PrefetchContext } from "../../../../src/zoneb/prefetch.js";
import { buildPrefetchContext } from "../../../../src/zoneb/prefetch.js";
import type { MrInput } from "../plugins/review-context.js";

/**
 * config B 注入材料（冻结 PrefetchContext 的 DSH 侧别名）：字段形态单一来源，
 * 不逐字段重声明——Zone B 消息、三层消息（Symbol → Reference → Call Chain）
 * 与注入层记账（records → audit.prefetch 数据源）的契约由 POC1 持有。
 */
export type PrefetchInjection = PrefetchContext;

/** MR 输入 → config B 注入材料（repoPath 缺失 fail fast：预取启用但无仓库可读） */
export async function buildPrefetchInjection(input: MrInput): Promise<PrefetchInjection> {
  if (input.repoPath === undefined || input.repoPath.trim().length === 0) {
    throw new Error(
      "review-prefetch: buildPrefetchInjection requires MrInput.repoPath (prefetch is enabled but no repository path was provided)",
    );
  }
  return buildPrefetchContext({
    repoPath: input.repoPath,
    diff: input.diff,
    budgets: resolvePrefetchBudgets(undefined),
  });
}
