/**
 * reviewer 角色接入常量（#43）：角色命名环境变量 + 旧 provider 命名兼容别名。
 *
 * reviewer（被测模型，POC1 实验路径）的 url/key 走角色命名
 * `REVIEWER_URL` / `REVIEWER_API_KEY`，旧 provider 命名
 * `DEEPSEEK_URL` / `DEEPSEEK_API_KEY` 保留为兼容别名（推荐名在前，
 * 与 judge 链的 JUDGE_* / OPENAI_* 别名语义一致，#42）。
 *
 * 常量单源在此（而非 root 客户端）：reviewer 角色横跨 root POC1 与
 * packages/review-dsh 两条路径。当前消费方是 root 侧（客户端构造、实验
 * 预检、e2e 冒烟门）；review-dsh 的 LLM 适配器（deepseek-adapter）暂仍
 * 只认旧名 DEEPSEEK_API_KEY / DEEPSEEK_URL，#44 接入时复用此处常量收敛
 * ——届时探测序与存在性语义才真正两包单源。
 *
 * 画像（thinking 序列化 / completion 信封 / usage 能力）是正交的另一轴，
 * 见 ./profile.ts；本模块只管「连到哪、用什么凭证」。
 */

import { DEEPSEEK_API_KEY_ENV_VAR, DEEPSEEK_URL_ENV_VAR } from "./deepseek.js";
import type { EnvLookup } from "./resolver.js";

/** reviewer 角色 key 环境变量（#43 推荐名） */
export const REVIEWER_API_KEY_ENV_VAR = "REVIEWER_API_KEY";
/** reviewer 接入点环境变量（#43 推荐名；自定义 OpenAI 兼容网关端点） */
export const REVIEWER_URL_ENV_VAR = "REVIEWER_URL";

/** key 探测序（客户端构造与实验预检共用：REVIEWER_API_KEY > DEEPSEEK_API_KEY） */
export const REVIEWER_API_KEY_ENV_VARS = [REVIEWER_API_KEY_ENV_VAR, DEEPSEEK_API_KEY_ENV_VAR] as const;

/** 接入点探测序（REVIEWER_URL > DEEPSEEK_URL > 官方缺省） */
export const REVIEWER_URL_ENV_VARS = [REVIEWER_URL_ENV_VAR, DEEPSEEK_URL_ENV_VAR] as const;

/**
 * reviewer key 双名存在性探测（trim 后非空即视为已配置）：与客户端构造期
 * resolveApiKey 同名同序同 trim 语义——实验预检与 e2e 冒烟门共用此口径，
 * 避免各自复制探测逻辑后漂移。只判断存在性，不读值。
 */
export function hasReviewerApiKey(
  env: EnvLookup = process.env,
): boolean {
  return REVIEWER_API_KEY_ENV_VARS.some(
    (name) => (env[name]?.trim().length ?? 0) > 0,
  );
}
