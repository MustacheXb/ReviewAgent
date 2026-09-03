import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConfigId } from "../contracts/config.js";
import type { Finding } from "../contracts/finding.js";
import type { LlmRequest, LlmUsage } from "../contracts/llm-client.js";
import type { PrefetchLayerRecord } from "../contracts/prefetch.js";
import type { CandidateRejection, FullRepoRecord, PhaseRecord, RunAudit, ToolCallRecord } from "../contracts/run.js";

/** 审计文件默认落盘目录（相对 cwd；测试注入临时目录） */
export const DEFAULT_AUDIT_DIR = "runs/audit";

/**
 * 审计文件内容 = RunAudit + usage + findings + run 元数据。
 * 每次运行的请求字节（requests 数组即可重放的完整请求）、工具调用、usage 记账、
 * 最终 Finding 全量落盘（spec #1 User Story 32）。
 */
export interface AuditFileContent {
  readonly runId: string;
  readonly caseId: string;
  readonly configId: ConfigId;
  readonly model: string;
  readonly effort: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly rounds: number;
  readonly toolCalls: number;
  readonly truncated: boolean;
  readonly truncationReasons: readonly string[];
  readonly usage: LlmUsage;
  readonly findings: readonly Finding[];
  readonly phaseLog: readonly PhaseRecord[];
  readonly rejections: readonly CandidateRejection[];
  readonly requests: readonly LlmRequest[];
  readonly toolCallLog: readonly ToolCallRecord[];
  /** config B 预取注入层记账（非预取配置缺省） */
  readonly prefetch?: readonly PrefetchLayerRecord[];
  /** config C 全仓注入记账（非全仓配置缺省；工单 #6 扩展字段） */
  readonly fullRepo?: FullRepoRecord;
}

/** runId：毫秒时间戳 + 配置 + 用例，文件名安全 */
export function buildRunId(startedAt: Date, configId: ConfigId, caseId: string): string {
  const timestamp = startedAt.toISOString().replace(/[-:]/g, "").replace("Z", "");
  const safeCaseId = caseId.replace(/[^A-Za-z0-9_-]/g, "_");
  return `${timestamp}-${configId}-${safeCaseId}`;
}

export function buildAuditFileContent(args: {
  readonly runId: string;
  readonly caseId: string;
  readonly configId: ConfigId;
  readonly model: string;
  readonly effort: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly rounds: number;
  readonly toolCalls: number;
  readonly usage: LlmUsage;
  readonly findings: readonly Finding[];
  readonly audit: RunAudit;
  readonly prefetch?: readonly PrefetchLayerRecord[];
  readonly fullRepo?: FullRepoRecord;
}): AuditFileContent {
  return {
    runId: args.runId,
    caseId: args.caseId,
    configId: args.configId,
    model: args.model,
    effort: args.effort,
    startedAt: args.startedAt.toISOString(),
    finishedAt: args.finishedAt.toISOString(),
    durationMs: args.finishedAt.getTime() - args.startedAt.getTime(),
    rounds: args.rounds,
    toolCalls: args.toolCalls,
    truncated: args.audit.truncated,
    truncationReasons: args.audit.truncationReasons,
    usage: args.usage,
    findings: args.findings,
    phaseLog: args.audit.phaseLog,
    rejections: args.audit.rejections,
    requests: args.audit.requests,
    toolCallLog: args.audit.toolCallLog,
    ...(args.prefetch !== undefined ? { prefetch: args.prefetch } : {}),
    ...(args.fullRepo !== undefined ? { fullRepo: args.fullRepo } : {}),
  };
}

/** 写审计文件（<auditDir>/<runId>.json），返回绝对路径；失败显式抛错 */
export async function writeAuditFile(auditDir: string, content: AuditFileContent): Promise<string> {
  const dir = path.resolve(auditDir);
  try {
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${content.runId}.json`);
    await writeFile(filePath, `${JSON.stringify(content, null, 2)}\n`, "utf8");
    return filePath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to persist audit file for run ${content.runId}: ${message}`, { cause: error });
  }
}
