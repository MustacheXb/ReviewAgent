import type { Finding } from "../contracts/finding.js";
import type { LlmClient, LlmMessage, LlmRequest } from "../contracts/llm-client.js";
import type { MRCase } from "../contracts/mr-case.js";
import { parseVerificationReply } from "../loop/parse.js";
import type { VerifierRecord } from "./run-store.js";

/**
 * 二遍 Verifier（Ticket 12 / issue #13 消融开关；spec #1 user story 16）：
 * 单遍自证（Evidence Verification 阶段内自我核查）为底线形态；
 * verifier on 时追加独立第二遍复核——同模型、零工具、单次调用、有界失败。
 *
 * - token 记账：Verifier 的 usage 由运行器并入 Run 总 usage（CARC 口径自然覆盖）；
 * - 裁定语义：pass=false 的 Finding 剔除；无裁定条目的 Finding 保留（不静默丢弃，
 *   以 unverifiedFindingIds 留痕）；
 * - 有界失败：LLM 调用异常 → status "error"，Finding 原样保留（回退单遍自证），
 *   错误信息留痕（不回显 API key——错误文本来自客户端层，已脱敏纪律）。
 */

/** Verifier 的 Zone A（字节稳定；与主循环 system prompt 相互独立） */
export const VERIFIER_SYSTEM_PROMPT = [
  "You are an independent verification pass in a controlled code review harness.",
  "",
  "## Mission",
  "A first review pass produced candidate findings for a merge request. Your only job is to verify each finding: does the cited evidence, checked against the merge request diff and the provided context, actually support the claimed issue?",
  "",
  "## Verification policy",
  "- Judge each finding independently; do not invent new findings.",
  '- "pass" means the finding is concretely supported by the diff or the stated context; "pass" false means the evidence does not support it (false positive).',
  "- Be strict about evidence: a plausible-sounding issue with no concrete support in the diff fails verification.",
  "",
  "## Reply discipline",
  'Reply with a single JSON object: {"verdicts": [{"id": "<finding id>", "pass": true | false, "reason": "<why>"}, ...], "complete": true}',
  "All output must be in English.",
].join("\n");

export interface VerifierOptions {
  readonly model: string;
  readonly effort: string;
}

export interface VerifierPassResult {
  /** 留痕（并入 RunRecord.verifierPass） */
  readonly record: VerifierRecord;
  /** 复核后的 Finding 集（skip / error 时与输入一致） */
  readonly findings: readonly Finding[];
}

/** 二遍复核：独立会话、零工具、单次调用（有界） */
export async function runVerifierPass(
  mrCase: MRCase,
  findings: readonly Finding[],
  llmClient: LlmClient,
  options: VerifierOptions,
): Promise<VerifierPassResult> {
  if (findings.length === 0) {
    return {
      record: {
        status: "skipped-no-findings",
        errorMessage: null,
        verdicts: [],
        removedFindingIds: [],
        unverifiedFindingIds: [],
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      findings,
    };
  }
  const request: LlmRequest = {
    model: options.model,
    effort: options.effort,
    messages: buildVerifierMessages(mrCase, findings),
    tools: [],
  };
  let content: string;
  let usage;
  try {
    const response = await llmClient.complete(request);
    content = response.content;
    usage = response.usage;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      record: {
        status: "error",
        errorMessage: `verifier pass failed; findings kept as verified by the single-pass baseline: ${message}`,
        verdicts: [],
        removedFindingIds: [],
        unverifiedFindingIds: [],
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      findings,
    };
  }
  const parsed = parseVerificationReply(content);
  if (parsed.verdicts.size === 0) {
    // 回复无可裁定条目（非法 JSON / verdicts 缺失）：调用成功但复核未发生——
    // 记为有界失败（error），Finding 原样保留（回退单遍自证），不伪装成已复核
    const note = parsed.note ?? "verifier reply adjudicated no findings";
    return {
      record: {
        status: "error",
        errorMessage: `verifier pass produced no adjudicable verdicts; findings kept as verified by the single-pass baseline: ${note}`,
        verdicts: [],
        removedFindingIds: [],
        unverifiedFindingIds: [],
        usage,
      },
      findings,
    };
  }
  const removedFindingIds: string[] = [];
  const unverifiedFindingIds: string[] = [];
  const verdicts: { id: string; pass: boolean; reason: string }[] = [];
  const kept = findings.filter((finding) => {
    const verdict = parsed.verdicts.get(finding.id);
    if (verdict === undefined) {
      unverifiedFindingIds.push(finding.id);
      return true;
    }
    verdicts.push({ id: finding.id, pass: verdict.pass, reason: verdict.reason });
    if (!verdict.pass) {
      removedFindingIds.push(finding.id);
      return false;
    }
    return true;
  });
  return {
    record: {
      status: "verified",
      errorMessage: null,
      verdicts,
      removedFindingIds,
      unverifiedFindingIds,
      usage,
      request,
    },
    findings: kept,
  };
}

/** Verifier 消息构造：[system(角色), user(MR + Finding 清单 + 指令)] */
export function buildVerifierMessages(
  mrCase: MRCase,
  findings: readonly Finding[],
): readonly LlmMessage[] {
  const issueDescription =
    mrCase.issueDescription.trim().length > 0 ? mrCase.issueDescription : "(none)";
  const content = [
    "Verify the candidate findings below for this merge request.",
    "",
    `Case ID: ${mrCase.caseId}`,
    "Issue description:",
    issueDescription,
    "",
    "Unified diff:",
    "```diff",
    mrCase.diff,
    "```",
    "",
    "Candidate findings (JSON):",
    "```json",
    JSON.stringify(findings, null, 2),
    "```",
    "",
    'Verify every finding. Reply with a single JSON object: {"verdicts": [{"id": "<finding id>", "pass": true | false, "reason": "<why>"}, ...], "complete": true}',
  ].join("\n");
  return [
    { role: "system", content: VERIFIER_SYSTEM_PROMPT },
    { role: "user", content },
  ];
}
