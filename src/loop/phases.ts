import type { ReviewPhase } from "../contracts/run.js";

/**
 * 六阶段骨架（主文档第 3 章）：阶段顺序固定，不可跳过、不可乱序。
 * 每个阶段至少产生一次 LLM 请求；阶段推进由 harness 驱动（脚本化回复填充内容）。
 */
export const PHASE_ORDER: readonly ReviewPhase[] = [
  "Change Understanding",
  "Risk Classification",
  "Context Decision",
  "Context Retrieval",
  "Deep Reasoning",
  "Evidence Verification",
];

/**
 * 阶段指令（Zone C 内的 harness 生成消息，逐字节稳定）。
 * 全英文：检视输出语言是产品配置项，POC1 锁定英文。
 */
export const PHASE_INSTRUCTIONS: Readonly<Record<ReviewPhase, string>> = {
  "Change Understanding": [
    "Phase 1 of 6 - Change Understanding.",
    "Analyze the unified diff of this merge request. Identify what changed, which files and symbols are involved, and the intent of the change.",
    'Reply with a single JSON object: {"summary": "<one-paragraph English summary of the change>"}',
  ].join("\n"),
  "Risk Classification": [
    "Phase 2 of 6 - Risk Classification.",
    "Classify the risk of this change.",
    'Reply with a single JSON object: {"riskClass": "Low" | "Medium" | "High", "reason": "<why>"}',
  ].join("\n"),
  "Context Decision": [
    "Phase 3 of 6 - Context Decision.",
    "Decide what additional context beyond the current conversation would be needed to review this change properly.",
    'Reply with a single JSON object: {"neededContext": ["<item>", ...], "reason": "<why>"}',
  ].join("\n"),
  "Context Retrieval": [
    "Phase 4 of 6 - Context Retrieval.",
    "Retrieve the context you decided is needed. If tools are available you may call them by replying with tool calls; otherwise state that no further context can be retrieved in this configuration.",
    'Reply with a single JSON object: {"notes": "<what context is now available, or why none could be retrieved>"}',
  ].join("\n"),
  "Deep Reasoning": [
    "Phase 5 of 6 - Deep Reasoning.",
    "Reason in depth about the change and produce candidate findings. Only raise candidates you can support with concrete evidence (No Evidence, No Finding).",
    'Reply with a single JSON object: {"candidates": [<finding objects per the Finding schema>, ...]}',
  ].join("\n"),
  "Evidence Verification": [
    "Phase 6 of 6 - Evidence Verification.",
    "Verify every candidate finding against the evidence. For each candidate decide whether the cited evidence actually supports the finding.",
    'Reply with a single JSON object: {"verdicts": [{"id": "<candidate id>", "pass": true | false, "reason": "<why>"}, ...], "complete": true | false}',
    '"complete" means the review is finished and no further round is needed; false means another review round is required.',
  ].join("\n"),
};

/** 从阶段指令文本中提取阶段名（测试/审计观测用） */
export function phaseFromInstruction(instruction: string): ReviewPhase | undefined {
  return PHASE_ORDER.find((phase) => PHASE_INSTRUCTIONS[phase] === instruction);
}
