/**
 * 实验启动环境校验（Ticket 12）：运行器启动时统一校验全部必需环境变量，
 * 缺失时给出清晰清单（fail fast），key 值只经环境变量注入、任何输出不回显。
 *
 * 必需性规则：
 * - 检视 key：恒必需（#43 起角色命名 REVIEWER_API_KEY 与旧名 DEEPSEEK_API_KEY
 *   任一非空即满足，推荐名在前，client 层同名序探测；--report-only 重建报告
 *   时不执行检视则豁免）；
 * - judge key：plan.judge = true 时必需（LLM-as-judge，异构约束：judge 模型须与被测
 *   模型不同源，src/judge/gpt-judge-client.ts）——#42 起角色命名 JUDGE_API_KEY
 *   与旧名 OPENAI_API_KEY 任一非空即满足（推荐名在前，client 层同名序探测）。
 *
 * 变量名单源：角色常量单源在 review-llm（#41/#43 共享常量）与
 * src/judge/gpt-judge-client.ts——预检与客户端不再各持一份字符串副本。
 */

import { DEEPSEEK_API_KEY_ENV_VAR, hasReviewerApiKey, REVIEWER_API_KEY_ENV_VAR, REVIEWER_URL_ENV_VARS, DEEPSEEK_API_BASE_URL } from "review-llm";
import {
  hasJudgeApiKey,
  JUDGE_API_KEY_ENV_VAR,
  JUDGE_URL_ENV_VARS,
  OPENAI_API_KEY_ENV_VAR,
} from "../judge/index.js";

/** 未满足时的报告形态：推荐名在前，别名括注（与 client 层探测序一致） */
const JUDGE_KEY_REQUIREMENT = `${JUDGE_API_KEY_ENV_VAR} (or ${OPENAI_API_KEY_ENV_VAR})`;
const REVIEWER_KEY_REQUIREMENT = `${REVIEWER_API_KEY_ENV_VAR} (or ${DEEPSEEK_API_KEY_ENV_VAR})`;

export interface ExperimentEnvRequirements {
  /** 判定链 judge 阶段是否启用（启用则 judge key 双名任一必需） */
  readonly judge: boolean;
  /** 是否会执行检视运行（--report-only 重建报告时不执行 → 检视 key 不必需；缺省 true） */
  readonly reviewRuns?: boolean;
}

export interface ExperimentEnvCheckResult {
  /** 未满足的环境变量要求（按校验顺序；双名要求为 "推荐名 (or 旧名)" 形态） */
  readonly missing: readonly string[];
  /** true = 全部满足，可启动 */
  readonly satisfied: boolean;
}

/** 校验（纯函数：env 注入以便测试；只判断存在性，绝不读取/回显 key 值） */
export function checkExperimentEnv(
  requirements: ExperimentEnvRequirements,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ExperimentEnvCheckResult {
  const missing: string[] = [];
  if (requirements.reviewRuns !== false && !hasReviewerApiKey(env)) {
    missing.push(REVIEWER_KEY_REQUIREMENT);
  }
  if (requirements.judge && !hasJudgeApiKey(env)) {
    missing.push(JUDGE_KEY_REQUIREMENT);
  }
  return { missing, satisfied: missing.length === 0 };
}

/**
 * 检视链接入点解析（#43 manifest 留痕）：REVIEWER_URL > DEEPSEEK_URL > 官方缺省。
 * 与客户端构造期 resolveEndpointUrl 同名同序同 trim/尾斜杠语义（CLI 从不传 baseUrl
 * 选项，故结果必然一致）；协议合法性由客户端构造期校验（非法值在 manifest 落盘前
 * 即 fail fast），此处只做留痕归一化。只解析 base URL，绝不读 key。
 */
export function reviewerBaseUrlOf(env: Readonly<Record<string, string | undefined>>): string {
  for (const name of REVIEWER_URL_ENV_VARS) {
    const value = env[name]?.trim();
    if (value !== undefined && value.length > 0) {
      return value.replace(/\/+$/, "");
    }
  }
  return DEEPSEEK_API_BASE_URL;
}

/**
 * 自定义 LLM 接入点在场判定（#43 异构降级触发面）：检视侧（REVIEWER_URL >
 * 旧名 DEEPSEEK_URL）或判定侧（JUDGE_URL > 旧名 OPENAI_URL）任一非空即 true
 * ——此时 judge/reviewer 可能同源但无法机械判定，异构校验由报错降级为
 * warning（judgeHeterogeneityOf）。只判断存在性，不读值。
 */
export function hasCustomLlmEndpoint(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const names = [...REVIEWER_URL_ENV_VARS, ...JUDGE_URL_ENV_VARS];
  return names.some((name) => (env[name]?.trim().length ?? 0) > 0);
}

/** 缺失清单 → 启动错误信息（英文，指明变量与用途；不含任何 key 值） */
export function envErrorMessage(missing: readonly string[]): string {
  const purposes = new Map<string, string>([
    [REVIEWER_KEY_REQUIREMENT, "the review model (reviewer LLM API)"],
    [JUDGE_KEY_REQUIREMENT, "LLM-as-judge stage (heterogeneous with the review model)"],
  ]);
  const lines = missing.map(
    (name) => `  - ${name}: required for ${purposes.get(name) ?? "this experiment"}`,
  );
  return [
    `experiment startup blocked: ${missing.length} required environment variable(s) missing:`,
    ...lines,
    "Keys are injected via environment variables only and never echoed to output.",
  ].join("\n");
}
