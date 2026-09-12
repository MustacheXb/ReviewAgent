/**
 * JudgeRequest → OpenAI Chat Completions 请求体（纯函数）。
 *
 * 字节纪律：字段顺序固定；校准参数锁定 MCR-Bench 论文协议值
 * （temperature 0.2、top_p 0.95）对所有模型不漂移；max_tokens 是防截断的
 * 容量上界——模型族感知（#39）：8192 论文锚按 gpt-5.2-pro 纯内容剖面所定，
 * glm 等推理模型的 completion 含 reasoning tokens，需更大信封。
 * 模型异构约束（spec #1 user story 25）：judge 必须与被测 DeepSeek 不同源，
 * 客户端层拒绝 deepseek 系 model id。
 */

import type { JudgeRequest } from "./contracts.js";
import { JudgeClientError } from "./errors.js";
import { buildJudgeMessages } from "./prompt.js";
import type { JudgeContextLimits } from "./contracts.js";
import type { WireGptChatCompletionsRequest } from "./gpt-wire-types.js";

/** 默认 judge 模型：论文 LLM-Hit-Judge 与人工 Human Hit Rate 的 QWK 一致性最高档（0.73） */
export const DEFAULT_JUDGE_MODEL = "gpt-5.2-pro";

/** judge 校准参数（论文 LLM-Hit-Judge 协议值，llm_evaluator.py 实测核验） */
export const JUDGE_TEMPERATURE = 0.2;
export const JUDGE_TOP_P = 0.95;
/** 缺省 completion 容量（论文锚，按 gpt-5.2-pro 纯内容输出剖面所定） */
export const JUDGE_MAX_TOKENS = 8_192;

/**
 * 推理型 judge 模型的 completion 信封（#39）：glm-5.3 的 completion 含
 * reasoning tokens（#34 探针实测 3-finding 裁定 reasoning≈6k + content≈0.5k，
 * 8192 被 reasoning 吃满后 content=0 直接 finish_reason=length 截断）——
 * 按实测需求 6447 的 5 倍余量给 32768，覆盖多 finding 最坏情形（网关实测接受）。
 */
export const REASONING_JUDGE_MAX_TOKENS = 32_768;

/** 模型族感知 completion 预算：容量上界随模型族，校准参数（temperature/top_p）不随 */
export function judgeCompletionCapOf(model: string): number {
  return /^glm-/i.test(model) ? REASONING_JUDGE_MAX_TOKENS : JUDGE_MAX_TOKENS;
}

export interface GptRequestMapperOptions {
  readonly model?: string;
  readonly limits?: JudgeContextLimits;
}

export function buildGptJudgeBody(
  request: JudgeRequest,
  options: GptRequestMapperOptions = {},
): WireGptChatCompletionsRequest {
  const model = validateModel(options.model ?? DEFAULT_JUDGE_MODEL);
  const { systemPrompt, userPrompt } = buildJudgeMessages(request, options.limits);
  return {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: JUDGE_TEMPERATURE,
    top_p: JUDGE_TOP_P,
    max_tokens: judgeCompletionCapOf(model),
    stream: false,
  };
}

/** 非空校验 + 异构约束：拒绝 deepseek 系 model id（判定链要求与被测模型不同源，#33 措辞泛化） */
export function validateModel(model: string): string {
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new JudgeClientError(
      `judge model must be a non-empty string (got ${JSON.stringify(model)})`,
    );
  }
  if (/deepseek/i.test(model)) {
    throw new JudgeClientError(
      `judge model must be heterogeneous from the DeepSeek system under test (got ${JSON.stringify(model)}); the judgment chain requires a model from a different family (spec #1 user story 25)`,
    );
  }
  return model;
}
