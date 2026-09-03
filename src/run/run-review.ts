import type { ReviewConfig } from "../contracts/config.js";
import type { LlmClient, ToolSchema } from "../contracts/llm-client.js";
import type { MRCase } from "../contracts/mr-case.js";
import type { PrefetchLayerRecord, PrefetchOptions } from "../contracts/prefetch.js";
import { resolvePrefetchBudgets } from "../contracts/prefetch.js";
import type { RunAudit, RunResult } from "../contracts/run.js";
import { buildAuditFileContent, buildRunId, DEFAULT_AUDIT_DIR, writeAuditFile } from "../audit/audit-writer.js";
import type { ContextMessages } from "../loop/messages.js";
import type { LoopOutcome } from "../loop/review-loop.js";
import { runReviewLoop } from "../loop/review-loop.js";
import type { ToolExecutor } from "../loop/tools.js";
import { buildPrefetchContext } from "../zoneb/prefetch.js";
import { validateRunInputs } from "./validate-inputs.js";

/** 主力模型与 effort 档位（ADR-0002：全实验锁定，禁止档位漂移） */
export const DEFAULT_MODEL = "deepseek-v4-flash";
export const DEFAULT_EFFORT = "default";

export interface RunReviewOptions {
  /** 审计落盘目录；默认 runs/audit */
  readonly auditDir?: string;
  /** T03 挂载点：review.* 工具 schema（仅 toolsEnabled=true 的配置生效） */
  readonly tools?: readonly ToolSchema[];
  /** T03 挂载点：工具执行器 */
  readonly toolExecutor?: ToolExecutor;
  /** 工单 #4：config B 预取预算（字符数；缺省用 DEFAULT_PREFETCH_BUDGETS） */
  readonly prefetch?: PrefetchOptions;
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
 * config B（prefetch=true）额外注入 Zone B 与固定管线预取（零工具，纯消息注入）。
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
  const contextMessages: ContextMessages | undefined =
    prefetch !== undefined
      ? { zoneB: [prefetch.zoneBMessage], prefetch: prefetch.layerMessages }
      : undefined;
  const outcome = await runReviewLoop({
    config,
    mrCase,
    llmClient,
    model: options.model ?? DEFAULT_MODEL,
    effort: options.effort ?? DEFAULT_EFFORT,
    tools: options.tools ?? [],
    toolExecutor: options.toolExecutor,
    ...(contextMessages !== undefined ? { contextMessages } : {}),
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
    ...(prefetch !== undefined ? { prefetchRecords: prefetch.records } : {}),
  });
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
}): Promise<RunResult> {
  const { config, mrCase, outcome } = args;
  const audit: RunAudit = {
    requests: outcome.requests,
    toolCallLog: outcome.toolCallLog,
    phaseLog: outcome.phaseLog,
    rejections: outcome.rejections,
    truncated: outcome.truncated,
    truncationReasons: outcome.truncationReasons,
    ...(args.prefetchRecords !== undefined ? { prefetch: args.prefetchRecords } : {}),
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
