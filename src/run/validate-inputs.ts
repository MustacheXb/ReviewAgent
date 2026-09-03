import type { ReviewConfig } from "../contracts/config.js";
import type { LlmClient } from "../contracts/llm-client.js";
import type { MRCase } from "../contracts/mr-case.js";
import type { RunReviewOptions } from "./run-review.js";

/** 系统边界输入校验：fail fast，错误信息指明字段与期望 */
export function validateRunInputs(
  config: ReviewConfig,
  mrCase: MRCase,
  llmClient: LlmClient,
  options: RunReviewOptions,
): void {
  validateConfig(config);
  validateMrCase(mrCase);
  validateLlmClient(llmClient);
  validateOptions(options);
}

function validateConfig(config: ReviewConfig): void {
  if (typeof config !== "object" || config === null) {
    throw new Error("config must be a ReviewConfig object");
  }
  const validIds = new Set(["A", "B", "C", "D", "E"]);
  if (!validIds.has(config.configId)) {
    throw new Error(`config.configId must be one of "A", "B", "C", "D", "E" (got ${JSON.stringify(config.configId)})`);
  }
  const booleanFields = ["toolsEnabled", "prefetch", "fullRepo", "stablePrefix", "ledger"] as const;
  for (const field of booleanFields) {
    if (typeof config[field] !== "boolean") {
      throw new Error(`config.${field} must be a boolean (got ${JSON.stringify(config[field])})`);
    }
  }
}

function validateMrCase(mrCase: MRCase): void {
  if (typeof mrCase !== "object" || mrCase === null) {
    throw new Error("mrCase must be an MRCase object");
  }
  requireNonEmptyString(mrCase.caseId, "mrCase.caseId");
  requireNonEmptyString(mrCase.repoPath, "mrCase.repoPath");
  requireNonEmptyString(mrCase.diff, "mrCase.diff");
  if (typeof mrCase.issueDescription !== "string") {
    throw new Error("mrCase.issueDescription must be a string");
  }
  validateLabels(mrCase.labels);
  if (mrCase.truth !== null) {
    validateTruth(mrCase.truth);
  }
}

function validateLabels(labels: MRCase["labels"]): void {
  if (typeof labels !== "object" || labels === null) {
    throw new Error("mrCase.labels must be a CaseLabels object");
  }
  requireNonEmptyString(labels.source, "mrCase.labels.source");
  const riskClasses = new Set(["Low", "Medium", "High"]);
  if (!riskClasses.has(labels.riskClass)) {
    throw new Error(`mrCase.labels.riskClass must be "Low", "Medium" or "High" (got ${JSON.stringify(labels.riskClass)})`);
  }
  if (!Array.isArray(labels.allowedConfigs) || labels.allowedConfigs.length === 0) {
    throw new Error("mrCase.labels.allowedConfigs must be a non-empty array");
  }
}

function validateTruth(truth: NonNullable<MRCase["truth"]>): void {
  if (typeof truth !== "object" || truth === null) {
    throw new Error("mrCase.truth must be an MRTruth object or null");
  }
  requireNonEmptyString(truth.fixPatch, "mrCase.truth.fixPatch");
  if (!Array.isArray(truth.locations) || truth.locations.length === 0) {
    throw new Error("mrCase.truth.locations must be a non-empty array");
  }
}

function validateLlmClient(llmClient: LlmClient): void {
  if (typeof llmClient !== "object" || llmClient === null || typeof llmClient.complete !== "function") {
    throw new Error("llmClient must implement complete(request): Promise<LlmResponse>");
  }
}

function validateOptions(options: RunReviewOptions): void {
  if (typeof options !== "object" || options === null) {
    throw new Error("options must be an object");
  }
  if (options.auditDir !== undefined && (typeof options.auditDir !== "string" || options.auditDir.length === 0)) {
    throw new Error("options.auditDir must be a non-empty string");
  }
  if (options.model !== undefined && (typeof options.model !== "string" || options.model.length === 0)) {
    throw new Error("options.model must be a non-empty string");
  }
  if (options.effort !== undefined && (typeof options.effort !== "string" || options.effort.length === 0)) {
    throw new Error("options.effort must be a non-empty string");
  }
  if (options.tools !== undefined && !Array.isArray(options.tools)) {
    throw new Error("options.tools must be an array of ToolSchema");
  }
  if (options.toolExecutor !== undefined && typeof options.toolExecutor.execute !== "function") {
    throw new Error("options.toolExecutor must implement execute(call): Promise<string>");
  }
  if (options.prefetch !== undefined) {
    validatePrefetchOptions(options.prefetch);
  }
  if (options.fullRepoBudgetChars !== undefined) {
    requirePositiveInt(options.fullRepoBudgetChars, "options.fullRepoBudgetChars");
  }
  if (options.toolResultBudgetChars !== undefined) {
    requirePositiveInt(options.toolResultBudgetChars, "options.toolResultBudgetChars");
  }
  if (options.now !== undefined && typeof options.now !== "function") {
    throw new Error("options.now must be a function returning a Date");
  }
}

function validatePrefetchOptions(prefetch: unknown): void {
  if (typeof prefetch !== "object" || prefetch === null) {
    throw new Error("options.prefetch must be a PrefetchOptions object");
  }
  const budgetFields = [
    "zoneBBudgetChars",
    "symbolLayerBudgetChars",
    "referenceLayerBudgetChars",
    "callChainLayerBudgetChars",
  ] as const;
  for (const field of budgetFields) {
    const value = (prefetch as Record<string, unknown>)[field];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new Error(
        `options.prefetch.${field} must be a positive integer (got ${JSON.stringify(value)})`,
      );
    }
  }
}

function requirePositiveInt(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer (got ${JSON.stringify(value)})`);
  }
}

function requireNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}
