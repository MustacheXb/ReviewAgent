import type { ReviewConfig } from "../contracts/config.js";
import type { KnowledgeCorpus } from "../contracts/knowledge.js";
import type { LedgerEntry } from "../contracts/ledger.js";
import type { LlmClient, ToolSchema } from "../contracts/llm-client.js";
import type { MRCase } from "../contracts/mr-case.js";
import type { PrefetchLayerRecord, PrefetchOptions } from "../contracts/prefetch.js";
import { resolvePrefetchBudgets } from "../contracts/prefetch.js";
import type { FullRepoRecord, RunAudit, RunResult } from "../contracts/run.js";
import { buildAuditFileContent, buildRunId, DEFAULT_AUDIT_DIR, writeAuditFile } from "../audit/audit-writer.js";
import type { ContextMessages } from "../loop/messages.js";
import type { LoopOutcome } from "../loop/review-loop.js";
import { runReviewLoop } from "../loop/review-loop.js";
import type { ToolExecutor } from "../loop/tools.js";
import type { RepoContext } from "../zoneb/repo-context.js";
import { loadRepoContext } from "../zoneb/repo-context.js";
import {
  buildFullRepoInjection,
  DEFAULT_FULL_REPO_BUDGET_CHARS,
  type FullRepoInjection,
} from "../zoneb/full-repo-injection.js";
import { buildPrefetchContext } from "../zoneb/prefetch.js";
import { buildReviewToolkit } from "../tools/toolkit.js";
import { validateRunInputs } from "./validate-inputs.js";

/** 主力模型与 effort 档位（ADR-0002：全实验锁定，禁止档位漂移） */
export const DEFAULT_MODEL = "deepseek-v4-flash";
export const DEFAULT_EFFORT = "default";

export interface RunReviewOptions {
  /** 审计落盘目录；默认 runs/audit */
  readonly auditDir?: string;
  /** 挂载点：显式覆盖工具 schema（缺省时 toolsEnabled 配置自动挂载注册表工具箱） */
  readonly tools?: readonly ToolSchema[];
  /** 挂载点：显式覆盖工具执行器（缺省时 toolsEnabled 配置自动挂载注册表工具箱） */
  readonly toolExecutor?: ToolExecutor;
  /** 工单 #4：config B 预取预算（字符数；缺省用 DEFAULT_PREFETCH_BUDGETS） */
  readonly prefetch?: PrefetchOptions;
  /** 工单 #6：config C 全仓注入预算（字符数；缺省 DEFAULT_FULL_REPO_BUDGET_CHARS） */
  readonly fullRepoBudgetChars?: number;
  /** 工单 #6：单次工具结果字符预算（缺省 DEFAULT_TOOL_RESULT_BUDGET_CHARS） */
  readonly toolResultBudgetChars?: number;
  /** 工单 #7：C3 Knowledge 检索语料（search_rule / search_history 数据源；缺省空语料） */
  readonly knowledge?: KnowledgeCorpus;
  /** T10 挂载点：模型名（默认 deepseek-v4-flash） */
  readonly model?: string;
  /** effort 档位（默认 default） */
  readonly effort?: string;
  /** 可注入时钟（测试确定性 runId） */
  readonly now?: () => Date;
}

/**
 * 入口（主 seam）：runReview(config, mrCase, llmClient) → RunResult。
 * 六阶段骨架循环 + Evidence Gate + usage 记账 + 审计落盘。
 * - config B（prefetch=true）注入 Zone B 与固定管线预取（零工具，纯消息注入）；
 * - config C（fullRepo=true）注入全仓上下文（预算守卫，超限截断留痕）；
 * - toolsEnabled 配置（C/D/E）在未显式覆盖时自动挂载注册表工具箱（schema 字节稳定，Zone A）；
 * - config E（ledger=true）为工具箱注入功能态 Context Ledger（重复读取返回
 *   "Already loaded: ctx#NNN" 引用；run 私有，登记快照进审计留痕）。
 */
export async function runReview(
  config: ReviewConfig,
  mrCase: MRCase,
  llmClient: LlmClient,
  options: RunReviewOptions = {},
): Promise<RunResult> {
  validateRunInputs(config, mrCase, llmClient, options);
  const clock = options.now ?? (() => new Date());
  const startedAt = clock();
  const injection = await buildContextInjection(config, mrCase, options);
  const toolkit = buildAutoMountedToolkit(config, mrCase, options, injection.repo);
  const outcome = await runReviewLoop({
    config,
    mrCase,
    llmClient,
    model: options.model ?? DEFAULT_MODEL,
    effort: options.effort ?? DEFAULT_EFFORT,
    tools: options.tools ?? toolkit?.tools ?? [],
    toolExecutor: options.toolExecutor ?? toolkit?.executor,
    ...(injection.contextMessages !== undefined ? { contextMessages: injection.contextMessages } : {}),
  });
  const finishedAt = clock();
  return finalizeRun({
    config,
    mrCase,
    outcome,
    model: options.model ?? DEFAULT_MODEL,
    effort: options.effort ?? DEFAULT_EFFORT,
    startedAt,
    finishedAt,
    auditDir: options.auditDir ?? DEFAULT_AUDIT_DIR,
    ...(injection.prefetchRecords !== undefined ? { prefetchRecords: injection.prefetchRecords } : {}),
    ...(injection.fullRepoRecord !== undefined ? { fullRepoRecord: injection.fullRepoRecord } : {}),
    ...(config.ledger && toolkit !== undefined ? { ledgerEntries: toolkit.ledger.snapshot() } : {}),
  });
}

/** 上下文注入装配：config B 预取 + config C 全仓（互斥于 CONFIGS，可并存于自定义 config） */
async function buildContextInjection(
  config: ReviewConfig,
  mrCase: MRCase,
  options: RunReviewOptions,
): Promise<ContextInjection> {
  const prefetch = config.prefetch
    ? await buildPrefetchContext({
        repoPath: mrCase.repoPath,
        diff: mrCase.diff,
        budgets: resolvePrefetchBudgets(options.prefetch),
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`failed to build deterministic prefetch context: ${message}`, { cause: error });
      })
    : undefined;
  const fullRepo = config.fullRepo ? await buildFullRepoContext(mrCase, options) : undefined;
  const contextMessages: ContextMessages | undefined =
    prefetch !== undefined || fullRepo !== undefined
      ? {
          ...(prefetch !== undefined
            ? { zoneB: [prefetch.zoneBMessage], prefetch: prefetch.layerMessages }
            : {}),
          ...(fullRepo !== undefined ? { fullRepo: [fullRepo.injection.message] } : {}),
        }
      : undefined;
  return {
    ...(contextMessages !== undefined ? { contextMessages } : {}),
    ...(prefetch !== undefined ? { prefetchRecords: prefetch.records } : {}),
    ...(fullRepo !== undefined ? { fullRepoRecord: fullRepo.injection.record, repo: fullRepo.repo } : {}),
  };
}

interface ContextInjection {
  readonly contextMessages?: ContextMessages;
  readonly prefetchRecords?: readonly PrefetchLayerRecord[];
  readonly fullRepoRecord?: FullRepoRecord;
  /** config C 已加载的 RepoContext（工具箱共享，避免二次加载） */
  readonly repo?: RepoContext;
}

/** toolsEnabled 且调用方未显式覆盖 tools/toolExecutor 时自动挂载注册表工具箱 */
function buildAutoMountedToolkit(
  config: ReviewConfig,
  mrCase: MRCase,
  options: RunReviewOptions,
  sharedRepo: RepoContext | undefined,
): ReturnType<typeof buildReviewToolkit> | undefined {
  if (!config.toolsEnabled || options.tools !== undefined || options.toolExecutor !== undefined) {
    return undefined;
  }
  return buildReviewToolkit({
    repoPath: mrCase.repoPath,
    diff: mrCase.diff,
    ...(config.ledger ? { ledger: true } : {}),
    ...(options.toolResultBudgetChars !== undefined
      ? { resultBudgetChars: options.toolResultBudgetChars }
      : {}),
    ...(options.knowledge !== undefined ? { knowledge: options.knowledge } : {}),
    ...(sharedRepo !== undefined ? { repo: sharedRepo } : {}),
  });
}

/** config C 全仓注入（eager：注入失败为显式 run 失败；RepoContext 与工具箱共享） */
async function buildFullRepoContext(
  mrCase: MRCase,
  options: RunReviewOptions,
): Promise<{ readonly injection: FullRepoInjection; readonly repo: RepoContext }> {
  try {
    const repo = await loadRepoContext(mrCase.repoPath);
    const injection = await buildFullRepoInjection({
      repo,
      budgetChars: options.fullRepoBudgetChars ?? DEFAULT_FULL_REPO_BUDGET_CHARS,
    });
    return { injection, repo };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to build full repository context: ${message}`, { cause: error });
  }
}

async function finalizeRun(args: {
  readonly config: ReviewConfig;
  readonly mrCase: MRCase;
  readonly outcome: LoopOutcome;
  readonly model: string;
  readonly effort: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly auditDir: string;
  readonly prefetchRecords?: readonly PrefetchLayerRecord[];
  readonly fullRepoRecord?: FullRepoRecord;
  readonly ledgerEntries?: readonly LedgerEntry[];
}): Promise<RunResult> {
  const { config, mrCase, outcome } = args;
  const audit: RunAudit = {
    requests: outcome.requests,
    toolCallLog: outcome.toolCallLog,
    phaseLog: outcome.phaseLog,
    rejections: outcome.rejections,
    cacheBreaks: outcome.cacheBreaks,
    truncated: outcome.truncated,
    truncationReasons: outcome.truncationReasons,
    ...(args.prefetchRecords !== undefined ? { prefetch: args.prefetchRecords } : {}),
    ...(args.fullRepoRecord !== undefined ? { fullRepo: args.fullRepoRecord } : {}),
    ...(args.ledgerEntries !== undefined ? { ledger: args.ledgerEntries } : {}),
  };
  const runId = buildRunId(args.startedAt, config.configId, mrCase.caseId);
  const auditContent = buildAuditFileContent({
    runId,
    caseId: mrCase.caseId,
    configId: config.configId,
    model: args.model,
    effort: args.effort,
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    rounds: outcome.rounds,
    toolCalls: outcome.toolCallCount,
    usage: outcome.usage,
    findings: outcome.findings,
    audit,
    ...(args.prefetchRecords !== undefined ? { prefetch: args.prefetchRecords } : {}),
    ...(args.fullRepoRecord !== undefined ? { fullRepo: args.fullRepoRecord } : {}),
    ...(args.ledgerEntries !== undefined ? { ledger: args.ledgerEntries } : {}),
  });
  const auditPath = await writeAuditFile(args.auditDir, auditContent);
  return {
    caseId: mrCase.caseId,
    configId: config.configId,
    findings: outcome.findings,
    usage: outcome.usage,
    rounds: outcome.rounds,
    toolCalls: outcome.toolCallCount,
    audit,
    auditPath,
  };
}
