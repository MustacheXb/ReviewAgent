/**
 * review-policy：核内政策插件（config A 移植源 = 冻结 harness src/loop/{messages,phases,constants}.ts）。
 *
 * Zone A（检视角色、六阶段方法论、Finding Schema、Severity、Evidence Policy）
 * 以 complete section 注册——它就是整个 system prompt，组装时替换全部 section，
 * 且不含任何 run 特定数据（字节稳定的充分条件由 review-profile 组装保证：
 * includeHarnessIdentity/includeRuntimeContext 双关断）。
 */

import type { Context, Plugin } from "@deepseek-ai/cordis";

/** POC1 Zone A 字节（1:1 移植自冻结 harness src/loop/messages.ts SYSTEM_PROMPT） */
export const ZONE_A = [
  "You are a senior Java code reviewer running inside a controlled review harness.",
  "",
  "## Mission",
  "Review the merge request (MR) provided by the user and produce structured, evidence-backed findings.",
  "",
  "## Review methodology (fixed phase order)",
  "The review proceeds through six phases. In each phase the harness instructs you with a \"Phase N of 6\" message. Phases always execute in this order:",
  "1. Change Understanding",
  "2. Risk Classification",
  "3. Context Decision",
  "4. Context Retrieval",
  "5. Deep Reasoning",
  "6. Evidence Verification",
  "",
  "## Evidence policy (No Evidence, No Finding)",
  "Every candidate finding must cite concrete evidence: specific symbols, line numbers, and code excerpts available in the MR diff or the conversation context. Candidates without evidence are rejected by the Evidence Gate and will not appear in the final findings.",
  "",
  "## Output language",
  "All review output must be in English. Findings containing non-English text are rejected.",
  "",
  "## Finding schema",
  "Each candidate finding is a JSON object with exactly these fields:",
  '- id: string, stable identifier, e.g. "F001"',
  '- severity: "P0" | "P1" | "P2" | "P3"',
  '- category: string, e.g. "CORRECTNESS", "RESOURCE", "CONCURRENCY", "SECURITY", "PERFORMANCE", "MAINTAINABILITY"',
  "- file: string, repository-relative path of the affected file",
  "- line: integer >= 1, line number in the file after the MR is applied",
  "- title: string, one-line summary",
  "- description: string, detailed explanation of the issue and its impact",
  "- evidence: array of strings, each entry cites a concrete symbol, line number, or code excerpt",
  '- rule: string, rule or pattern identifier, e.g. "CORRECTNESS-001"',
  "- confidence: number between 0 and 1",
  "",
  "## Severity definitions",
  "- P0: Critical. Must fix before merge (security vulnerability, data loss, crash).",
  "- P1: Major. Likely bug that breaks existing behavior or introduces a serious defect.",
  "- P2: Minor. Possible issue, edge case, or maintainability concern.",
  "- P3: Info. Style, naming, or documentation nit.",
  "",
  "## Risk classes",
  "- Low: comments, renames, formatting, mechanical changes.",
  "- Medium: business logic, API, state, or data-structure changes.",
  "- High: concurrency, transaction, security, resource, distributed, performance, or lifecycle changes.",
  "",
  "## Reply discipline",
  "When a phase message asks for a JSON reply, reply with a single JSON object and no other text.",
].join("\n");

/** 六阶段固定顺序（主文档第 3 章；不可跳过、不可乱序） */
export const REVIEW_PHASES = [
  "Change Understanding",
  "Risk Classification",
  "Context Decision",
  "Context Retrieval",
  "Deep Reasoning",
  "Evidence Verification",
] as const;

export type ReviewPhase = (typeof REVIEW_PHASES)[number];

/** 阶段指令（Zone C 内 harness 生成消息，逐字节稳定；1:1 移植 src/loop/phases.ts） */
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

/** Loop 硬上界（spec #1：不可通过 options 覆盖） */
export const MAX_ROUNDS = 5;
export const MAX_TOOL_CALLS = 6;

/** reviewPolicy 服务：config A 政策的唯一持有者（核内其他插件经 inject 消费） */
export interface ReviewPolicyService {
  /** Zone A 字节（complete system prompt） */
  readonly zoneA: string;
  /** 六阶段固定顺序 */
  readonly phases: readonly ReviewPhase[];
  /** 阶段指令（逐字节稳定） */
  readonly phaseInstruction: (phase: ReviewPhase) => string;
  /** Loop 硬上界：最大轮数 */
  readonly maxRounds: number;
  /** Loop 硬上界：单次检视工具调用总数 */
  readonly maxToolCalls: number;
  /** 模型路由（config A：deepseek / deepseek-v4-flash / effort default） */
  readonly provider: string;
  readonly model: string;
  readonly effortLabel: string;
  /** config A：零工具（Diff-only） */
  readonly toolsEnabled: boolean;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    reviewPolicy: ReviewPolicyService;
  }
}

/** review-policy 插件胚胎：Zone A complete section + 政策服务 */
export const reviewPolicy: Plugin.Object = {
  name: "review-policy",
  inject: ["systemPrompt"],
  apply(ctx: Context) {
    const disposer = ctx.systemPrompt.section({
      name: "review-zone-a",
      order: 100,
      text: ZONE_A,
      complete: true,
    });

    const service: ReviewPolicyService = {
      zoneA: ZONE_A,
      phases: REVIEW_PHASES,
      phaseInstruction: (phase) => PHASE_INSTRUCTIONS[phase],
      maxRounds: MAX_ROUNDS,
      maxToolCalls: MAX_TOOL_CALLS,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      effortLabel: "default",
      toolsEnabled: false,
    };

    const disposeService = ctx.provide("reviewPolicy", service);
    return () => {
      disposeService();
      disposer();
    };
  },
};
