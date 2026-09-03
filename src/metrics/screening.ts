import type { Finding } from "../contracts/finding.js";
import type { MRTruth, TruthLocation } from "../contracts/mr-case.js";
import { isDefectNature } from "../dataset/defect-nature.js";
import type {
  FindingVerdict,
  ScreeningCounts,
  ScreeningOptions,
  ScreeningResult,
  TruthMiss,
} from "./types.js";
import { DEFAULT_SCREENING_OPTIONS } from "./types.js";

/**
 * 规则粗筛（判定链第一级：原生真值 → 【规则粗筛】→ LLM judge → 人工抽检）。
 * Finding × TruthLocation 匹配口径（显式定义，测试锁定）：
 * 1. 文件匹配：路径归一后字符串相等（\ → /、去 "./"、去 diff 的 "a/"|"b/" 前缀、折叠重复 /）；
 * 2. 行位匹配：finding.line 落在 [lineStart - tol, lineEnd + tol]（tol = lineTolerance，默认 0）；
 * 3. 性质匹配：category 与 defectNature 归一（trim + 大写 + 别名表）后相等；
 *    词表 = DEFECT_NATURES（T02 权威定义，TruthLocation.defectNature 与 Finding.category 同词表）。
 *    真值侧校验词表成员资格（fail fast）；Finding 侧容忍词表外类别（LLM 输出自由词表，
 *    词表外类别不参与匹配，记 NO_NATURE_MATCH）。
 * line-level = 1 ∧ 2 ∧ 3；file-level = 1 ∧ 3（仅去掉行位约束）。
 * 一对一贪心占用：每个真值位置至多被一个 Finding 占用（TP），
 * 先做区间内精确占用（offset 0），再做容差带占用（确定性按下标顺序）。
 */

/** 文件路径归一：统一分隔符、去 "./" 前缀、去 unified diff 的 a/ b/ 前缀、折叠重复斜杠（可重复出现，迭代剥净） */
export function normalizeFilePath(rawPath: string): string {
  let normalized = rawPath.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  let changed = true;
  while (changed) {
    changed = false;
    while (normalized.startsWith("./")) {
      normalized = normalized.slice(2);
      changed = true;
    }
    if (normalized.startsWith("a/") || normalized.startsWith("b/")) {
      normalized = normalized.slice(2);
      changed = true;
    }
  }
  return normalized;
}

/** 构建归一后的性质别名查找表（键值均 trim + 大写） */
export function buildAliasLookup(
  aliases: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const lookup: Record<string, string> = {};
  for (const [key, value] of Object.entries(aliases)) {
    lookup[key.trim().toUpperCase()] = value.trim().toUpperCase();
  }
  return lookup;
}

/** 性质归一：trim + 大写 + 别名表映射（未命中恒等） */
export function canonicalNature(
  raw: string,
  aliasLookup: Readonly<Record<string, string>>,
): string {
  const normalized = raw.trim().toUpperCase();
  const mapped = aliasLookup[normalized];
  return mapped === undefined ? normalized : mapped;
}

interface NormalizedLocation {
  readonly truthIndex: number;
  readonly normalizedFile: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly defectNature: string;
}

/** 规则粗筛主入口（纯函数） */
export function screenFindings(
  findings: readonly Finding[],
  truth: MRTruth | null,
  options: ScreeningOptions = DEFAULT_SCREENING_OPTIONS,
): ScreeningResult {
  validateScreeningOptions(options);
  validateFindings(findings);
  if (truth === null) {
    return screenCleanMr(findings);
  }
  validateTruth(truth);
  const aliasLookup = buildAliasLookup(options.natureAliases);
  const locations = normalizeLocations(truth.locations);
  const verdicts = assignVerdicts(findings, locations, options, aliasLookup);
  const misses = collectMisses(locations, verdicts);
  return {
    cleanMr: false,
    verdicts,
    misses,
    lineLevel: {
      tp: countOutcome(verdicts, "TP"),
      fp: countOutcome(verdicts, "FP"),
      fn: misses.length,
    },
    fileLevel: countFileLevel(findings, locations, aliasLookup),
  };
}

/** clean MR（truth = null）阴性对照口径：每个 Finding 记为 FP，无漏检 */
function screenCleanMr(findings: readonly Finding[]): ScreeningResult {
  const verdicts = findings.map((finding) => ({
    findingId: finding.id,
    outcome: "FP" as const,
    matchedTruthIndex: null,
    lineOffset: null,
    fpReason: "CLEAN_MR" as const,
    withinTolerance: false,
  }));
  return {
    cleanMr: true,
    verdicts,
    misses: [],
    lineLevel: { tp: 0, fp: findings.length, fn: 0 },
    fileLevel: { tp: 0, fp: findings.length, fn: 0 },
  };
}

function normalizeLocations(locations: readonly TruthLocation[]): readonly NormalizedLocation[] {
  return locations.map((location, index) => ({
    truthIndex: index,
    normalizedFile: normalizeFilePath(location.file),
    lineStart: location.lineStart,
    lineEnd: location.lineEnd,
    defectNature: location.defectNature,
  }));
}

interface LineMatch {
  readonly truthIndex: number;
  readonly lineOffset: number;
}

/** 一对一贪心占用：先区间内精确命中，再容差带命中；均按 finding 与真值下标顺序 */
function assignVerdicts(
  findings: readonly Finding[],
  locations: readonly NormalizedLocation[],
  options: ScreeningOptions,
  aliasLookup: Readonly<Record<string, string>>,
): readonly FindingVerdict[] {
  const claimed = locations.map(() => false);
  const matches: (LineMatch | null)[] = findings.map(() => null);
  assignExactInterval(findings, locations, aliasLookup, claimed, matches);
  assignToleranceBand(findings, locations, options, aliasLookup, claimed, matches);
  return findings.map((finding, index) => {
    const match = matches[index];
    if (match === null || match === undefined) {
      return fpVerdict(finding, locations, options, aliasLookup);
    }
    return {
      findingId: finding.id,
      outcome: "TP" as const,
      matchedTruthIndex: match.truthIndex,
      lineOffset: match.lineOffset,
      fpReason: null,
      withinTolerance: match.lineOffset > 0,
    };
  });
}

function assignExactInterval(
  findings: readonly Finding[],
  locations: readonly NormalizedLocation[],
  aliasLookup: Readonly<Record<string, string>>,
  claimed: boolean[],
  matches: (LineMatch | null)[],
): void {
  for (let f = 0; f < findings.length; f++) {
    const finding = findings[f];
    if (finding === undefined) {
      continue;
    }
    for (let t = 0; t < locations.length; t++) {
      const location = locations[t];
      if (location === undefined || claimed[t]) {
        continue;
      }
      if (!matchesOnFileAndNature(finding, location, aliasLookup)) {
        continue;
      }
      if (lineOffset(finding.line, location, 0) === 0) {
        claimed[t] = true;
        matches[f] = { truthIndex: t, lineOffset: 0 };
        break;
      }
    }
  }
}

function assignToleranceBand(
  findings: readonly Finding[],
  locations: readonly NormalizedLocation[],
  options: ScreeningOptions,
  aliasLookup: Readonly<Record<string, string>>,
  claimed: boolean[],
  matches: (LineMatch | null)[],
): void {
  if (options.lineTolerance === 0) {
    return;
  }
  for (let f = 0; f < findings.length; f++) {
    const finding = findings[f];
    if (finding === undefined || matches[f] !== null) {
      continue;
    }
    for (let t = 0; t < locations.length; t++) {
      const location = locations[t];
      if (location === undefined || claimed[t]) {
        continue;
      }
      if (!matchesOnFileAndNature(finding, location, aliasLookup)) {
        continue;
      }
      const offset = lineOffset(finding.line, location, options.lineTolerance);
      if (offset !== null) {
        claimed[t] = true;
        matches[f] = { truthIndex: t, lineOffset: offset };
        break;
      }
    }
  }
}

/** 行位偏差：命中区间（含容差）返回偏移行数（区间内为 0），未命中返回 null */
function lineOffset(
  line: number,
  location: NormalizedLocation,
  tolerance: number,
): number | null {
  if (line < location.lineStart - tolerance || line > location.lineEnd + tolerance) {
    return null;
  }
  if (line < location.lineStart) {
    return location.lineStart - line;
  }
  if (line > location.lineEnd) {
    return line - location.lineEnd;
  }
  return 0;
}

function matchesOnFileAndNature(
  finding: Finding,
  location: NormalizedLocation,
  aliasLookup: Readonly<Record<string, string>>,
): boolean {
  const fileMatch = normalizeFilePath(finding.file) === location.normalizedFile;
  const natureMatch =
    canonicalNature(finding.category, aliasLookup) ===
    canonicalNature(location.defectNature, aliasLookup);
  return fileMatch && natureMatch;
}

/** 未命中 Finding 的 FP 归因：文件 → 性质 → 行位/占用，取最具体的失败原因 */
function fpVerdict(
  finding: Finding,
  locations: readonly NormalizedLocation[],
  options: ScreeningOptions,
  aliasLookup: Readonly<Record<string, string>>,
): FindingVerdict {
  const candidates = locations.filter((location) =>
    matchesOnFileAndNature(finding, location, aliasLookup),
  );
  let reason: FindingVerdict["fpReason"];
  const fileMatched = locations.some(
    (location) => normalizeFilePath(finding.file) === location.normalizedFile,
  );
  if (!fileMatched) {
    reason = "NO_FILE_MATCH";
  } else if (candidates.length === 0) {
    reason = "NO_NATURE_MATCH";
  } else if (
    candidates.some((location) => lineOffset(finding.line, location, options.lineTolerance) !== null)
  ) {
    reason = "DUPLICATE";
  } else {
    reason = "NO_LINE_MATCH";
  }
  return {
    findingId: finding.id,
    outcome: "FP",
    matchedTruthIndex: null,
    lineOffset: null,
    fpReason: reason,
    withinTolerance: false,
  };
}

/** file-level 计数（文件 ∧ 性质，一对一贪心占用；口径 = line-level 去掉行位约束） */
function countFileLevel(
  findings: readonly Finding[],
  locations: readonly NormalizedLocation[],
  aliasLookup: Readonly<Record<string, string>>,
): ScreeningCounts {
  const claimed = locations.map(() => false);
  let tp = 0;
  for (const finding of findings) {
    for (let t = 0; t < locations.length; t++) {
      const location = locations[t];
      if (location === undefined || claimed[t]) {
        continue;
      }
      if (matchesOnFileAndNature(finding, location, aliasLookup)) {
        claimed[t] = true;
        tp += 1;
        break;
      }
    }
  }
  return { tp, fp: findings.length - tp, fn: locations.length - tp };
}

function collectMisses(
  locations: readonly NormalizedLocation[],
  verdicts: readonly FindingVerdict[],
): readonly TruthMiss[] {
  const matched = new Set(
    verdicts
      .map((verdict) => verdict.matchedTruthIndex)
      .filter((index): index is number => index !== null),
  );
  return locations.flatMap((location) =>
    matched.has(location.truthIndex)
      ? []
      : [
          {
            truthIndex: location.truthIndex,
            file: location.normalizedFile,
            lineStart: location.lineStart,
            lineEnd: location.lineEnd,
            defectNature: location.defectNature,
          },
        ],
  );
}

function countOutcome(verdicts: readonly FindingVerdict[], outcome: "TP" | "FP"): number {
  return verdicts.filter((verdict) => verdict.outcome === outcome).length;
}

// ===== 输入校验（fail fast，错误指明字段与期望） =====

export function validateScreeningOptions(options: ScreeningOptions): void {
  if (typeof options !== "object" || options === null) {
    throw new Error("options must be a ScreeningOptions object");
  }
  if (!Number.isInteger(options.lineTolerance) || options.lineTolerance < 0) {
    throw new Error(
      `options.lineTolerance must be an integer >= 0 (got ${JSON.stringify(options.lineTolerance)})`,
    );
  }
  if (typeof options.natureAliases !== "object" || options.natureAliases === null) {
    throw new Error("options.natureAliases must be a Record<string, string>");
  }
  for (const [key, value] of Object.entries(options.natureAliases)) {
    if (typeof value !== "string" || key.trim().length === 0 || value.trim().length === 0) {
      throw new Error("options.natureAliases must map non-empty strings to non-empty strings");
    }
  }
}

/** 校验粗筛消费的 Finding 字段（id / file / line / category） */
export function validateFindings(findings: readonly Finding[]): void {
  if (!Array.isArray(findings)) {
    throw new Error("findings must be an array of Finding");
  }
  findings.forEach((finding, index) => {
    if (typeof finding !== "object" || finding === null) {
      throw new Error(`findings[${index}] must be a Finding object`);
    }
    requireNonEmptyString(finding.id, `findings[${index}].id`);
    requireNonEmptyString(finding.file, `findings[${index}].file`);
    requireNonEmptyString(finding.category, `findings[${index}].category`);
    if (!Number.isInteger(finding.line) || finding.line < 1) {
      throw new Error(
        `findings[${index}].line must be an integer >= 1 (got ${JSON.stringify(finding.line)})`,
      );
    }
  });
}

/** 校验真值位置（file / defectNature / 行区间）；clean MR 走 truth = null，不经过此处 */
export function validateTruth(truth: MRTruth): void {
  if (typeof truth !== "object" || truth === null) {
    throw new Error("truth must be an MRTruth object or null");
  }
  if (!Array.isArray(truth.locations) || truth.locations.length === 0) {
    throw new Error("truth.locations must be a non-empty array (clean MR uses truth = null)");
  }
  truth.locations.forEach((location, index) => {
    if (typeof location !== "object" || location === null) {
      throw new Error(`truth.locations[${index}] must be a TruthLocation object`);
    }
    requireNonEmptyString(location.file, `truth.locations[${index}].file`);
    requireVocabularyNature(location.defectNature, index);
    if (!Number.isInteger(location.lineStart) || location.lineStart < 1) {
      throw new Error(
        `truth.locations[${index}].lineStart must be an integer >= 1 (got ${JSON.stringify(location.lineStart)})`,
      );
    }
    if (!Number.isInteger(location.lineEnd) || location.lineEnd < 1) {
      throw new Error(
        `truth.locations[${index}].lineEnd must be an integer >= 1 (got ${JSON.stringify(location.lineEnd)})`,
      );
    }
    if (location.lineStart > location.lineEnd) {
      throw new Error(
        `truth.locations[${index}].lineStart (${location.lineStart}) must be <= lineEnd (${location.lineEnd})`,
      );
    }
  });
}

/**
 * 真值性质必须是共享词表（DEFECT_NATURES）成员（大小写与首尾空白不敏感）。
 * 真值是 T02 构造产物、词表有保证，越界即数据错误，fail fast。
 */
function requireVocabularyNature(defectNature: string, index: number): void {
  requireNonEmptyString(defectNature, `truth.locations[${index}].defectNature`);
  const normalized = defectNature.trim().toUpperCase();
  if (!isDefectNature(normalized)) {
    throw new Error(
      `truth.locations[${index}].defectNature "${defectNature}" is not in the shared DEFECT_NATURES vocabulary`,
    );
  }
}

function requireNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}
