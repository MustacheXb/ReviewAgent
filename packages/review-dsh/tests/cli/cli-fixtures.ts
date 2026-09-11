/**
 * #26 CLI 测试共享夹具：F001 候选 + config A 六阶段回复。
 *
 * 进程内契约测试（cli-contract）与进程级烟测（cli-smoke）共用同一脚本——
 * 同一份 config A 剧本驱动两条验收轴，不在两个文件里各抄一份。
 */

import type { Finding } from "../../../../src/contracts/finding.js";

export const FINDING_F001: Finding = {
  id: "F001",
  severity: "P2",
  category: "CORRECTNESS",
  file: "src/main/java/Example.java",
  line: 42,
  title: "Incorrect URL encoding of query parameters",
  description: "The change encodes the joined query string instead of individual parameter values.",
  evidence: ["Example.java:42 - URLEncoder.encode applied to the joined query string"],
  rule: "CORRECTNESS-001",
  confidence: 0.9,
};

/** config A 六阶段的回复内容（phase 1–6；与进程内验收同内容） */
export const CONFIG_A_REPLIES: readonly string[] = [
  '{"summary":"The change replaces manual URL encoding with a utility call."}',
  '{"riskClass":"Medium","reason":"business logic change"}',
  '{"neededContext":[],"reason":"diff is self-contained"}',
  '{"notes":"No further context can be retrieved in this configuration."}',
  JSON.stringify({ candidates: [FINDING_F001] }),
  '{"verdicts":[{"id":"F001","pass":true,"reason":"evidence supports the finding"}],"complete":true}',
];

/** chat/completions 成功响应（DeepSeek 线上形状） */
export function chatResponse(content: string): string {
  return JSON.stringify({
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_cache_miss_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 50 },
  });
}

export function configAResponses(): string[] {
  return CONFIG_A_REPLIES.map(chatResponse);
}
