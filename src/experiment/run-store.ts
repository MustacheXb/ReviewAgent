import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConfigId } from "../contracts/config.js";
import type { Finding } from "../contracts/finding.js";
import type { LlmRequest, LlmUsage } from "../contracts/llm-client.js";
import type { CandidateRejection, FullRepoRecord, PhaseRecord, RunAudit, RunResult, ToolCallRecord } from "../contracts/run.js";
import type { LedgerEntry } from "../contracts/ledger.js";
import type { PrefetchLayerRecord } from "../contracts/prefetch.js";
import type { ExperimentModel, ExperimentSource, RunUnit, VerifierMode } from "./plan.js";

/**
 * 运行留痕存储（Ticket 12）：每个 (source, caseId, configId, rep) 一份 JSON 记录，
 * 落盘于 <experimentRoot>/runs/<source>/<caseId>/<configId>/rep-<rep>.json。
 *
 * - 断点续跑：记录存在且可解析 = 已完成，运行器跳过（审计重放文件在 auditPath）；
 * - 请求字节不重复落盘：runReview 的审计文件（auditPath）承载全部请求的可重放字节，
 *   本记录保留指标与判定链所需的最小审计面（toolCallLog / phaseLog / rejections 等）。
 */

/** runReview 审计的轻量投影（不含 requests；重放字节以 auditPath 为准） */
export interface AuditLight {
  readonly toolCallLog: readonly ToolCallRecord[];
  readonly phaseLog: readonly PhaseRecord[];
  readonly rejections: readonly CandidateRejection[];
  readonly truncated: boolean;
  readonly truncationReasons: readonly string[];
  readonly prefetch?: readonly PrefetchLayerRecord[];
  readonly fullRepo?: FullRepoRecord;
  readonly ledger?: readonly LedgerEntry[];
}

/** 二遍 Verifier 的留痕（消融开关 on 时） */
export interface VerifierRecord {
  readonly status: "verified" | "skipped-no-findings" | "error";
  readonly errorMessage: string | null;
  /** 逐 Finding 裁定（id → pass/reason） */
  readonly verdicts: readonly { readonly id: string; readonly pass: boolean; readonly reason: string }[];
  readonly removedFindingIds: readonly string[];
  /** 未获裁定的 Finding（保留原判，不静默丢弃） */
  readonly unverifiedFindingIds: readonly string[];
  /** Verifier token 记账（计入 CARC 的口径） */
  readonly usage: LlmUsage;
  /** Verifier 请求字节（可重放；skipped/error 时缺省） */
  readonly request?: LlmRequest;
}

/** 一次运行的持久化记录（断点续跑与报告重建的数据源） */
export interface RunRecord {
  readonly source: ExperimentSource;
  readonly caseId: string;
  readonly configId: ConfigId;
  readonly rep: number;
  readonly model: ExperimentModel;
  readonly verifier: VerifierMode;
  readonly completedAt: string;
  /** 基线（六阶段循环单遍自证）结果快照 */
  readonly baseline: RunSnapshot;
  /** Verifier on：复核后的有效结果（findings + 合并 usage） */
  readonly effective: RunSnapshot | null;
  readonly verifierPass: VerifierRecord | null;
}

/** RunResult 快照（audit 以轻量投影落盘） */
export interface RunSnapshot {
  readonly findings: readonly Finding[];
  readonly usage: LlmUsage;
  readonly rounds: number;
  readonly toolCalls: number;
  readonly audit: AuditLight;
  readonly auditPath: string;
}

/** RunResult → 轻量快照（去 requests；路径来自 RunResult.auditPath） */
export function toRunSnapshot(result: RunResult): RunSnapshot {
  return {
    findings: result.findings,
    usage: result.usage,
    rounds: result.rounds,
    toolCalls: result.toolCalls,
    audit: toAuditLight(result.audit),
    auditPath: result.auditPath ?? "",
  };
}

export function toAuditLight(audit: RunAudit): AuditLight {
  return {
    toolCallLog: audit.toolCallLog,
    phaseLog: audit.phaseLog,
    rejections: audit.rejections,
    truncated: audit.truncated,
    truncationReasons: audit.truncationReasons,
    ...(audit.prefetch !== undefined ? { prefetch: audit.prefetch } : {}),
    ...(audit.fullRepo !== undefined ? { fullRepo: audit.fullRepo } : {}),
    ...(audit.ledger !== undefined ? { ledger: audit.ledger } : {}),
  };
}

/** 记录 → RunResult（指标 / 判定链的重建形状；effective 优先于 baseline） */
export function recordToRunResult(record: RunRecord): RunResult {
  const snapshot = record.effective ?? record.baseline;
  const audit: RunAudit = {
    requests: [],
    toolCallLog: snapshot.audit.toolCallLog,
    phaseLog: snapshot.audit.phaseLog,
    rejections: snapshot.audit.rejections,
    truncated: snapshot.audit.truncated,
    truncationReasons: snapshot.audit.truncationReasons,
    ...(snapshot.audit.prefetch !== undefined ? { prefetch: snapshot.audit.prefetch } : {}),
    ...(snapshot.audit.fullRepo !== undefined ? { fullRepo: snapshot.audit.fullRepo } : {}),
    ...(snapshot.audit.ledger !== undefined ? { ledger: snapshot.audit.ledger } : {}),
  };
  return {
    caseId: record.caseId,
    configId: record.configId,
    findings: snapshot.findings,
    usage: snapshot.usage,
    rounds: snapshot.rounds,
    toolCalls: snapshot.toolCalls,
    audit,
    ...(snapshot.auditPath.length > 0 ? { auditPath: snapshot.auditPath } : {}),
  };
}

/** 记录 → 基线 RunResult（始终取 baseline：Verifier off 档的对照口径） */
export function recordToBaselineRunResult(record: RunRecord): RunResult {
  return recordToRunResult({ ...record, effective: null });
}

/** 运行记录存储：读写 + 断点续跑扫描 */
export class RunStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    if (typeof rootDir !== "string" || rootDir.trim() === "") {
      throw new Error("rootDir must be a non-empty path");
    }
    this.rootDir = path.resolve(rootDir);
  }

  get root(): string {
    return this.rootDir;
  }

  /** 记录文件路径：<root>/<source>/<caseId>/<configId>/rep-<rep>.json */
  pathOf(unit: RunUnit): string {
    const safeCaseId = unit.caseId.replace(/[^A-Za-z0-9_.-]/g, "_");
    return path.join(this.rootDir, unit.source, safeCaseId, unit.configId, `rep-${unit.rep}.json`);
  }

  /** 读单条记录；不存在或损坏返回 null（损坏视同未完成，重跑覆盖） */
  async read(unit: RunUnit): Promise<RunRecord | null> {
    return this.readRecordFile(this.pathOf(unit));
  }

  /** 落盘记录（原子性：直接写目标文件；失败显式抛错） */
  async save(record: RunRecord): Promise<string> {
    const filePath = this.pathOf({
      source: record.source,
      caseId: record.caseId,
      configId: record.configId,
      rep: record.rep,
    });
    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      return filePath;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `failed to persist run record ${record.source}/${record.caseId}/${record.configId}/rep-${record.rep}: ${message}`,
        { cause: error },
      );
    }
  }

  /** 全量扫描已完成的记录（报告重建 / 断点统计）；目录不存在返回空数组 */
  async readAll(): Promise<readonly RunRecord[]> {
    try {
      await stat(this.rootDir);
    } catch {
      return [];
    }
    const records: RunRecord[] = [];
    const sources = await listDirectories(this.rootDir);
    for (const source of sources) {
      const caseDirs = await listDirectories(path.join(this.rootDir, source));
      for (const caseDir of caseDirs) {
        const configDirs = await listDirectories(path.join(this.rootDir, source, caseDir));
        for (const configDir of configDirs) {
          const repFiles = await listFiles(path.join(this.rootDir, source, caseDir, configDir));
          for (const repFile of repFiles.filter((name) => /^rep-\d+\.json$/.test(name))) {
            const record = await this.readRecordFile(
              path.join(this.rootDir, source, caseDir, configDir, repFile),
            );
            if (record !== null) {
              records.push(record);
            }
          }
        }
      }
    }
    return records;
  }

  private async readRecordFile(filePath: string): Promise<RunRecord | null> {
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(text) as RunRecord;
      if (isRunRecordShape(parsed)) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }
}

function isRunRecordShape(value: unknown): value is RunRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Partial<RunRecord>;
  return (
    typeof record.source === "string" &&
    typeof record.caseId === "string" &&
    typeof record.configId === "string" &&
    typeof record.rep === "number" &&
    typeof record.model === "string" &&
    (record.verifier === "off" || record.verifier === "on") &&
    typeof record.completedAt === "string" &&
    typeof record.baseline === "object" &&
    record.baseline !== null &&
    Array.isArray((record.baseline as Partial<RunSnapshot>).findings) &&
    typeof (record.baseline as Partial<RunSnapshot>).usage === "object"
  );
}

async function listDirectories(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}
