import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MRCase } from "../contracts/mr-case.js";
import { CLAUDE_CODE_ALLOWED_TOOLS } from "./client.js";
import type { ClaudeCodeClient } from "./contracts.js";
import { normalizeClaudeCodeRun } from "./normalize.js";
import { buildClaudeCodePrompt } from "./prompt.js";
import type {
  ClaudeCodeReferencePlan,
  ExpandedReferencePlan,
  ReferenceRunUnit,
} from "./plan.js";
import { expandReferencePlan } from "./plan.js";
import type { ReferenceRawArtifact, ReferenceRunRecord } from "./run-store.js";
import { ReferenceRunStore } from "./run-store.js";

/**
 * 外部参照运行器（Ticket 13 / issue #14）：数据集 → Claude Code 无头检视 →
 * 归一化（有界失败）→ 记录/raw 留档 → 断点续跑。
 *
 * 纪律（镜像 T12 runExperiment）：
 * - 失败隔离：单 (source, caseId, rep) 失败（CLI 崩溃 / 超时 / 退出码非零 / is_error）
 *   不拖垮整批——留痕（failures）继续；失败单元不落记录，续跑时可重试；
 * - 归一化容错：CLI 成功但输出部分非法 → degraded 记录（合法条目保留 + 拦截留痕），
 *   usage / 成本照常记账，不整单报废；
 * - 断点续跑：记录存在且 model / maxTurns / promptTemplateVersion 与计划兼容即跳过；
 *   配置漂移启动即报错（防混跑烧钱）；
 * - 版本留档：启动采集 claude --version 一次，随每条记录与 raw 档案落盘。
 */

/** 留痕文件名（参照根目录内） */
export const REFERENCE_PLAN_FILE = "reference-plan.json";
export const REFERENCE_CASES_FILE = "cases.json";
export const REFERENCE_FAILURES_FILE = "failures.json";

export interface ReferenceRunnerPaths {
  /** 参照运行根目录（<runsRoot>/claude-code/<referenceId>） */
  readonly referenceRoot: string;
}

export interface ReferenceDeps {
  readonly client: ClaudeCodeClient;
  readonly now?: () => Date;
  /** 单元级进度回调（CLI 打印 / 测试观测；异常由运行器捕获后继续） */
  readonly onUnit?: (event: ReferenceUnitEvent) => void;
}

export type ReferenceUnitEvent =
  | { readonly kind: "resumed"; readonly unit: ReferenceRunUnit }
  | { readonly kind: "completed"; readonly unit: ReferenceRunUnit; readonly findings: number }
  | { readonly kind: "failed"; readonly unit: ReferenceRunUnit; readonly message: string };

export interface ReferenceFailure {
  readonly source: string;
  readonly caseId: string;
  readonly rep: number;
  readonly message: string;
}

export interface ReferenceOutcome {
  readonly referenceId: string;
  readonly plan: ClaudeCodeReferencePlan;
  readonly expanded: ExpandedReferencePlan;
  readonly executed: number;
  readonly resumed: number;
  readonly failures: readonly ReferenceFailure[];
  readonly records: readonly ReferenceRunRecord[];
  readonly cases: readonly MRCase[];
}

/** 执行外部参照跑批（含断点续跑；报告构建见 report.ts） */
export async function runClaudeCodeReference(
  plan: ClaudeCodeReferencePlan,
  cases: readonly MRCase[],
  deps: ReferenceDeps,
  paths: ReferenceRunnerPaths,
): Promise<ReferenceOutcome> {
  const expanded = expandReferencePlan(plan, cases);
  const store = new ReferenceRunStore(paths.referenceRoot);
  // CLI 版本留档：启动采集一次（缺失/不可执行 → 启动即失败，不逐单元空转）
  const claudeVersion = await deps.client.version();
  await persistPlanAndCases(paths.referenceRoot, plan, expanded.cases);
  const existing = await loadCompatibleRecords(store, plan, expanded.units);
  const caseById = new Map(expanded.cases.map((mrCase) => [mrCase.caseId, mrCase]));
  const executed: ReferenceRunRecord[] = [];
  const failures: ReferenceFailure[] = [];
  let resumed = 0;
  for (const unit of expanded.units) {
    const cached = existing.get(unitKey(unit));
    if (cached !== undefined) {
      resumed++;
      emit(deps, { kind: "resumed", unit });
      continue;
    }
    const mrCase = caseById.get(unit.caseId);
    if (mrCase === undefined) {
      // expandReferencePlan 保证 units 与 cases 对齐；此分支仅防御性留痕
      failures.push(failureOf(unit, "case missing from the expanded plan"));
      continue;
    }
    const execution = await executeUnit(unit, mrCase, plan, deps, store, claudeVersion);
    if (execution.kind === "failure") {
      failures.push(execution.failure);
      continue;
    }
    executed.push(execution.record);
  }
  await persistFailures(paths.referenceRoot, failures);
  const records = orderRecords([...existing.values(), ...executed], expanded.units);
  return {
    referenceId: plan.referenceId,
    plan,
    expanded,
    executed: executed.length,
    resumed,
    failures,
    records,
    cases: expanded.cases,
  };
}

/** 单元执行结果：成功落记录；失败留痕（不拖垮整批） */
type UnitExecution =
  | { readonly kind: "record"; readonly record: ReferenceRunRecord }
  | { readonly kind: "failure"; readonly failure: ReferenceFailure };

/** 单元执行：无头调用 → 失败判定 → 归一化 → raw/记录落盘；失败留痕不拖垮整批 */
async function executeUnit(
  unit: ReferenceRunUnit,
  mrCase: MRCase,
  plan: ClaudeCodeReferencePlan,
  deps: ReferenceDeps,
  store: ReferenceRunStore,
  claudeVersion: string,
): Promise<UnitExecution> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const prompt = buildClaudeCodePrompt(mrCase);
  try {
    const raw = await deps.client.run({
      prompt,
      // 同仓纪律：子进程工作目录 = 被检仓库（MR 基线快照）
      cwd: mrCase.repoPath,
      model: plan.model,
      maxTurns: plan.maxTurns,
    });
    // raw 档案先行留档（失败路径同样留痕：提示词/输出/配置是事后归因与复现的依据）
    const rawPath = await store.saveRaw(
      unit,
      rawArtifact(unit, plan, claudeVersion, prompt, raw, startedAt, now),
    );
    const cliFailure = cliFailureMessage(raw.exitCode, raw.stderr);
    if (cliFailure !== null) {
      throw new Error(cliFailure);
    }
    const normalized = normalizeClaudeCodeRun(raw);
    if (normalized.parse.isError) {
      throw new Error(
        `claude CLI reported is_error=true${normalized.parse.resultText === null ? "" : `: ${normalized.parse.resultText.slice(0, 200)}`}`,
      );
    }
    const record: ReferenceRunRecord = {
      source: unit.source,
      caseId: unit.caseId,
      rep: unit.rep,
      completedAt: now().toISOString(),
      requestedModel: plan.model,
      actualModels: normalized.parse.actualModels,
      claudeVersion,
      maxTurns: plan.maxTurns,
      promptTemplateVersion: plan.promptTemplateVersion,
      status: normalized.status,
      findings: normalized.findings,
      rejections: normalized.rejections,
      usage: normalized.parse.usage,
      numTurns: normalized.parse.numTurns,
      totalCostUsd: normalized.parse.totalCostUsd,
      permissionDenials: normalized.parse.permissionDenials,
      parseNotes: normalized.parse.notes,
      rawPath: path.relative(store.root, rawPath).replaceAll("\\", "/"),
    };
    await store.save(record);
    emit(deps, { kind: "completed", unit, findings: record.findings.length });
    return { kind: "record", record };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(deps, { kind: "failed", unit, message });
    return { kind: "failure", failure: failureOf(unit, message) };
  }
}

/** CLI 层失败判定：退出码非零 / 进程被杀；null = 可继续归一化 */
function cliFailureMessage(exitCode: number | null, stderr: string): string | null {
  if (exitCode === null) {
    return `claude CLI process was killed (no exit code); stderr: ${snippet(stderr)}`;
  }
  if (exitCode !== 0) {
    return `claude CLI exited with code ${exitCode}; stderr: ${snippet(stderr)}`;
  }
  return null;
}

function snippet(stderr: string): string {
  const collapsed = stderr.replace(/\s+/g, " ").trim();
  return collapsed.length <= 200 ? collapsed : `${collapsed.slice(0, 200)}…`;
}

function rawArtifact(
  unit: ReferenceRunUnit,
  plan: ClaudeCodeReferencePlan,
  claudeVersion: string,
  prompt: string,
  raw: { readonly stdout: string; readonly stderr: string; readonly exitCode: number | null },
  startedAt: string,
  now: () => Date,
): ReferenceRawArtifact {
  return {
    source: unit.source,
    caseId: unit.caseId,
    rep: unit.rep,
    startedAt,
    completedAt: now().toISOString(),
    requestedModel: plan.model,
    maxTurns: plan.maxTurns,
    allowedTools: [...CLAUDE_CODE_ALLOWED_TOOLS],
    promptTemplateVersion: plan.promptTemplateVersion,
    claudeVersion,
    prompt,
    stdout: raw.stdout,
    stderr: raw.stderr,
    exitCode: raw.exitCode,
  };
}

/**
 * 断点续跑兼容检查：读取计划内全部既有记录；
 * model / maxTurns / promptTemplateVersion 与计划不符的记录视为过期配置——
 * 启动即报错（防静默重跑烧钱），错误信息指明换新 --id 或删除目录。
 */
async function loadCompatibleRecords(
  store: ReferenceRunStore,
  plan: ClaudeCodeReferencePlan,
  units: readonly ReferenceRunUnit[],
): Promise<ReadonlyMap<string, ReferenceRunRecord>> {
  const byKey = new Map<string, ReferenceRunRecord>();
  const stale: string[] = [];
  for (const unit of units) {
    const record = await store.read(unit);
    if (record === null) {
      continue;
    }
    if (
      record.requestedModel !== plan.model ||
      record.maxTurns !== plan.maxTurns ||
      record.promptTemplateVersion !== plan.promptTemplateVersion
    ) {
      stale.push(`${record.source}/${record.caseId}/rep-${record.rep}`);
      continue;
    }
    byKey.set(unitKey(unit), record);
  }
  if (stale.length > 0) {
    throw new Error(
      `reference run "${plan.referenceId}" has ${stale.length} persisted record(s) from a different ` +
        `model/maxTurns/promptTemplateVersion configuration (e.g. ${stale.slice(0, 3).join(", ")}${stale.length > 3 ? ", ..." : ""}). ` +
        `Resume keeps cost accounting honest: use a new --id, or delete the reference directory to start fresh.`,
    );
  }
  return byKey;
}

/** 记录按计划单元顺序整理（case 分组内 rep 升序，与展开顺序一致） */
function orderRecords(
  records: readonly ReferenceRunRecord[],
  units: readonly ReferenceRunUnit[],
): readonly ReferenceRunRecord[] {
  const byKey = new Map(records.map((record) => [recordKey(record), record]));
  const ordered: ReferenceRunRecord[] = [];
  const seen = new Set<string>();
  for (const unit of units) {
    const record = byKey.get(unitKey(unit));
    if (record !== undefined && !seen.has(unitKey(unit))) {
      seen.add(unitKey(unit));
      ordered.push(record);
    }
  }
  return ordered;
}

export function unitKey(unit: ReferenceRunUnit): string {
  return `${unit.source}/${unit.caseId}/rep-${unit.rep}`;
}

function recordKey(record: ReferenceRunRecord): string {
  return `${record.source}/${record.caseId}/rep-${record.rep}`;
}

function failureOf(unit: ReferenceRunUnit, message: string): ReferenceFailure {
  return { source: unit.source, caseId: unit.caseId, rep: unit.rep, message };
}

function emit(deps: ReferenceDeps, event: ReferenceUnitEvent): void {
  try {
    deps.onUnit?.(event);
  } catch {
    // 进度回调异常不拖垮跑批（留痕义务在运行器本身）
  }
}

/** reference-plan.json + cases.json 的首次落盘；已存在时校验一致性（防同 id 异数据集混跑） */
async function persistPlanAndCases(
  referenceRoot: string,
  plan: ClaudeCodeReferencePlan,
  cases: readonly MRCase[],
): Promise<void> {
  await writeJsonIfAbsent(
    path.join(referenceRoot, REFERENCE_PLAN_FILE),
    { ...plan, caseIds: cases.map((mrCase) => mrCase.caseId) },
  );
  const persisted = await readJsonFile(path.join(referenceRoot, REFERENCE_CASES_FILE));
  if (persisted === null) {
    await writeJsonFile(path.join(referenceRoot, REFERENCE_CASES_FILE), cases);
    return;
  }
  const persistedIds = new Set(
    (persisted as readonly { readonly caseId: string }[]).map((mrCase) => mrCase.caseId),
  );
  const incomingIds = new Set(cases.map((mrCase) => mrCase.caseId));
  const differs =
    persistedIds.size !== incomingIds.size ||
    [...incomingIds].some((caseId) => !persistedIds.has(caseId));
  if (differs) {
    throw new Error(
      `reference run "${plan.referenceId}" already has ${REFERENCE_CASES_FILE} for a different case set ` +
        `(${persistedIds.size} persisted vs ${incomingIds.size} incoming). ` +
        "Resume requires the same dataset selection: use a new --id, or delete the reference directory.",
    );
  }
}

/** 失败留痕落盘（每次运行覆盖为最新状态：此前失败、现已续跑成功的单元不再计入） */
async function persistFailures(
  referenceRoot: string,
  failures: readonly ReferenceFailure[],
): Promise<void> {
  try {
    await writeJsonFile(path.join(referenceRoot, REFERENCE_FAILURES_FILE), failures);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to persist ${REFERENCE_FAILURES_FILE}: ${message}`, { cause: error });
  }
}

/** 已有参照目录的重建入口：读 reference-plan.json（报告/续跑的离线数据源） */
export async function loadPersistedReferencePlan(
  referenceRoot: string,
): Promise<ClaudeCodeReferencePlan> {
  const raw = await readJsonFile(path.join(referenceRoot, REFERENCE_PLAN_FILE));
  if (raw === null) {
    throw new Error(
      `no ${REFERENCE_PLAN_FILE} found under ${referenceRoot}: run the reference batch first (or check the --id)`,
    );
  }
  return raw as ClaudeCodeReferencePlan;
}

/** 已有参照目录的重建入口：读 cases.json（报告装配的评估输入） */
export async function loadPersistedReferenceCases(
  referenceRoot: string,
): Promise<readonly MRCase[]> {
  const raw = await readJsonFile(path.join(referenceRoot, REFERENCE_CASES_FILE));
  if (raw === null || !Array.isArray(raw)) {
    throw new Error(`no ${REFERENCE_CASES_FILE} found under ${referenceRoot}: run the reference batch first`);
  }
  return raw as readonly MRCase[];
}

async function writeJsonIfAbsent(filePath: string, content: unknown): Promise<void> {
  const existing = await readJsonFile(filePath);
  if (existing === null) {
    await writeJsonFile(filePath, content);
  }
}

async function writeJsonFile(filePath: string, content: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(content, null, 2)}\n`, "utf8");
}

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    await stat(filePath);
  } catch {
    return null;
  }
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to parse ${filePath}: ${message}`, { cause: error });
  }
}
