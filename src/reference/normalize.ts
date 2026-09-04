import type { Finding } from "../contracts/finding.js";
import type { LlmUsage } from "../contracts/llm-client.js";
import { validateFinding } from "../finding/finding-schema.js";
import type {
  ClaudeCodeRunOutput,
  NormalizedFindings,
  ReferenceRejection,
} from "./contracts.js";

/**
 * Claude Code 输出归一化（Ticket 13 / issue #14，纯函数）：
 * CLI stdout（--output-format json）→ result 文本 → findings 载荷 → 统一 Finding Schema。
 *
 * 容错纪律（有界失败留痕，不整单报废）：
 * - stdout 层失败（非法 JSON / 无 result 文本）→ CLI_OUTPUT_UNPARSABLE，findings 为空、
 *   usage / 成本照常留痕（钱已花，指标如实计入 0 检出）；
 * - result 文本无合法 findings 载荷 → FINDINGS_FIELD_INVALID，同上；
 * - 单条候选形状非法 → ENTRY_SCHEMA_INVALID 丢弃该条，合法条目照常保留；
 * - id 重复 → DUPLICATE_ID 丢弃后到条目（与主 harness 同口径）。
 * JSON 提取策略沿用 judge/parse.ts 的加固三段式（直接 parse → 剥围栏 → 首尾括号子串）。
 */

/** stdout JSON 的解析投影（容错：逐字段缺省 + notes 留痕，绝不抛错） */
export interface ClaudeCodeStdoutParse {
  /** 最终回复文本；stdout 层失败时为 null */
  readonly resultText: string | null;
  readonly usage: LlmUsage;
  /** agent 轮数（CLI num_turns；缺失为 null） */
  readonly numTurns: number | null;
  /** CLI 回报的美元成本（total_cost_usd；缺失为 null） */
  readonly totalCostUsd: number | null;
  /** CLI 回报的实际模型 id（modelUsage 键；留档对照请求模型） */
  readonly actualModels: readonly string[];
  /** 被权限拒绝的工具调用数（CLI permission_denials） */
  readonly permissionDenials: number;
  /** CLI 自报错误（is_error = true） */
  readonly isError: boolean;
  /** 解析过程中的容错说明（如 usage 字段非法按 0 计） */
  readonly notes: readonly string[];
}

/** 归一化的整体结果（runner 落盘的直接材料） */
export interface NormalizedClaudeCodeRun extends NormalizedFindings {
  /** ok = 零拦截；degraded = 存在拦截（findings 可能为空） */
  readonly status: "ok" | "degraded";
  readonly parse: ClaudeCodeStdoutParse;
}

/** 解析 CLI stdout（--output-format json；非法输入返回带 notes 的缺省投影） */
export function parseClaudeCodeStdout(stdout: string): ClaudeCodeStdoutParse {
  const notes: string[] = [];
  const empty: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      resultText: null,
      usage: empty,
      numTurns: null,
      totalCostUsd: null,
      actualModels: [],
      permissionDenials: 0,
      isError: false,
      notes: [`stdout is not valid JSON: ${message}`],
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      resultText: null,
      usage: empty,
      numTurns: null,
      totalCostUsd: null,
      actualModels: [],
      permissionDenials: 0,
      isError: false,
      notes: ["stdout JSON is not an object"],
    };
  }
  const record = parsed as {
    readonly result?: unknown;
    readonly usage?: unknown;
    readonly num_turns?: unknown;
    readonly total_cost_usd?: unknown;
    readonly modelUsage?: unknown;
    readonly permission_denials?: unknown;
    readonly is_error?: unknown;
  };
  const resultText =
    typeof record.result === "string" && record.result.trim().length > 0
      ? record.result
      : null;
  if (resultText === null) {
    notes.push("stdout JSON has no non-empty result text (max-turns cutoff or empty reply)");
  }
  return {
    resultText,
    usage: mapUsage(record.usage, notes),
    numTurns: nonNegativeIntOrNull(record.num_turns, "num_turns", notes),
    totalCostUsd: nonNegativeNumberOrNull(record.total_cost_usd, "total_cost_usd", notes),
    actualModels: modelKeysOf(record.modelUsage),
    permissionDenials:
      typeof record.permission_denials === "number" && Number.isInteger(record.permission_denials)
        ? Math.max(0, record.permission_denials)
        : 0,
    isError: record.is_error === true,
    notes,
  };
}

/** CLI usage（Anthropic 语义）→ LlmUsage（DeepSeek 语义的记账形状） */
function mapUsage(raw: unknown, notes: string[]): LlmUsage {
  if (typeof raw !== "object" || raw === null) {
    notes.push("usage missing or not an object; recorded as zeros");
    return { inputTokens: 0, outputTokens: 0 };
  }
  const record = raw as {
    readonly input_tokens?: unknown;
    readonly output_tokens?: unknown;
    readonly cache_read_input_tokens?: unknown;
    readonly cache_creation_input_tokens?: unknown;
  };
  const usage: LlmUsage = {
    inputTokens: nonNegativeIntOrZero(record.input_tokens, "usage.input_tokens", notes),
    outputTokens: nonNegativeIntOrZero(record.output_tokens, "usage.output_tokens", notes),
  };
  const cacheRead = nonNegativeIntOrZero(
    record.cache_read_input_tokens,
    "usage.cache_read_input_tokens",
    notes,
  );
  const cacheWrite = nonNegativeIntOrZero(
    record.cache_creation_input_tokens,
    "usage.cache_creation_input_tokens",
    notes,
  );
  // 与 DeepSeekClient 同风格：仅在上报非零时携带可选字段
  if (cacheRead > 0) {
    return { ...usage, cacheReadTokens: cacheRead, ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}) };
  }
  return cacheWrite > 0 ? { ...usage, cacheWriteTokens: cacheWrite } : usage;
}

/** 一次运行的完整归一化：stdout 解析 → findings 提取 → 条目校验（全部有界失败） */
export function normalizeClaudeCodeRun(raw: ClaudeCodeRunOutput): NormalizedClaudeCodeRun {
  const parse = parseClaudeCodeStdout(raw.stdout);
  if (parse.resultText === null) {
    return {
      status: "degraded",
      findings: [],
      rejections: [
        {
          candidateIndex: null,
          stage: "CLI_OUTPUT_UNPARSABLE",
          reason: parse.notes.join("; "),
        },
      ],
      parse,
    };
  }
  const payload = extractFindingsPayload(parse.resultText);
  if (payload === null) {
    return {
      status: "degraded",
      findings: [],
      rejections: [
        {
          candidateIndex: null,
          stage: "FINDINGS_FIELD_INVALID",
          reason: `result text contains no extractable JSON payload: ${summarize(parse.resultText)}`,
        },
      ],
      parse,
    };
  }
  const entries = entriesOf(payload);
  if (entries === null) {
    return {
      status: "degraded",
      findings: [],
      rejections: [
        {
          candidateIndex: null,
          stage: "FINDINGS_FIELD_INVALID",
          reason: `payload is neither {"findings": [...]} nor a bare array: ${summarize(parse.resultText)}`,
        },
      ],
      parse,
    };
  }
  const normalized = normalizeEntries(entries);
  return {
    status: normalized.rejections.length === 0 ? "ok" : "degraded",
    findings: normalized.findings,
    rejections: normalized.rejections,
    parse,
  };
}

/** 从 result 文本提取 findings 载荷（JSON 值；提取不到返回 null） */
export function extractFindingsPayload(resultText: string): unknown {
  const trimmed = resultText.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const candidates = [stripCodeFence(trimmed)];
  const braceStart = trimmed.indexOf("{");
  const braceEnd = trimmed.lastIndexOf("}");
  if (braceStart >= 0 && braceEnd > braceStart) {
    candidates.push(stripCodeFence(trimmed.slice(braceStart, braceEnd + 1)));
  }
  const bracketStart = trimmed.indexOf("[");
  const bracketEnd = trimmed.lastIndexOf("]");
  if (bracketStart >= 0 && bracketEnd > bracketStart) {
    candidates.push(stripCodeFence(trimmed.slice(bracketStart, bracketEnd + 1)));
  }
  for (const candidate of candidates) {
    const value = tryParseJson(candidate);
    if (value !== undefined) {
      return value;
    }
  }
  return null;
}

/** 载荷 → 候选条目数组；形状不符返回 null（{"findings": [...]} 或裸数组） */
function entriesOf(payload: unknown): readonly unknown[] | null {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (typeof payload === "object" && payload !== null) {
    const findings = (payload as { readonly findings?: unknown }).findings;
    if (Array.isArray(findings)) {
      return findings;
    }
  }
  return null;
}

/** 候选条目数组 → 合法 Finding + 拦截留痕（逐条有界失败） */
export function normalizeEntries(entries: readonly unknown[]): NormalizedFindings {
  const findings: Finding[] = [];
  const rejections: ReferenceRejection[] = [];
  const seenIds = new Set<string>();
  entries.forEach((entry, index) => {
    const errors = validateFinding(entry);
    if (errors.length > 0) {
      rejections.push({
        candidateIndex: index,
        stage: "ENTRY_SCHEMA_INVALID",
        reason: errors.join("; "),
      });
      return;
    }
    const finding = sanitizeFinding(entry as Finding);
    if (seenIds.has(finding.id)) {
      rejections.push({
        candidateIndex: index,
        stage: "DUPLICATE_ID",
        reason: `duplicate finding id "${finding.id}" (kept the first occurrence)`,
      });
      return;
    }
    seenIds.add(finding.id);
    findings.push(finding);
  });
  return { findings, rejections };
}

/** 取恰好 10 个 Schema 字段的不可变拷贝（丢弃模型附带的额外字段，防下游污染） */
function sanitizeFinding(candidate: Finding): Finding {
  return {
    id: candidate.id,
    severity: candidate.severity,
    category: candidate.category,
    file: candidate.file,
    line: candidate.line,
    title: candidate.title,
    description: candidate.description,
    evidence: [...candidate.evidence],
    rule: candidate.rule,
    confidence: candidate.confidence,
  };
}

function stripCodeFence(text: string): string {
  const withoutLeading = text.replace(/^```(?:json)?\s*\n?/, "");
  return withoutLeading.replace(/\n?```\s*$/, "");
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function nonNegativeIntOrZero(value: unknown, field: string, notes: string[]): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    notes.push(`${field} is not a non-negative integer; recorded as 0`);
    return 0;
  }
  return value;
}

function nonNegativeIntOrNull(value: unknown, field: string, notes: string[]): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    notes.push(`${field} is not a non-negative integer; recorded as null`);
    return null;
  }
  return value;
}

function nonNegativeNumberOrNull(value: unknown, field: string, notes: string[]): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    notes.push(`${field} is not a non-negative finite number; recorded as null`);
    return null;
  }
  return value;
}

function modelKeysOf(raw: unknown): readonly string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return [];
  }
  return Object.keys(raw).filter((key) => key.length > 0);
}

function summarize(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= 120 ? collapsed : `${collapsed.slice(0, 120)}…`;
}
