import type { Finding } from "../contracts/finding.js";
import type { CandidateRejection } from "../contracts/run.js";
import { validateFinding } from "../finding/finding-schema.js";
import type { VerificationVerdict } from "../loop/parse.js";

/**
 * Evidence Gate（"No Evidence, No Finding"）+ 候选拦截链。
 * 拦截顺序：Schema 校验 → 全英文检查 → 证据检查 → 验证裁决 → 重复 id。
 * 每个候选最多产生一条拦截记录（首个失败阶段），全部留痕进 RunAudit.rejections。
 */

export interface GateInput {
  /** Deep Reasoning 阶段产出的原始候选对象 */
  readonly candidates: readonly unknown[];
  /** Evidence Verification 阶段的裁决（按候选 id 索引） */
  readonly verdicts: ReadonlyMap<string, VerificationVerdict>;
  /** 已产出的 Finding id 集合（跨轮去重） */
  readonly emittedIds: ReadonlySet<string>;
  readonly round: number;
}

export interface GateOutput {
  readonly findings: readonly Finding[];
  readonly rejections: readonly CandidateRejection[];
  readonly emittedIds: ReadonlySet<string>;
}

export function applyCandidateGate(input: GateInput): GateOutput {
  const findings: Finding[] = [];
  const rejections: CandidateRejection[] = [];
  const emittedIds = new Set(input.emittedIds);

  input.candidates.forEach((candidate, index) => {
    const candidateId = readCandidateId(candidate, input.round, index);
    const rejection = firstFailingStage(candidate, candidateId, input.verdicts, emittedIds);
    if (rejection !== undefined) {
      rejections.push(rejection);
      return;
    }
    const finding = toFinding(candidate);
    findings.push(finding);
    emittedIds.add(finding.id);
  });

  return { findings, rejections, emittedIds };
}

function readCandidateId(candidate: unknown, round: number, index: number): string {
  if (typeof candidate === "object" && candidate !== null) {
    const id = (candidate as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) {
      return id;
    }
  }
  return `round-${round}-candidate-${index}`;
}

function firstFailingStage(
  candidate: unknown,
  candidateId: string,
  verdicts: ReadonlyMap<string, VerificationVerdict>,
  emittedIds: ReadonlySet<string>,
): CandidateRejection | undefined {
  const schemaErrors = validateFinding(candidate);
  if (schemaErrors.length > 0) {
    return { candidateId, stage: "SCHEMA_INVALID", reason: schemaErrors.join("; ") };
  }
  if (containsNonEnglish(candidate)) {
    return { candidateId, stage: "NON_ENGLISH", reason: "finding text must be English only" };
  }
  if (!hasEvidence(candidate)) {
    return { candidateId, stage: "NO_EVIDENCE", reason: "no evidence cited (No Evidence, No Finding)" };
  }
  const verdict = verdicts.get(candidateId);
  if (verdict === undefined) {
    return { candidateId, stage: "VERIFICATION_FAILED", reason: "no verification verdict for candidate" };
  }
  if (!verdict.pass) {
    const detail = verdict.reason.length > 0 ? `: ${verdict.reason}` : "";
    return { candidateId, stage: "VERIFICATION_FAILED", reason: `evidence verification rejected the candidate${detail}` };
  }
  if (emittedIds.has(candidateId)) {
    return { candidateId, stage: "DUPLICATE_ID", reason: "a finding with this id was already emitted in an earlier round" };
  }
  return undefined;
}

/** 检查候选文本字段是否含 CJK 字符（POC1 输出全英文） */
function containsNonEnglish(candidate: unknown): boolean {
  const record = candidate as Record<string, unknown>;
  const texts = [record.title, record.description, ...(record.evidence as readonly unknown[])];
  return texts.some((text) => typeof text === "string" && CJK_PATTERN.test(text));
}

const CJK_PATTERN = /[㐀-䶿一-鿿豈-﫿　-〿＀-￯]/;

function hasEvidence(candidate: unknown): boolean {
  const evidence = (candidate as { evidence?: unknown }).evidence;
  return (
    Array.isArray(evidence) && evidence.some((entry) => typeof entry === "string" && entry.trim().length > 0)
  );
}

function toFinding(candidate: unknown): Finding {
  const record = candidate as {
    id: string;
    severity: Finding["severity"];
    category: string;
    file: string;
    line: number;
    title: string;
    description: string;
    evidence: readonly string[];
    rule: string;
    confidence: number;
  };
  return {
    id: record.id,
    severity: record.severity,
    category: record.category,
    file: record.file,
    line: record.line,
    title: record.title,
    description: record.description,
    evidence: [...record.evidence],
    rule: record.rule,
    confidence: record.confidence,
  };
}
