/**
 * Judge 响应解析与裁定归一（纯函数）。
 *
 * JSON 提取策略（移植官方 call_llm.parse_llm_json_response 并加固）：
 * 1. 直接 JSON.parse；2. 剥 ```json 围栏；3. 取首个 "{" 到末个 "}" 的子串再试。
 * 全部失败 → GptJudgeResponseFormatError（有界失败：调用方回退规则口径，不崩溃）。
 *
 * 归一：线上 1 起索引 → 内部 0 起索引；逐条校验形状（索引整数且在界、confidence
 * 词表成员、reason 字符串），非法条目丢弃并记 anomaly（有界失败），不整单报废。
 */

import type { JudgeAdjudication, JudgeMatch, MatchConfidence } from "./contracts.js";
import { GptJudgeResponseFormatError } from "./errors.js";

/** 官方线上裁定 JSON 的条目形状（1 起索引；ground_truth_defect_index null = 无匹配） */
export interface WireJudgeMatchEntry {
  readonly model_defect_index?: unknown;
  readonly ground_truth_defect_index?: unknown;
  readonly match_confidence?: unknown;
  readonly match_reason?: unknown;
}

export interface WireJudgeResponse {
  readonly matches?: unknown;
  readonly unmatched_ground_truth?: unknown;
  readonly summary?: unknown;
}

const CONFIDENCE_VALUES: ReadonlySet<string> = new Set(["high", "medium", "low", "none"]);

/** 提取 LLM 回复中的 JSON 对象文本（容忍围栏与前后杂文；失败返回 null） */
export function extractJudgeJsonText(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const candidates = [stripCodeFence(trimmed)];
  const braceStart = trimmed.indexOf("{");
  const braceEnd = trimmed.lastIndexOf("}");
  if (braceStart >= 0 && braceEnd > braceStart) {
    candidates.push(stripCodeFence(trimmed.slice(braceStart, braceEnd + 1)));
  }
  for (const candidate of candidates) {
    if (candidate.trim().startsWith("{")) {
      return candidate;
    }
  }
  return null;
}

function stripCodeFence(text: string): string {
  const withoutLeading = text.replace(/^```(?:json)?\s*\n?/, "");
  return withoutLeading.replace(/\n?```\s*$/, "");
}

/** 解析 LLM 回复为归一裁定（形状不符显式抛 GptJudgeResponseFormatError） */
export function parseJudgeAdjudication(raw: string): JudgeAdjudication {
  const jsonText = extractJudgeJsonText(raw);
  if (jsonText === null) {
    throw new GptJudgeResponseFormatError(
      `judge response contains no JSON object: ${summarizeText(raw)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch (error) {
    throw new GptJudgeResponseFormatError(
      `judge response is not valid JSON: ${summarizeText(jsonText)}`,
      { cause: error },
    );
  }
  return validateAdjudicationShape(parsed);
}

function validateAdjudicationShape(parsed: unknown): JudgeAdjudication {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GptJudgeResponseFormatError("judge response must be a JSON object");
  }
  const record = parsed as WireJudgeResponse;
  if (record.matches === undefined || record.matches === null) {
    throw new GptJudgeResponseFormatError('judge response must contain a "matches" array');
  }
  if (!Array.isArray(record.matches)) {
    throw new GptJudgeResponseFormatError('"matches" must be an array');
  }
  const matches: JudgeMatch[] = [];
  record.matches.forEach((entry) => {
    const match = normalizeMatchEntry(entry);
    if (match !== null) {
      matches.push(match);
    }
  });
  return {
    matches,
    summary: normalizeSummary(record.summary),
  };
}

/** 单条 match 条目归一；非法条目返回 null（调用方丢弃并记 anomaly） */
export function normalizeMatchEntry(entry: unknown): JudgeMatch | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return null;
  }
  const record = entry as WireJudgeMatchEntry;
  const findingIndex = asIndex(record.model_defect_index);
  if (findingIndex === null) {
    return null;
  }
  const confidence = asConfidence(record.match_confidence);
  if (confidence === null) {
    return null;
  }
  const truthRaw = record.ground_truth_defect_index;
  let truthIndex: number | null;
  if (truthRaw === null || truthRaw === undefined) {
    // null / 缺失的 truth 索引 = 显式拒绝条目（协议字段描述）
    truthIndex = null;
  } else {
    const normalized = asIndex(truthRaw);
    if (normalized === null) {
      // 索引存在但非法（非正整数）→ 条目整体非法，不得伪装成拒绝
      return null;
    }
    truthIndex = normalized;
  }
  const reason = typeof record.match_reason === "string" ? record.match_reason : "";
  return { findingIndex, truthIndex, matchConfidence: confidence, matchReason: reason };
}

function normalizeSummary(summary: unknown): string | null {
  if (typeof summary === "string") {
    return summary;
  }
  if (typeof summary === "object" && summary !== null && !Array.isArray(summary)) {
    return JSON.stringify(summary);
  }
  return null;
}

/** 1 起索引 → 0 起；非正整数返回 null */
function asIndex(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return null;
  }
  return value - 1;
}

function asConfidence(value: unknown): MatchConfidence | null {
  if (typeof value !== "string" || !CONFIDENCE_VALUES.has(value)) {
    return null;
  }
  return value as MatchConfidence;
}

function summarizeText(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= 120 ? collapsed : `${collapsed.slice(0, 120)}…`;
}
