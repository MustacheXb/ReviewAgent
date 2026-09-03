/**
 * MCR-Bench 校准适配器（Ticket 11 / issue #12；spec #1 user story 24）。
 *
 * 数据事实（官方仓库 DeepSoftwareAnalytics/MCR-bench 2026-09-03 逐字段核验）：
 * - dataset/java.jsonl：556 task（= 148 唯一 PR × 检视轮次）；round1 子集 148 条与
 *   「review 初始 diff」同构，是 POC1 校准的默认子集；共 1,386 张缺陷卡
 *   （taxonomy 13 细类、severity 六级、location.file/lines 可为 "unknown"）。
 * - generated_results/<model>/<lang>/<lang>_responses.jsonl：7 个被评模型的输出，
 *   每行 {task_id, generated_results: {task_id, round_id, defects: [...]}}，
 *   缺陷卡与 ground truth 同构（defect_id/title/description/location）。
 * - evaluation/Metric/LLM_responses/<model>/<lang>/<lang>_evaluation_results.jsonl：
 *   官方 judge 判定，每行 {task_id, tp, fp, fn, tn, precision, recall, f1,
 *   matches: [{model_defect_index, ground_truth_defect_index, match_confidence,
 *   match_reason}], unmatched_ground_truth, unmatched_model}（索引 1 起）。
 *
 * 校准样例构造纪律：judge 信息面与官方 judge 严格一致（缺陷卡只保留
 * id/title/description，不带 location/taxonomy/severity、不带 diff）——
 * 一致性比较度量的是「我们的协议移植」而非「信息面差异」。
 * lines 字段为字符串（实测形态："86" / "58-84" / "314, 356" / "unknown"），
 * 解析容忍未知形态（返回 null，不 fail）。
 */

import type {
  JudgeFindingCard,
  JudgeRequest,
  JudgeTruthCard,
} from "../judge/contracts.js";

/** MCR 缺陷卡（dataset 与 generated_results 同构） */
export interface McrDefectCard {
  readonly defectId: string;
  readonly title: string;
  readonly description: string;
  readonly taxonomy: string | null;
  readonly severity: string | null;
  readonly file: string | null;
  readonly lineStart: number | null;
  readonly lineEnd: number | null;
}

/** dataset/java.jsonl 的一行（一个 task = 一个 PR 的一轮检视） */
export interface McrTaskRecord {
  readonly taskId: string;
  readonly prTitle: string | null;
  readonly prDescription: string | null;
  readonly diff: string | null;
  readonly defects: readonly McrDefectCard[];
}

/** generated_results 的一行（某模型在某 task 上的输出缺陷卡） */
export interface McrModelOutputRecord {
  readonly taskId: string;
  readonly defects: readonly McrDefectCard[];
}

/** 官方 judge 判定的一行（索引 1 起，原样保留官方口径） */
export interface McrOfficialMatch {
  readonly modelDefectIndex: number;
  readonly groundTruthDefectIndex: number | null;
  readonly matchConfidence: string | null;
  readonly matchReason: string | null;
}

export interface McrOfficialJudgment {
  readonly taskId: string;
  readonly tp: number | null;
  readonly fp: number | null;
  readonly fn: number | null;
  readonly matches: readonly McrOfficialMatch[];
  readonly unmatchedModel: readonly number[];
  readonly unmatchedGroundTruth: readonly number[];
}

/** 一个校准样例 = 某 task × 某模型的 (judge 请求, 官方判定) 对 */
export interface CalibrationSample {
  readonly taskId: string;
  readonly modelName: string;
  readonly request: JudgeRequest;
  readonly official: McrOfficialJudgment;
}

export interface McrDatasetParseOptions {
  /** 只保留这些轮次（task_id 后缀 "_roundN"）；缺省 ["round1"]（单轮检视同构子集） */
  readonly rounds?: readonly string[];
}

export interface McrParseResult<T> {
  readonly records: readonly T[];
  /** 解析失败被跳过的行数（有界失败，不中断） */
  readonly skippedLines: number;
  /** 因轮次过滤被排除的行数（仅 dataset 解析有意义，其余为 0） */
  readonly roundFilteredLines: number;
}

const DEFAULT_ROUNDS: readonly string[] = ["round1"];

/** 解析 dataset/<lang>.jsonl（ground truth 侧） */
export function parseMcrDataset(
  text: string,
  options: McrDatasetParseOptions = {},
): McrParseResult<McrTaskRecord> {
  const rounds = options.rounds ?? DEFAULT_ROUNDS;
  return parseJsonl(text, (value) => {
    const taskId = requiredString(value.task_id, "task_id");
    const groundTruth = asRecord(value.ground_truth, "ground_truth");
    const defects = parseDefectCards(groundTruth.defects);
    const codeDiff = value.code_diff === undefined ? undefined : asRecord(value.code_diff, "code_diff");
    return {
      taskId,
      prTitle: optionalString(value.pr_title),
      prDescription: optionalString(value.pr_description),
      diff: codeDiff === undefined ? null : optionalString(codeDiff.diff) ?? null,
      defects,
    };
  }, rounds);
}

/** 解析 generated_results/<model>/<lang>/<lang>_responses.jsonl（模型输出侧） */
export function parseMcrModelOutputs(text: string): McrParseResult<McrModelOutputRecord> {
  return parseJsonl(text, (value) => {
    const taskId = requiredString(value.task_id, "task_id");
    const generated = asRecord(value.generated_results, "generated_results");
    const defects = parseDefectCards(generated.defects);
    return { taskId, defects };
  });
}

/** 解析 LLM_responses/<model>/<lang>/<lang>_evaluation_results.jsonl（官方判定侧） */
export function parseMcrOfficialJudgments(text: string): McrParseResult<McrOfficialJudgment> {
  return parseJsonl(text, (value) => {
    const taskId = requiredString(value.task_id, "task_id");
    return {
      taskId,
      tp: optionalCount(value.tp),
      fp: optionalCount(value.fp),
      fn: optionalCount(value.fn),
      matches: parseOfficialMatches(value.matches),
      unmatchedModel: parseIndexList(value.unmatched_model),
      unmatchedGroundTruth: parseIndexList(value.unmatched_ground_truth),
    };
  });
}

/**
 * 组装校准样例：tasks × outputs × judgments 按 taskId 对齐；
 * 缺任一侧或缺官方判定的 task 跳过并计数（有界失败）。
 * 空缺陷侧（模型零输出或真值零卡）也跳过——官方脚本对此类 task 走 TN/平凡分支，
 * 不构成 judge 一致性信息。
 */
export function buildCalibrationSamples(input: {
  readonly modelName: string;
  readonly tasks: readonly McrTaskRecord[];
  readonly outputs: readonly McrModelOutputRecord[];
  readonly judgments: readonly McrOfficialJudgment[];
}): { readonly samples: readonly CalibrationSample[]; readonly skippedTasks: number } {
  const outputsByTask = new Map(input.outputs.map((record) => [record.taskId, record]));
  const judgmentsByTask = new Map(input.judgments.map((record) => [record.taskId, record]));
  const samples: CalibrationSample[] = [];
  let skippedTasks = 0;
  for (const task of input.tasks) {
    const output = outputsByTask.get(task.taskId);
    const judgment = judgmentsByTask.get(task.taskId);
    if (
      output === undefined ||
      judgment === undefined ||
      task.defects.length === 0 ||
      output.defects.length === 0
    ) {
      skippedTasks++;
      continue;
    }
    samples.push({
      taskId: task.taskId,
      modelName: input.modelName,
      request: {
        caseId: task.taskId,
        truths: task.defects.map(defectToTruthCard),
        findings: output.defects.map(defectToFindingCard),
        // 信息面纪律：与官方 judge 严格一致（无 diff、无 location、无 taxonomy/severity）
        context: null,
      },
      official: judgment,
    });
  }
  return { samples, skippedTasks };
}

/**
 * 类别分布参照（spec #1 user story 24：检视类别分布参照）：
 * taxonomy × severity 计数（对齐 POC1 Finding Schema 的类别/严重级设计参考）。
 */
export function mcrCategoryDistribution(
  tasks: readonly McrTaskRecord[],
): { readonly taxonomy: Readonly<Record<string, number>>; readonly severity: Readonly<Record<string, number>> } {
  const taxonomy: Record<string, number> = {};
  const severity: Record<string, number> = {};
  for (const task of tasks) {
    for (const defect of task.defects) {
      if (defect.taxonomy !== null) {
        taxonomy[defect.taxonomy] = (taxonomy[defect.taxonomy] ?? 0) + 1;
      }
      if (defect.severity !== null) {
        severity[defect.severity] = (severity[defect.severity] ?? 0) + 1;
      }
    }
  }
  return { taxonomy, severity };
}

// ===== 内部解析 =====

function parseJsonl<T>(
  text: string,
  map: (value: Record<string, unknown>) => T,
  rounds?: readonly string[],
): McrParseResult<T> {
  if (typeof text !== "string") {
    throw new Error("text must be a string (MCR-Bench jsonl content)");
  }
  const records: T[] = [];
  let skippedLines = 0;
  let roundFilteredLines = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      skippedLines++;
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      skippedLines++;
      continue;
    }
    let record: T;
    try {
      record = map(parsed as Record<string, unknown>);
    } catch {
      skippedLines++;
      continue;
    }
    if (rounds !== undefined && !rounds.some((round) => recordTaskId(record).endsWith(`_${round}`))) {
      roundFilteredLines++;
      continue;
    }
    records.push(record);
  }
  return { records, skippedLines, roundFilteredLines };
}

function recordTaskId(record: unknown): string {
  if (typeof record === "object" && record !== null) {
    const taskId = (record as { readonly taskId?: unknown }).taskId;
    if (typeof taskId === "string") {
      return taskId;
    }
  }
  return "";
}

function parseDefectCards(value: unknown): readonly McrDefectCard[] {
  if (!Array.isArray(value)) {
    throw new Error("defects must be an array");
  }
  return value.map((entry) => {
    const record = asRecord(entry, "defect");
    const location = asRecord(record.location, "defect.location");
    const lines = parseLineRange(location.lines);
    return {
      defectId: requiredString(record.defect_id, "defect.defect_id"),
      title: requiredString(record.title, "defect.title"),
      description: requiredString(record.description, "defect.description"),
      taxonomy: optionalString(record.taxonomy),
      severity: optionalString(record.severity),
      file: normalizeUnknown(location.file),
      lineStart: lines?.lineStart ?? null,
      lineEnd: lines?.lineEnd ?? null,
    };
  });
}

/** lines 字符串形态解析："unknown"→null；"86"→单行；"58-84"→区间；"314, 356"→min-max */
export function parseLineRange(raw: unknown): { readonly lineStart: number; readonly lineEnd: number } | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === "unknown") {
    return null;
  }
  const numbers = trimmed
    .split(/[-,\s]+/)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isInteger(part) && part > 0);
  if (numbers.length === 0) {
    return null;
  }
  return { lineStart: Math.min(...numbers), lineEnd: Math.max(...numbers) };
}

function parseOfficialMatches(value: unknown): readonly McrOfficialMatch[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("matches must be an array");
  }
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const modelIndex = optionalIndex(record.model_defect_index);
    if (modelIndex === null) {
      return [];
    }
    const groundTruthRaw = record.ground_truth_defect_index;
    return [
      {
        modelDefectIndex: modelIndex,
        groundTruthDefectIndex: optionalIndex(groundTruthRaw),
        matchConfidence: optionalString(record.match_confidence),
        matchReason: optionalString(record.match_reason),
      },
    ];
  });
}

function parseIndexList(value: unknown): readonly number[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("index list must be an array");
  }
  return value.flatMap((entry) => {
    const index = optionalIndex(entry);
    return index === null ? [] : [index];
  });
}

function defectToTruthCard(defect: McrDefectCard): JudgeTruthCard {
  return {
    id: defect.defectId,
    title: defect.title,
    description: defect.description,
    file: null,
    lineStart: null,
    lineEnd: null,
    category: null,
    severity: null,
  };
}

function defectToFindingCard(defect: McrDefectCard): JudgeFindingCard {
  return {
    id: defect.defectId,
    title: defect.title,
    description: defect.description,
    file: null,
    line: null,
    category: null,
    evidence: [],
  };
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeUnknown(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.toLowerCase() === "unknown" ? null : trimmed;
}

/** tp/fp/fn 计数校验（≥ 0 合法；0 不是索引，不得按 1 起索引规则拒绝） */
function optionalCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

/** 1 起索引校验（官方口径）；非正整数返回 null */
function optionalIndex(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return null;
  }
  return value;
}
