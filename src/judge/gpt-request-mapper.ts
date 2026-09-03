/**
 * JudgeRequest → OpenAI Chat Completions 请求体（纯函数）。
 *
 * 字节纪律：字段顺序固定；judge 参数锁定 MCR-Bench 论文协议值
 * （temperature 0.2、top_p 0.95、max_tokens 8192），保证校准可复现。
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

/** judge 参数（论文 LLM-Hit-Judge 协议值，llm_evaluator.py 实测核验） */
export const JUDGE_TEMPERATURE = 0.2;
export const JUDGE_TOP_P = 0.95;
export const JUDGE_MAX_TOKENS = 8_192;

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
    max_tokens: JUDGE_MAX_TOKENS,
    stream: false,
  };
}

/** 非空校验 + 异构约束：拒绝 deepseek 系 model id（判定链要求 GPT 系异构校准） */
export function validateModel(model: string): string {
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new JudgeClientError(
      `judge model must be a non-empty string (got ${JSON.stringify(model)})`,
    );
  }
  if (/deepseek/i.test(model)) {
    throw new JudgeClientError(
      `judge model must be GPT-family and heterogeneous from the DeepSeek system under test (got ${JSON.stringify(model)}); the judgment chain requires a different model family (spec #1 user story 25)`,
    );
  }
  return model;
}
