/**
 * 实验启动环境校验（Ticket 12）：运行器启动时统一校验全部必需环境变量，
 * 缺失时给出清晰清单（fail fast），key 值只经环境变量注入、任何输出不回显。
 *
 * 必需性规则：
 * - DEEPSEEK_API_KEY：恒必需（检视主模型 deepseek-v4-flash，DeepSeekClient 构造 fail fast）；
 * - OPENAI_API_KEY：plan.judge = true 时必需（GPT 系 LLM-as-judge，异构约束：
 *   judge 不得用 deepseek 系模型，src/judge/gpt-judge-client.ts）。
 */

/** 检视主模型 key 的环境变量名（与 src/deepseek/ 保持一致） */
export const DEEPSEEK_API_KEY_ENV_VAR = "DEEPSEEK_API_KEY";
/** GPT 系 judge key 的环境变量名（与 src/judge/gpt-judge-client.ts 保持一致） */
export const OPENAI_API_KEY_ENV_VAR = "OPENAI_API_KEY";

export interface ExperimentEnvRequirements {
  /** 判定链 judge 阶段是否启用（启用则 OPENAI_API_KEY 必需） */
  readonly judge: boolean;
  /** 是否会执行检视运行（--report-only 重建报告时不执行 → DEEPSEEK_API_KEY 不必需；缺省 true） */
  readonly reviewRuns?: boolean;
}

export interface ExperimentEnvCheckResult {
  /** 缺失的环境变量名（按校验顺序） */
  readonly missing: readonly string[];
  /** true = 全部满足，可启动 */
  readonly satisfied: boolean;
}

/** 校验（纯函数：env 注入以便测试；只判断存在性，绝不读取/回显 key 值） */
export function checkExperimentEnv(
  requirements: ExperimentEnvRequirements,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ExperimentEnvCheckResult {
  const required: string[] = [];
  if (requirements.reviewRuns !== false) {
    required.push(DEEPSEEK_API_KEY_ENV_VAR);
  }
  if (requirements.judge) {
    required.push(OPENAI_API_KEY_ENV_VAR);
  }
  const missing = required.filter((name) => !isPresent(env[name]));
  return { missing, satisfied: missing.length === 0 };
}

/** 缺失清单 → 启动错误信息（英文，指明变量与用途；不含任何 key 值） */
export function envErrorMessage(missing: readonly string[]): string {
  const purposes = new Map<string, string>([
    [DEEPSEEK_API_KEY_ENV_VAR, "review model deepseek-v4-flash (DeepSeek API)"],
    [OPENAI_API_KEY_ENV_VAR, "LLM-as-judge stage (GPT, heterogeneous with the review model)"],
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
