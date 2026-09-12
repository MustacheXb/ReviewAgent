import { stat } from "node:fs/promises";
import path from "node:path";
import type { MRCase } from "../contracts/mr-case.js";
import { runUnitKeyString } from "../contracts/run-unit.js";
import type { GateSideInput, GateUnitSample } from "../metrics/alignment-gate.js";
import { evaluateRun, flattenRunMetrics } from "../metrics/index.js";
import { readJsonFile } from "../shared/report-io.js";
import { recordToRunResult, RunStore } from "./run-store.js";

/**
 * 对齐门加载器（#31）：实验 run 目录 → 门的一侧输入。
 *
 * 目录契约（experiment runner 落盘口径）：
 * - `<runDir>/cases.json`：MRCase[]（本侧参与评估的全部 case）；
 * - `<runDir>/runs/<source>/<caseId>/<configId>/rep-<rep>.json`：RunStore 记录树。
 *
 * 指标管线与实验报告同径：recordToRunResult（effective 优先）→ evaluateRun →
 * flattenRunMetrics。单元键 = runUnitKeyString（contracts/run-unit 的稳定键形
 * `${source}/${caseId}/${configId}/rep-${rep}`，与断点续跑/报告分组共用），
 * 配对检验按键跨侧匹配。执行窗 = 记录 completedAt 的 min/max（runner 落盘恒为
 * toISOString 的定宽 UTC，字典序即时间序）。
 *
 * 损坏记录不静默丢弃：readAll 的 skippedFiles 非空即 fail fast（列出文件）。
 */

export async function loadGateSide(runDir: string): Promise<GateSideInput> {
  if (typeof runDir !== "string" || runDir.trim().length === 0) {
    throw new Error("runDir must be a non-empty path");
  }
  const root = path.resolve(runDir);
  try {
    await stat(root);
  } catch {
    throw new Error(`run directory does not exist: ${root}`);
  }

  const casesPath = path.join(root, "cases.json");
  const parsed = await readJsonFile(casesPath);
  if (parsed === null) {
    throw new Error(`cases file not found: ${casesPath} (expected a run directory with cases.json + runs/)`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`cases file must be a non-empty array of MRCase: ${casesPath}`);
  }
  const caseById = new Map<string, MRCase>();
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null || typeof (entry as MRCase).caseId !== "string") {
      throw new Error(`cases file entries must be MRCase objects: ${casesPath}`);
    }
    const mrCase = entry as MRCase;
    if (caseById.has(mrCase.caseId)) {
      throw new Error(`duplicate caseId "${mrCase.caseId}" in cases file: ${casesPath}`);
    }
    caseById.set(mrCase.caseId, mrCase);
  }

  const store = new RunStore(path.join(root, "runs"));
  const { records, skippedFiles } = await store.readAll();
  if (skippedFiles.length > 0) {
    throw new Error(`corrupt run records (not silently dropped): ${skippedFiles.join(", ")}`);
  }
  if (records.length === 0) {
    throw new Error(`no run records found under ${path.join(root, "runs")}`);
  }

  const units: GateUnitSample[] = [];
  let windowFirst: string | null = null;
  let windowLast: string | null = null;
  for (const record of records) {
    const mrCase = caseById.get(record.caseId);
    if (mrCase === undefined) {
      throw new Error(`run record caseId "${record.caseId}" (${record.source}) not found in ${casesPath}`);
    }
    const metrics = evaluateRun(recordToRunResult(record), mrCase);
    units.push({
      unitKey: runUnitKeyString(record),
      configId: record.configId,
      flat: flattenRunMetrics(metrics),
    });
    if (windowFirst === null || record.completedAt < windowFirst) {
      windowFirst = record.completedAt;
    }
    if (windowLast === null || record.completedAt > windowLast) {
      windowLast = record.completedAt;
    }
  }

  return {
    name: path.basename(root),
    units,
    ...(windowFirst !== null && windowLast !== null ? { window: { first: windowFirst, last: windowLast } } : {}),
  };
}
