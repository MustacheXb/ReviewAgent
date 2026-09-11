/**
 * POC1 全仓注入管线 → DSH 注入材料适配器（config C 形态，#25）。
 *
 * 冻结 harness 的 buildFullRepoInjection 零改写复用（同 #20 工具箱 / #22 预取
 * 姿态）：同一仓库快照 → 字节级相同的全仓消息与 FullRepoRecord 记账。预算恒取
 * POC1 缺省（80k 字符）——截断机制由 POC1 自有测试锁定，内核不暴露覆盖面。
 *
 * RepoContext 双重复用（POC1 run-review.ts 同构）：全仓注入与工具箱共享同一
 * 仓库快照（一次加载，get_file 读到的与注入字节同源）——repo 字段经 toolkit
 * options 传回 buildReviewToolkit。
 */

import type { RepoContext } from "../../../../src/zoneb/repo-context.js";
import { loadRepoContext } from "../../../../src/zoneb/repo-context.js";
import { DEFAULT_FULL_REPO_BUDGET_CHARS } from "../../../../src/zoneb/full-repo-injection.js";
import { buildFullRepoInjection } from "../../../../src/zoneb/full-repo-injection.js";
import type { FullRepoRecord } from "../../../../src/contracts/run.js";
import type { LlmMessage } from "../../../../src/contracts/llm-client.js";
import type { MrInput } from "../plugins/review-context.js";

/** config C 注入材料：全仓消息 + 记账 + 共享仓库快照（toolkit 数据源） */
export interface FullRepoAssembly {
  readonly message: LlmMessage;
  readonly record: FullRepoRecord;
  readonly repo: RepoContext;
}

/** MR 输入 → config C 注入材料（repoPath 缺失 fail fast：全仓注入启用但无仓库可读） */
export async function buildFullRepoAssembly(input: MrInput): Promise<FullRepoAssembly> {
  if (input.repoPath === undefined || input.repoPath.trim().length === 0) {
    throw new Error(
      "review-full-repo: buildFullRepoAssembly requires MrInput.repoPath (fullRepo is enabled but no repository path was provided)",
    );
  }
  const repo = await loadRepoContext(input.repoPath);
  const injection = await buildFullRepoInjection({ repo, budgetChars: DEFAULT_FULL_REPO_BUDGET_CHARS });
  return { message: injection.message, record: injection.record, repo };
}
