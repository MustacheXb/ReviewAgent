import type { ToolExecutor } from "../loop/tools.js";
import type { ToolSchema } from "../contracts/llm-client.js";
import type { RepoContext } from "../zoneb/repo-context.js";
import { loadRepoContext } from "../zoneb/repo-context.js";
import { GET_DIFF_TOOL } from "./get-diff.js";
import { GET_FILE_TOOL } from "./get-file.js";
import { GET_SYMBOL_TOOL } from "./get-symbol.js";
import { DEFAULT_TOOL_RESULT_BUDGET_CHARS } from "./result-budget.js";
import {
  assembleReviewTools,
  createToolExecutor,
  toToolSchema,
  type RegisteredReviewTool,
  type ToolRunContext,
} from "./registry.js";

/**
 * review.* 工具箱装配（runReview 的自动挂载点，工单 #6）。
 *
 * - toolsEnabled 的配置在调用方未显式覆盖 tools/toolExecutor 时自动挂载本工具箱；
 * - RepoContext 懒加载 memoize：模型不调用工具的 run 不产生仓库读取成本；
 *   首次调用失败（仓库缺失等）成为有界的工具错误（进审计 toolCallLog），不静默；
 * - config C 的全仓注入已加载 RepoContext 时经 options.repo 共享（一次加载，两处复用）。
 *
 * T06 扩展：新增 buildReviewSearchTools() 产出 find_references / get_call_chain /
 * search_rule / search_history 四个定义，并入 buildReviewReadTools 的装配数组——
 * 注册表按 REVIEW_TOOL_ORDER 自动排序与查重，schema 序列化自动保持字节稳定。
 */

/** 工具装配点（当前 = T05 读取三件套；T06 在此并入检索四件套，顺序由注册表保证） */
export function buildReviewReadTools(): readonly RegisteredReviewTool[] {
  return assembleReviewTools([GET_DIFF_TOOL, GET_SYMBOL_TOOL, GET_FILE_TOOL]);
}

export interface ReviewToolkitOptions {
  readonly repoPath: string;
  readonly diff: string;
  /** 单次工具结果字符预算，默认 DEFAULT_TOOL_RESULT_BUDGET_CHARS */
  readonly resultBudgetChars?: number;
  /** 预加载的 RepoContext（config C 全仓注入共享；缺省懒加载） */
  readonly repo?: RepoContext;
}

export interface ReviewToolkit {
  /** 挂载到 LlmRequest.tools 的 schema（字节稳定，Zone A 的一部分） */
  readonly tools: readonly ToolSchema[];
  readonly executor: ToolExecutor;
}

export function buildReviewToolkit(options: ReviewToolkitOptions): ReviewToolkit {
  const definitions = buildReviewReadTools();
  const repoPromise = memoizedRepo(options);
  const context: ToolRunContext = {
    diff: options.diff,
    repo: () => repoPromise(),
    resultBudgetChars: options.resultBudgetChars ?? DEFAULT_TOOL_RESULT_BUDGET_CHARS,
  };
  return {
    tools: definitions.map(toToolSchema),
    executor: createToolExecutor(definitions, context),
  };
}

/** RepoContext 懒加载（memoize：同一 toolkit 内只加载一次，失败可重读同一错误） */
function memoizedRepo(options: ReviewToolkitOptions): () => Promise<RepoContext> {
  let cached: Promise<RepoContext> | undefined;
  return (): Promise<RepoContext> => {
    if (options.repo !== undefined) {
      return Promise.resolve(options.repo);
    }
    cached ??= loadRepoContext(options.repoPath);
    return cached;
  };
}
