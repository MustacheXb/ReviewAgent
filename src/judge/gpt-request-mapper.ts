/**
 * JudgeRequest → OpenAI Chat Completions 请求体（纯函数）。
 *
 * 字节纪律：字段顺序固定；校准参数锁定 MCR-Bench 论文协议值
 * （temperature 0.2、top_p 0.95）对所有模型不漂移；max_tokens 是防截断的
 * 容量上界——#42 起由共享包 provider 参数画像表驱动（review-llm profileOf）：
 * glm 等推理模型 completion 含 reasoning tokens 得 32768 信封（#39 实测），
 * 未知模型走保守默认画像 8192。
 * 模型异构约束（spec #1 user story 25）：judge 必须与被测 DeepSeek 不同源，
 * 客户端层拒绝 deepseek 系 model id。
 */

import type { JudgeRequest } from "./contracts.js";
import { JudgeClientError } from "./errors.js";
import { buildJudgeMessages } from "./prompt.js";
import type { JudgeContextLimits } from "./contracts.js";
import type { WireGptChatCompletionsRequest } from "./gpt-wire-types.js";
import { profileOf } from "review-llm";

/** 默认 judge 模型：论文 LLM-Hit-Judge 与人工 Human Hit Rate 的 QWK 一致性最高档（0.73） */
export const DEFAULT_JUDGE_MODEL = "gpt-5.2-pro";

/** judge 校准参数（论文 LLM-Hit-Judge 协议值，llm_evaluator.py 实测核验） */
export const JUDGE_TEMPERATURE = 0.2;
export const JUDGE_TOP_P = 0.95;

/**
 * 模型族感知 completion 预算（#42 起画像表驱动）：容量上界查 review-llm
 * provider 画像（glm 32768 / 默认 8192），校准参数（temperature/top_p）不随
 * 模型族。画像不序列化 max_tokens 的模型族（DeepSeek thinking wire）对 judge
 * 是 fail fast——judge wire 恒发 max_tokens（论文协议形状）。
 */
export function judgeCompletionCapOf(model: string): number {
  const envelope = profileOf(model).completionMaxTokens;
  if (envelope === undefined) {
    throw new JudgeClientError(
      `judge model ${JSON.stringify(model)} belongs to a provider family that serializes no max_tokens; the judge wire always sends max_tokens (MCR-Bench protocol shape), so this model family cannot serve the judge chain`,
    );
  }
  return envelope;
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
