/**
 * 实验启动环境校验（Ticket 12）：运行器启动时统一校验全部必需环境变量，
 * 缺失时给出清晰清单（fail fast），key 值只经环境变量注入、任何输出不回显。
 *
 * 必需性规则：
 * - DEEPSEEK_API_KEY：恒必需（检视主模型 deepseek-v4-flash，DeepSeekClient 构造
 *   fail fast；--report-only 重建报告时不执行检视则豁免）；
 * - judge key：plan.judge = true 时必需（LLM-as-judge，异构约束：judge 模型须与被测
 *   模型不同源，src/judge/gpt-judge-client.ts）——#42 起角色命名 JUDGE_API_KEY
 *   与旧名 OPENAI_API_KEY 任一非空即满足（推荐名在前，client 层同名序探测）。
 *
 * 变量名单源：检视主模型名自 review-llm（#41 共享常量），judge 角色名自
 * src/judge/gpt-judge-client.ts——预检与客户端不再各持一份字符串副本。
 */

import { DEEPSEEK_API_KEY_ENV_VAR } from "review-llm";
import { hasJudgeApiKey, JUDGE_API_KEY_ENV_VAR, OPENAI_API_KEY_ENV_VAR } from "../judge/index.js";

/** 未满足时的报告形态：推荐名在前，别名括注（与 client 层探测序一致） */
const JUDGE_KEY_REQUIREMENT = `${JUDGE_API_KEY_ENV_VAR} (or ${OPENAI_API_KEY_ENV_VAR})`;

export interface ExperimentEnvRequirements {
  /** 判定链 judge 阶段是否启用（启用则 judge key 双名任一必需） */
  readonly judge: boolean;
  /** 是否会执行检视运行（--report-only 重建报告时不执行 → DEEPSEEK_API_KEY 不必需；缺省 true） */
  readonly reviewRuns?: boolean;
}

export interface ExperimentEnvCheckResult {
  /** 未满足的环境变量要求（按校验顺序；双名要求为 "JUDGE_API_KEY (or OPENAI_API_KEY)" 形态） */
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
  if (requirements.reviewRuns !== false && !isPresent(env[DEEPSEEK_API_KEY_ENV_VAR])) {
    missing.push(DEEPSEEK_API_KEY_ENV_VAR);
  }
  if (requirements.judge && !hasJudgeApiKey(env)) {
    missing.push(JUDGE_KEY_REQUIREMENT);
  }
  return { missing, satisfied: missing.length === 0 };
}

/** 缺失清单 → 启动错误信息（英文，指明变量与用途；不含任何 key 值） */
export function envErrorMessage(missing: readonly string[]): string {
  const purposes = new Map<string, string>([
    [DEEPSEEK_API_KEY_ENV_VAR, "review model deepseek-v4-flash (DeepSeek API)"],
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

function isPresent(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
