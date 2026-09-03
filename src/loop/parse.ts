/**
 * 阶段回复解析（容错：模型可能包裹 markdown 代码围栏）。
 * 解析失败不抛异常——记入 PhaseRecord.note，loop 以空结果继续（有界、可审计）。
 */

export interface CandidatesParseResult {
  /** 原始候选对象列表（未经 Schema 校验） */
  readonly candidates: readonly unknown[];
  readonly note?: string;
}

export interface VerificationVerdict {
  readonly pass: boolean;
  readonly reason: string;
}

export interface VerificationParseResult {
  readonly verdicts: ReadonlyMap<string, VerificationVerdict>;
  /** Evidence Verification 回复的 complete 信号；解析失败按 false 处理（有界推进） */
  readonly complete: boolean;
  readonly note?: string;
}

/** 尝试解析 JSON 对象；剥掉代码围栏后重试；失败返回 undefined */
export function parseJsonReply(content: string): unknown {
  const trimmed = content.trim();
  const direct = tryParse(trimmed);
  if (direct !== undefined) {
    return direct;
  }
  if (trimmed.includes("```")) {
    const unfenced = trimmed.replace(/```[a-zA-Z]*\r?\n?/g, "").trim();
    return tryParse(unfenced);
  }
  return undefined;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** 解析 Deep Reasoning 回复的 candidates 数组 */
export function parseCandidatesReply(content: string): CandidatesParseResult {
  const parsed = parseJsonReply(content);
  if (parsed === undefined || typeof parsed !== "object") {
    return { candidates: [], note: "deep-reasoning reply is not valid JSON" };
  }
  const candidates = (parsed as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) {
    return { candidates: [], note: "deep-reasoning reply has no candidates array" };
  }
  return { candidates };
}

/** 解析 Evidence Verification 回复的 verdicts + complete */
export function parseVerificationReply(content: string): VerificationParseResult {
  const parsed = parseJsonReply(content);
  if (parsed === undefined || typeof parsed !== "object") {
    return { verdicts: new Map(), complete: false, note: "verification reply is not valid JSON" };
  }
  const record = parsed as { verdicts?: unknown; complete?: unknown };
  const verdicts = new Map<string, VerificationVerdict>();
  let note: string | undefined;
  if (Array.isArray(record.verdicts)) {
    for (const entry of record.verdicts) {
      const mapped = mapVerdict(entry);
      if (mapped !== undefined) {
        verdicts.set(mapped.id, mapped.verdict);
      } else {
        note = "verification reply contains a malformed verdict entry";
      }
    }
  } else {
    note = "verification reply has no verdicts array";
  }
  const complete = record.complete === true;
  return { verdicts, complete, ...(note !== undefined ? { note } : {}) };
}

function mapVerdict(entry: unknown): { id: string; verdict: VerificationVerdict } | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const record = entry as { id?: unknown; pass?: unknown; reason?: unknown };
  if (typeof record.id !== "string" || record.id.length === 0) {
    return undefined;
  }
  return {
    id: record.id,
    verdict: {
      pass: record.pass === true,
      reason: typeof record.reason === "string" ? record.reason : "",
    },
  };
}
