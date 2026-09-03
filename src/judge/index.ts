/**
 * Judge 模块统一入口（Ticket 11 / issue #12）——判定链第二级。
 *
 * 复用接口（面向 Ticket 12 运行器）：
 * - 单次运行：judgeRun(run, mrCase, judgeClient, options) → JudgeRunResult（双口径）
 * - 批量：judgeEvaluations(evaluations, judgeClient, options) → JudgeChainReport
 * - 指标回填：flattenJudgeRun(result, "rule" | "judge") → FlatMetrics（T10 形状，
 *   可直接进 summarizeFlatMetrics / S/A/B 判定等 T10 纯函数管线）
 * - 校准：src/calibration（MCR-Bench 参照集上的 judge 一致性报告）
 * - 人工抽检：src/sampling（10% 种子抽样 + 抽检表单）
 */
export type {
  JudgeAdjudication,
  JudgeClient,
  JudgeContextLimits,
  JudgeFindingCard,
  JudgeMrContext,
  JudgeRequest,
  JudgeTruthCard,
  MatchConfidence,
  MatchConfidenceThreshold,
} from "./contracts.js";
export {
  DEFAULT_JUDGE_CONTEXT_LIMITS,
  DEFAULT_MATCH_CONFIDENCE_THRESHOLD,
  findingToCard,
  MATCH_CONFIDENCE_RANK,
  truthToCards,
} from "./contracts.js";
export {
  GptJudgeHttpError,
  GptJudgeNetworkError,
  GptJudgeResponseFormatError,
  isRetryableJudgeError,
  isRetryableStatus,
  JudgeClientError,
  RETRYABLE_HTTP_STATUSES,
} from "./errors.js";
export { buildJudgeMessages } from "./prompt.js";
export { extractJudgeJsonText, parseJudgeAdjudication } from "./parse.js";
export {
  passesThreshold,
  resolveAdjudication,
} from "./resolve.js";
export type { ResolvedAdjudication, ResolvedMatch } from "./resolve.js";
export { FakeJudgeClient, JudgeScriptExhaustedError } from "./fake-judge-client.js";
export type { FakeJudgeScriptStep } from "./fake-judge-client.js";
export {
  buildGptJudgeBody,
  DEFAULT_JUDGE_MODEL,
  JUDGE_MAX_TOKENS,
  JUDGE_TEMPERATURE,
  JUDGE_TOP_P,
  validateModel,
} from "./gpt-request-mapper.js";
export {
  DEFAULT_GPT_JUDGE_MAX_RETRIES,
  DEFAULT_GPT_JUDGE_RETRY_BASE_DELAY_MS,
  DEFAULT_GPT_JUDGE_TIMEOUT_MS,
  GptJudgeClient,
  OPENAI_API_BASE_URL,
  OPENAI_API_KEY_ENV_VAR,
} from "./gpt-judge-client.js";
export type { GptJudgeClientOptions } from "./gpt-judge-client.js";
export {
  judgeRun,
} from "./orchestrate.js";
export type {
  JudgeChainOptions,
  JudgeDisagreement,
  JudgeFindingVerdict,
  JudgeFpReason,
  JudgeRunResult,
  JudgeRunStatus,
} from "./orchestrate.js";
export {
  flattenJudgeRun,
  judgeEvaluations,
} from "./report.js";
export type {
  JudgeCaseReport,
  JudgeChainReport,
  JudgeConfigCaseReport,
  JudgeConfigSummary,
} from "./report.js";
