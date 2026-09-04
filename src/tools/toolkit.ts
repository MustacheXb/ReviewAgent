import type { ToolExecutor } from "../loop/tools.js";
import type { ToolSchema } from "../contracts/llm-client.js";
import type { KnowledgeCorpus } from "../contracts/knowledge.js";
import type { ContextLedger } from "../contracts/ledger.js";
import type { RepoContext } from "../zoneb/repo-context.js";
import { loadRepoContext } from "../zoneb/repo-context.js";
import { GET_DIFF_TOOL } from "./get-diff.js";
import { GET_FILE_TOOL } from "./get-file.js";
import { GET_SYMBOL_TOOL } from "./get-symbol.js";
import { buildReviewSearchTools } from "./search-tools.js";
import { createContextLedger, createInertContextLedger } from "./ledger.js";
import { DEFAULT_TOOL_RESULT_BUDGET_CHARS } from "./result-budget.js";
import {
  assembleReviewTools,
  createToolExecutor,
  toToolSchema,
  type RegisteredReviewTool,
  type ToolRunContext,
} from "./registry.js";

/**
 * review.* 工具箱装配（runReview 的自动挂载点，工单 #6/#7/#8）。
 *
 * - toolsEnabled 的配置在调用方未显式覆盖 tools/toolExecutor 时自动挂载本工具箱；
 * - RepoContext 懒加载 memoize：模型不调用工具的 run 不产生仓库读取成本；
 *   首次调用失败（仓库缺失等）成为有界的工具错误（进审计 toolCallLog），不静默；
 * - config C 的全仓注入已加载 RepoContext 时经 options.repo 共享（一次加载，两处复用）；
 * - C3 Knowledge 语料（search_rule / search_history 数据源）经 options.knowledge
 *   静态注入，缺省空语料（POC1 无知识源，工单 #7）；
 * - T07 Context Ledger：options.ledger=true 注入功能态（config E，重复读取返回
 *   "Already loaded: ctx#NNN" 引用），缺省注入惰性态（A/B/C/D 行为零变化）；
 *   runReview 经 config.ledger 透传，Ledger 状态属 run 私有。
 */

/** 工具装配点：T05 读取三件套 + T06 检索四件套 = 固定 7 工具（顺序由注册表保证） */
export function buildReviewReadTools(): readonly RegisteredReviewTool[] {
  return assembleReviewTools([
    GET_DIFF_TOOL,
    GET_SYMBOL_TOOL,
    GET_FILE_TOOL,
    ...buildReviewSearchTools(),
  ]);
}

export interface ReviewToolkitOptions {
  readonly repoPath: string;
  readonly diff: string;
  /** 单次工具结果字符预算，默认 DEFAULT_TOOL_RESULT_BUDGET_CHARS */
  readonly resultBudgetChars?: number;
  /** 预加载的 RepoContext（config C 全仓注入共享；缺省懒加载） */
  readonly repo?: RepoContext;
  /** C3 Knowledge 检索语料（search_rule / search_history 数据源；缺省空语料） */
  readonly knowledge?: KnowledgeCorpus;
  /** T07：启用功能态 Context Ledger（config E；缺省 false = 惰性态，工具行为与 T05/T06 一致） */
  readonly ledger?: boolean;
}

export interface ReviewToolkit {
  /** 挂载到 LlmRequest.tools 的 schema（字节稳定，Zone A 的一部分） */
  readonly tools: readonly ToolSchema[];
  readonly executor: ToolExecutor;
  /** T07：本 toolkit 的 Ledger（runReview 审计留痕用；功能态/惰性态由 options.ledger 决定） */
  readonly ledger: ContextLedger;
}

export function buildReviewToolkit(options: ReviewToolkitOptions): ReviewToolkit {
  const definitions = buildReviewReadTools();
  const repoPromise = memoizedRepo(options);
  const ledger = options.ledger === true ? createContextLedger() : createInertContextLedger();
  const context: ToolRunContext = {
    diff: options.diff,
    repo: () => repoPromise(),
    resultBudgetChars: options.resultBudgetChars ?? DEFAULT_TOOL_RESULT_BUDGET_CHARS,
    rules: options.knowledge?.rules ?? [],
    history: options.knowledge?.history ?? [],
    ledger,
  };
  return {
    tools: definitions.map(toToolSchema),
    executor: createToolExecutor(definitions, context),
    ledger,
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
