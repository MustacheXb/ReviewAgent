/**
 * 人工抽检模块统一入口（Ticket 11）——判定链第三级：10% 人工抽检。
 *
 * 复用接口（面向 Ticket 12 运行器）：
 * buildReviewUnits(evaluations, judgeResults) → buildSamplingPlan(units, {seed, rate})
 * → buildHumanReviewForms(plan) → 人工填写 → validateHumanVerdictSubmission(form, submission)。
 */
export { fnv1a32, sampleUnits } from "./sampler.js";
export type {
  SamplingOptions,
  SamplingPlan,
  SamplingUnit,
  StratumSelection,
} from "./sampler.js";
export {
  buildHumanReviewForms,
  buildReviewUnits,
  buildSamplingPlan,
  unitKey,
  validateHumanVerdictSubmission,
  DEFAULT_HUMAN_REVIEW_RATE,
  HUMAN_REVIEW_PROTOCOL_VERSION,
} from "./review-plan.js";
export type {
  HumanReviewForm,
  HumanReviewItem,
  HumanVerdictEntry,
  HumanVerdictSubmission,
  ReviewUnit,
} from "./review-plan.js";
