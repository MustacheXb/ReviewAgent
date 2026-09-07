import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConfigId } from "../contracts/config.js";
import { CONFIGS } from "../contracts/config.js";
import type { LlmClient } from "../contracts/llm-client.js";
import type { MRCase } from "../contracts/mr-case.js";
import type { RunResult } from "../contracts/run.js";
import { addUsage } from "../loop/usage.js";
import { DEFAULT_EFFORT, runReview } from "../run/run-review.js";
import type { ExperimentPlan, ExpandedPlan, RunUnit } from "./plan.js";
import { expandPlan } from "./plan.js";
import type { RunRecord, RunSnapshot } from "./run-store.js";
import { RunStore, toRunSnapshot } from "./run-store.js";
import { runVerifierPass } from "./verifier.js";

/**
 * 实验运行器（Ticket 12 / issue #13）：把 数据集 → runReview → 审计落盘 →
 * 二遍 Verifier（消融）→ 断点续跑 的矩阵执行串成一条命令。
 *
 * 纪律：
 * - 失败隔离：单 (case, config, rep) 失败不拖垮整批——留痕（failures）继续；
 * - 断点续跑：每单元落盘记录，已完成（含计划兼容校验）即跳过；
 * - 冷热分层：单元按 case → config → rep 顺序执行，记录按 rep 升序进入指标聚合
 *   （rep1 冷单列 / rep2+ 热主口径由 T10 aggregate 实现）；
 * - 模型/消融配置变更（model、verifier）与既有记录冲突时启动即报错，不静默重跑烧钱。
 */

export interface RunnerPaths {
  /** 实验根目录（runs/<experimentId>） */
  readonly experimentRoot: string;
}

export interface ExperimentDeps {
  readonly llmClient: LlmClient;
  readonly now?: () => Date;
  /** 单元级进度回调（CLI 打印 / 测试观测；异常由运行器捕获后继续） */
  readonly onUnit?: (event: UnitEvent) => void;
}

export type UnitEvent =
  | { readonly kind: "resumed"; readonly unit: RunUnit }
  | { readonly kind: "completed"; readonly unit: RunUnit; readonly findings: number }
  | { readonly kind: "failed"; readonly unit: RunUnit; readonly message: string };

export interface RunFailure {
  readonly source: RunUnit["source"];
  readonly caseId: string;
  readonly configId: ConfigId;
  readonly rep: number;
  readonly message: string;
}

export interface ExperimentOutcome {
  readonly experimentId: string;
  readonly plan: ExperimentPlan;
  readonly expanded: ExpandedPlan;
  /** 本次调用实际执行的单元数 */
  readonly executed: number;
  /** 断点续跑跳过的单元数 */
  readonly resumed: number;
  /** 失败单元（含数据装载失败导致的缺失单元） */
  readonly failures: readonly RunFailure[];
  /** 计划内全部已完成记录（执行 + 续跑，按 (case, config) 分组、rep 升序） */
  readonly records: readonly RunRecord[];
  /** 展开入样的 case（报告与判定链的评估输入） */
  readonly cases: readonly MRCase[];
}

/** 单元执行的完整返回（记录与失败互斥；二者皆空 = 不可能路径的防御值） */
interface UnitExecution {
  readonly record: RunRecord | null;
  readonly failure: RunFailure | null;
}

/** 计划/数据集清单文件名（实验根目录内） */
export const PLAN_FILE = "plan.json";
export const CASES_FILE = "cases.json";
/** 单元失败留痕文件（--report-only 重建报告时的失败清单数据源） */
export const FAILURES_FILE = "failures.json";

/** 执行实验矩阵（含断点续跑；报告构建见 report.ts） */
export async function runExperiment(
  plan: ExperimentPlan,
  cases: readonly MRCase[],
  deps: ExperimentDeps,
  paths: RunnerPaths,
): Promise<ExperimentOutcome> {
  const expanded = expandPlan(plan, cases);
  const store = new RunStore(path.join(paths.experimentRoot, "runs"));
  await persistPlanAndCases(paths.experimentRoot, plan, expanded.cases);
  const existing = await loadCompatibleRecords(store, plan, expanded.units);
  const caseById = new Map(expanded.cases.map((mrCase) => [mrCase.caseId, mrCase]));
  const executed: RunRecord[] = [];
  const failures: RunFailure[] = [];
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
      // expandPlan 保证 units 与 cases 对齐；此分支仅防御性留痕
      failures.push(failureOf(unit, "case missing from the expanded plan"));
      continue;
    }
    const execution = await executeUnit(unit, mrCase, plan, deps, paths, store);
    if (execution.failure !== null) {
      failures.push(execution.failure);
      continue;
    }
    if (execution.record !== null) {
      executed.push(execution.record);
    }
  }
  await persistFailures(paths.experimentRoot, failures);
  const records = orderRecords([...existing.values(), ...executed], expanded.units);
  return {
    experimentId: plan.experimentId,
    plan,
    expanded,
    executed: executed.length,
    resumed,
    failures,
    records,
    cases: expanded.cases,
  };
}

/** 单元执行：runReview（基线）→ 可选二遍 Verifier → 记录落盘；失败留痕不拖垮整批 */
async function executeUnit(
  unit: RunUnit,
  mrCase: MRCase,
  plan: ExperimentPlan,
  deps: ExperimentDeps,
  paths: RunnerPaths,
  store: RunStore,
): Promise<UnitExecution> {
  const now = deps.now ?? (() => new Date());
  const auditDir = path.join(
    paths.experimentRoot,
    "audit",
    unit.source,
    sanitize(unit.caseId),
    unit.configId,
    `rep-${unit.rep}`,
  );
  try {
    const baseline = await runReview(CONFIGS[unit.configId], mrCase, deps.llmClient, {
      auditDir,
      model: plan.model,
      effort: DEFAULT_EFFORT,
    });
    const { record } = await composeRecord(unit, mrCase, plan, baseline, deps, now);
    await store.save(record);
    emit(deps, { kind: "completed", unit, findings: record.effective?.findings.length ?? record.baseline.findings.length });
    return { record, failure: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(deps, { kind: "failed", unit, message });
    return { record: null, failure: failureOf(unit, message) };
  }
}

/** 基线结果 + Verifier 消融 → RunRecord（不可变组装） */
async function composeRecord(
  unit: RunUnit,
  mrCase: MRCase,
  plan: ExperimentPlan,
  baseline: RunResult,
  deps: ExperimentDeps,
  now: () => Date,
): Promise<{ readonly record: RunRecord }> {
  const baselineSnapshot = toRunSnapshot(baseline);
  if (plan.verifier === "off") {
    return {
      record: {
        source: unit.source,
        caseId: unit.caseId,
        configId: unit.configId,
        rep: unit.rep,
        model: plan.model,
        verifier: "off",
        completedAt: now().toISOString(),
        baseline: baselineSnapshot,
        effective: null,
        verifierPass: null,
      },
    };
  }
  const pass = await runVerifierPass(mrCase, baseline.findings, deps.llmClient, {
    model: plan.model,
    effort: DEFAULT_EFFORT,
  });
  const effective: RunSnapshot = {
    ...baselineSnapshot,
    findings: pass.findings,
    usage: addUsage(baselineSnapshot.usage, pass.record.usage),
  };
  return {
    record: {
      source: unit.source,
      caseId: unit.caseId,
      configId: unit.configId,
      rep: unit.rep,
      model: plan.model,
      verifier: "on",
      completedAt: now().toISOString(),
      baseline: baselineSnapshot,
      effective,
      verifierPass: pass.record,
    },
  };
}

/**
 * 断点续跑兼容检查：读取计划内全部既有记录；
 * model / verifier 与计划不符的记录视为过期配置——启动即报错（防静默重跑烧钱）。
 */
async function loadCompatibleRecords(
  store: RunStore,
  plan: ExperimentPlan,
  units: readonly RunUnit[],
): Promise<ReadonlyMap<string, RunRecord>> {
  const byKey = new Map<string, RunRecord>();
  const stale: string[] = [];
  for (const unit of units) {
    const record = await store.read(unit);
    if (record === null) {
      continue;
    }
    if (record.model !== plan.model || record.verifier !== plan.verifier) {
      stale.push(`${record.source}/${record.caseId}/${record.configId}/rep-${record.rep}`);
      continue;
    }
    byKey.set(unitKey(unit), record);
  }
  if (stale.length > 0) {
    throw new Error(
      `experiment "${plan.experimentId}" has ${stale.length} persisted run record(s) from a different ` +
        `model/verifier configuration (e.g. ${stale.slice(0, 3).join(", ")}${stale.length > 3 ? ", ..." : ""}). ` +
        `Resume keeps cost accounting honest: use a new --id, or delete runs/${plan.experimentId}/ to start fresh.`,
    );
  }
  return byKey;
}

/** 记录按计划单元顺序整理（(case, config) 分组内 rep 升序，与展开顺序一致） */
function orderRecords(
  records: readonly RunRecord[],
  units: readonly RunUnit[],
): readonly RunRecord[] {
  const byKey = new Map(records.map((record) => [recordKey(record), record]));
  const ordered: RunRecord[] = [];
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

export function unitKey(unit: RunUnit): string {
  return `${unit.source}/${unit.caseId}/${unit.configId}/rep-${unit.rep}`;
}

function recordKey(record: RunRecord): string {
  return `${record.source}/${record.caseId}/${record.configId}/rep-${record.rep}`;
}

function failureOf(unit: RunUnit, message: string): RunFailure {
  return {
    source: unit.source,
    caseId: unit.caseId,
    configId: unit.configId,
    rep: unit.rep,
    message,
  };
}

function emit(deps: ExperimentDeps, event: UnitEvent): void {
  try {
    deps.onUnit?.(event);
  } catch {
    // 进度回调异常不拖垮实验（留痕义务在运行器本身）
  }
}

function sanitize(caseId: string): string {
  return caseId.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/** plan.json + cases.json 的首次落盘；已存在时校验一致性（防同 id 异数据集静默混跑） */
async function persistPlanAndCases(
  experimentRoot: string,
  plan: ExperimentPlan,
  cases: readonly MRCase[],
): Promise<void> {
  await writeJsonIfAbsent(
    path.join(experimentRoot, PLAN_FILE),
    { ...plan, caseIds: cases.map((mrCase) => mrCase.caseId) },
  );
  const persisted = await readJsonFile(path.join(experimentRoot, CASES_FILE));
  if (persisted === null) {
    await writeJsonFile(path.join(experimentRoot, CASES_FILE), cases);
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
      `experiment "${plan.experimentId}" already has ${CASES_FILE} for a different case set ` +
        `(${persistedIds.size} persisted vs ${incomingIds.size} incoming). ` +
        "Resume requires the same dataset selection: use a new --id, or delete the experiment directory.",
    );
  }
}

/** 失败留痕落盘（每次运行覆盖为最新状态：此前失败、现已续跑成功的单元不再计入） */
async function persistFailures(experimentRoot: string, failures: readonly RunFailure[]): Promise<void> {
  try {
    await writeJsonFile(path.join(experimentRoot, FAILURES_FILE), failures);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to persist ${FAILURES_FILE}: ${message}`, { cause: error });
  }
}

/** 已有实验目录的重建入口：读 plan.json（报告/续跑的离线数据源） */
export async function loadPersistedPlan(experimentRoot: string): Promise<ExperimentPlan> {
  const raw = await readJsonFile(path.join(experimentRoot, PLAN_FILE));
  if (raw === null) {
    throw new Error(
      `no ${PLAN_FILE} found under ${experimentRoot}: run the experiment first (or check the --id)`,
    );
  }
  return raw as ExperimentPlan;
}

/** 已有实验目录的重建入口：读 cases.json（判定链与人工抽检的评估输入） */
export async function loadPersistedCases(experimentRoot: string): Promise<readonly MRCase[]> {
  const raw = await readJsonFile(path.join(experimentRoot, CASES_FILE));
  if (raw === null || !Array.isArray(raw)) {
    throw new Error(`no ${CASES_FILE} found under ${experimentRoot}: run the experiment first`);
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
