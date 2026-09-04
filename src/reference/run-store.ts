import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { REFERENCE_CONFIG_ID } from "../contracts/config.js";
import type { Finding } from "../contracts/finding.js";
import type { LlmUsage } from "../contracts/llm-client.js";
import type { RunResult } from "../contracts/run.js";
import type { ReferenceRejection } from "./contracts.js";
import type { ReferenceRunUnit } from "./plan.js";

/**
 * 外部参照运行留痕（Ticket 13 / issue #14，镜像 T12 RunStore 模式）：
 * 每个 (source, caseId, rep) 一份 JSON 记录，落盘于
 * <referenceRoot>/runs/<source>/<caseId>/rep-<rep>.json；
 * 完整可复现材料（提示词原文 / stdout 原文 / 调用配置 / CLI 版本）另档
 * <referenceRoot>/raw/<source>/<caseId>/rep-<rep>.json。
 *
 * - 断点续跑：记录存在且可解析且配置兼容 = 已完成，跳过（不再花钱）；
 * - 记录损坏视同未完成，重跑覆盖；
 * - raw 档案与记录分开：报告重建只需记录，事后归因再读 raw。
 */

/** 一次参照运行的持久化记录（断点续跑与报告重建的数据源） */
export interface ReferenceRunRecord {
  readonly source: string;
  readonly caseId: string;
  readonly rep: number;
  readonly completedAt: string;
  /** 计划请求的模型 id（--model） */
  readonly requestedModel: string;
  /** CLI 回报的实际模型 id（modelUsage 键；留档对照） */
  readonly actualModels: readonly string[];
  /** claude --version 采集值（随运行留档） */
  readonly claudeVersion: string;
  readonly maxTurns: number;
  readonly promptTemplateVersion: string;
  /** ok = 零拦截；degraded = 归一化存在拦截留痕（有界失败，findings 可能为空） */
  readonly status: "ok" | "degraded";
  readonly findings: readonly Finding[];
  readonly rejections: readonly ReferenceRejection[];
  readonly usage: LlmUsage;
  readonly numTurns: number | null;
  readonly totalCostUsd: number | null;
  readonly permissionDenials: number;
  readonly parseNotes: readonly string[];
  /** 完整可复现档案（提示词/stdout/配置）的相对路径 */
  readonly rawPath: string;
}

/** raw 档案内容：提示词 / 配置 / CLI 产物原文（外部参照可复现性的留档义务） */
export interface ReferenceRawArtifact {
  readonly source: string;
  readonly caseId: string;
  readonly rep: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly requestedModel: string;
  readonly maxTurns: number;
  readonly allowedTools: readonly string[];
  readonly promptTemplateVersion: string;
  readonly claudeVersion: string;
  readonly prompt: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

/** 记录 → RunResult（走同一 evaluateRun / buildMetricsReport 管线的形状） */
export function referenceRecordToRunResult(record: ReferenceRunRecord): RunResult {
  return {
    caseId: record.caseId,
    // 外部参照单列伪配置位：永不进入 A–E 矩阵与 S/A/B 判定（仅作指标分组键）
    configId: REFERENCE_CONFIG_ID,
    findings: record.findings,
    usage: record.usage,
    // Claude Code 的 agent 轮数（num_turns）；工具调用计数 CLI 不经 stdout 暴露，
    // 记 0（Agent Efficiency 字段对外部参照列不作解读，报告 note 已声明）
    rounds: record.numTurns ?? 0,
    toolCalls: 0,
    audit: {
      requests: [],
      toolCallLog: [],
      phaseLog: [],
      rejections: [],
      truncated: false,
      truncationReasons: [],
    },
  };
}

/** 运行记录存储：读写 + 断点续跑扫描 */
export class ReferenceRunStore {
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

  /** 记录文件路径：<root>/runs/<source>/<caseId>/rep-<rep>.json */
  pathOf(unit: ReferenceRunUnit): string {
    const safeCaseId = unit.caseId.replace(/[^A-Za-z0-9_.-]/g, "_");
    return path.join(this.rootDir, "runs", unit.source, safeCaseId, `rep-${unit.rep}.json`);
  }

  /** raw 档案路径：<root>/raw/<source>/<caseId>/rep-<rep>.json */
  rawPathOf(unit: ReferenceRunUnit): string {
    const safeCaseId = unit.caseId.replace(/[^A-Za-z0-9_.-]/g, "_");
    return path.join(this.rootDir, "raw", unit.source, safeCaseId, `rep-${unit.rep}.json`);
  }

  /** 读单条记录；不存在或损坏返回 null（损坏视同未完成，重跑覆盖） */
  async read(unit: ReferenceRunUnit): Promise<ReferenceRunRecord | null> {
    return this.readRecordFile(this.pathOf(unit));
  }

  /** 落盘记录（失败显式抛错） */
  async save(record: ReferenceRunRecord): Promise<string> {
    const filePath = this.pathOf({
      source: record.source as ReferenceRunUnit["source"],
      caseId: record.caseId,
      rep: record.rep,
    });
    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      return filePath;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `failed to persist reference run record ${record.source}/${record.caseId}/rep-${record.rep}: ${message}`,
        { cause: error },
      );
    }
  }

  /** 落盘 raw 档案（提示词/stdout/配置；可复现性留档） */
  async saveRaw(unit: ReferenceRunUnit, artifact: ReferenceRawArtifact): Promise<string> {
    const filePath = this.rawPathOf(unit);
    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
      return filePath;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `failed to persist raw artifact ${unit.source}/${unit.caseId}/rep-${unit.rep}: ${message}`,
        { cause: error },
      );
    }
  }

  /** 全量扫描已完成记录（报告重建 / 断点统计）；目录不存在返回空数组 */
  async readAll(): Promise<readonly ReferenceRunRecord[]> {
    const runsRoot = path.join(this.rootDir, "runs");
    try {
      await stat(runsRoot);
    } catch {
      return [];
    }
    const records: ReferenceRunRecord[] = [];
    for (const source of await listDirectories(runsRoot)) {
      const caseDirs = await listDirectories(path.join(runsRoot, source));
      for (const caseDir of caseDirs) {
        const repFiles = await listFiles(path.join(runsRoot, source, caseDir));
        for (const repFile of repFiles.filter((name) => /^rep-\d+\.json$/.test(name))) {
          const record = await this.readRecordFile(path.join(runsRoot, source, caseDir, repFile));
          if (record !== null) {
            records.push(record);
          }
        }
      }
    }
    return records;
  }

  private async readRecordFile(filePath: string): Promise<ReferenceRunRecord | null> {
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(text) as ReferenceRunRecord;
      return isReferenceRunRecordShape(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function isReferenceRunRecordShape(value: unknown): value is ReferenceRunRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Partial<ReferenceRunRecord>;
  return (
    typeof record.source === "string" &&
    typeof record.caseId === "string" &&
    typeof record.rep === "number" &&
    typeof record.completedAt === "string" &&
    typeof record.requestedModel === "string" &&
    Array.isArray(record.actualModels) &&
    typeof record.claudeVersion === "string" &&
    typeof record.maxTurns === "number" &&
    typeof record.promptTemplateVersion === "string" &&
    (record.status === "ok" || record.status === "degraded") &&
    Array.isArray(record.findings) &&
    Array.isArray(record.rejections) &&
    typeof record.usage === "object" &&
    record.usage !== null
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
