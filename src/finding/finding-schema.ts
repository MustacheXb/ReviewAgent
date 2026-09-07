import type { Finding } from "../contracts/finding.js";

/**
 * Finding JSON Schema（文档级真源，与 Finding 接口一一对应）。
 * 运行时校验用手写的 validateFinding（零依赖的薄 harness 不引入 schema 引擎）。
 */
export const FINDING_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Finding",
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "severity",
    "category",
    "file",
    "line",
    "title",
    "description",
    "evidence",
    "rule",
    "confidence",
  ],
  properties: {
    id: { type: "string", minLength: 1 },
    severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
    category: { type: "string", minLength: 1 },
    file: { type: "string", minLength: 1 },
    line: { type: "integer", minimum: 1 },
    title: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    evidence: { type: "array", items: { type: "string" } },
    rule: { type: "string", minLength: 1 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

const SEVERITIES = new Set(["P0", "P1", "P2", "P3"]);

/**
 * 校验一个候选对象是否符合 Finding Schema（形状校验）。
 * 返回英文错误列表；空数组 = 合法。
 * 注意：evidence 的"非空性"不在此处判定——空 evidence 是领域问题，
 * 由 Evidence Gate 以 NO_EVIDENCE 拦截（No Evidence, No Finding）。
 */
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
  const invalid = value.some((entry) => typeof entry !== "string");
  if (invalid) {
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

/** 类型收窄辅助：验证通过即视为 Finding */
export function isFinding(candidate: unknown): candidate is Finding {
  return validateFinding(candidate).length === 0;
}
