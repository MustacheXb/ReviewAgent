/**
 * review-evidence：核内证据插件——Finding 契约 + Evidence Gate。
 *
 * Schema 校验与拦截链 1:1 移植自冻结 harness
 * src/finding/finding-schema.ts 与 src/gate/candidate-gate.ts：
 * 拦截顺序 SCHEMA_INVALID → NON_ENGLISH → NO_EVIDENCE → VERIFICATION_FAILED →
 * DUPLICATE_ID，每个候选最多一条拦截记录（首败即出），全部留痕进审计 rejections。
 *
 * 契约直接复用冻结 contracts（type-only import）：Finding / CandidateRejection /
 * RejectionStage 漂移即编译期报错，不靠形状巧合。
 */

import type { Context, Plugin } from "@deepseek-ai/cordis";

import type { Finding } from "../../../../src/contracts/finding.js";
import type { CandidateRejection, RejectionStage } from "../../../../src/contracts/run.js";
import type { VerificationVerdict } from "../loop/parse.js";

export type { Finding, CandidateRejection };

/** Evidence Gate 阶段（每个候选按序检查，首个失败即拒绝并记录原因）；阶段全集
 * 经 RejectionStage 类型收口（冻结契约），数组字面漂移即编译期报错 */
export const EVIDENCE_GATE_STAGES: readonly RejectionStage[] = [
  "SCHEMA_INVALID",
  "NON_ENGLISH",
  "NO_EVIDENCE",
  "VERIFICATION_FAILED",
  "DUPLICATE_ID",
];

export type EvidenceGateStage = RejectionStage;

/** 校验候选是否符合 Finding Schema（形状校验；空 evidence 不在此判，属 NO_EVIDENCE） */
export function validateFinding(candidate: unknown): readonly string[] {
  if (typeof candidate !== "object" || candidate === null) {
    return ["candidate must be a JSON object"];
  }
  const record = candidate as Record<string, unknown>;
  const errors: string[] = [];
  errors.push(...checkString(record.id, "id"));
  errors.push(...checkSeverity(record.severity));
  errors.push(...checkString(record.category, "category"));
  errors.push(...checkString(record.file, "file"));
  errors.push(...checkLine(record.line));
  errors.push(...checkString(record.title, "title"));
  errors.push(...checkString(record.description, "description"));
  errors.push(...checkEvidence(record.evidence));
  errors.push(...checkString(record.rule, "rule"));
  errors.push(...checkConfidence(record.confidence));
  return errors;
}

function checkString(value: unknown, field: string): readonly string[] {
  if (typeof value !== "string" || value.length === 0) {
    return [`field "${field}" must be a non-empty string`];
  }
  return [];
}

function checkSeverity(value: unknown): readonly string[] {
  if (typeof value !== "string" || !SEVERITIES.has(value)) {
    return ['field "severity" must be one of "P0", "P1", "P2", "P3"'];
  }
  return [];
}

const SEVERITIES = new Set(["P0", "P1", "P2", "P3"]);

function checkLine(value: unknown): readonly string[] {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return ['field "line" must be an integer >= 1'];
  }
  return [];
}

function checkEvidence(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return ['field "evidence" must be an array of strings'];
  }
  if (value.some((entry) => typeof entry !== "string")) {
    return ['field "evidence" must contain only strings'];
  }
  return [];
}

function checkConfidence(value: unknown): readonly string[] {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    return ['field "confidence" must be a number between 0 and 1'];
  }
  return [];
}

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

/** Evidence Gate（"No Evidence, No Finding"）+ 候选拦截链 */
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
  const evidence = Array.isArray(record.evidence) ? (record.evidence as readonly unknown[]) : [];
  const texts = [record.title, record.description, ...evidence];
  return texts.some((text) => typeof text === "string" && CJK_PATTERN.test(text));
}

const CJK_PATTERN = /[㐀-䶿一-鿿豈-﫿　-〿＀-￯]/;

function hasEvidence(candidate: unknown): boolean {
  const evidence = (candidate as { evidence?: unknown }).evidence;
  return (
    Array.isArray(evidence) && evidence.some((entry) => typeof entry === "string" && entry.trim().length > 0)
  );
}

/** 逐字段投影为 Finding 契约（schema additionalProperties: false——多余候选字段不外漏） */
function toFinding(candidate: unknown): Finding {
  const record = candidate as Record<string, unknown>;
  return {
    id: record.id as string,
    severity: record.severity as Finding["severity"],
    category: record.category as string,
    file: record.file as string,
    line: record.line as number,
    title: record.title as string,
    description: record.description as string,
    evidence: record.evidence as readonly string[],
    rule: record.rule as string,
    confidence: record.confidence as number,
  };
}

/** reviewEvidence 服务：证据门面 */
export interface ReviewEvidenceService {
  /** Evidence Gate 阶段顺序（首败即出） */
  readonly gateStages: readonly EvidenceGateStage[];
  /** Evidence Gate：候选 × 裁决 → findings + rejections（跨轮 emittedIds 去重） */
  applyGate(input: GateInput): GateOutput;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    reviewEvidence: ReviewEvidenceService;
  }
}

/** review-evidence 插件：契约、Schema 校验与拦截链服务 */
export const reviewEvidence: Plugin.Object = {
  name: "review-evidence",
  apply(ctx: Context) {
    const service: ReviewEvidenceService = {
      gateStages: EVIDENCE_GATE_STAGES,
      applyGate: (input) => applyCandidateGate(input),
    };
    return ctx.provide("reviewEvidence", service);
  },
};
