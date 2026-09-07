import { describe, expect, it } from "vitest";
import type { LlmResponse } from "../../src/contracts/llm-client.js";
import { FakeLlmClient } from "../../src/fake/fake-llm-client.js";
import {
  VERIFIER_SYSTEM_PROMPT,
  buildVerifierMessages,
  runVerifierPass,
} from "../../src/experiment/verifier.js";
import { HAPPY_PATH_FINDING } from "../helpers/happy-path-script.js";
import { reply, usage } from "../helpers/llm-script.js";
import { experimentMainCase } from "./helpers.js";

/**
 * 二遍 Verifier（Ticket 12 消融开关）：同模型、零工具、单次调用、有界失败。
 * - 裁定语义：pass=false 剔除；无裁定条目保留（unverifiedFindingIds 留痕）；
 * - token 记账：usage 入 VerifierRecord（运行器并入 CARC）；
 * - 失败回退：调用异常 / 回复无裁定 → error，Finding 原样保留。
 */

const CASE = experimentMainCase("verifier-case-1");
const OPTIONS = { model: "deepseek-v4-flash", effort: "default" };

function verdictReply(
  verdicts: readonly { readonly id: string; readonly pass: boolean; readonly reason?: string }[],
): LlmResponse {
  return reply(
    JSON.stringify({
      verdicts: verdicts.map((verdict) => ({
        id: verdict.id,
        pass: verdict.pass,
        reason: verdict.reason ?? "reason",
      })),
      complete: true,
    }),
    usage(50, 5),
  );
}

describe("runVerifierPass（复核行为）", () => {
  it("零 Finding：跳过（不调用 LLM），usage 为零", async () => {
    const client = new FakeLlmClient([]);
    const result = await runVerifierPass(CASE, [], client, OPTIONS);
    expect(result.record.status).toBe("skipped-no-findings");
    expect(result.record.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(result.record.request).toBeUndefined();
    expect(client.callCount).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it("pass=true：Finding 保留，verdicts / usage / 可重放 request 字节留痕", async () => {
    const client = FakeLlmClient.fromResponses([
      verdictReply([{ id: "F001", pass: true, reason: "supported by the diff" }]),
    ]);
    const result = await runVerifierPass(CASE, [HAPPY_PATH_FINDING], client, OPTIONS);
    expect(result.record.status).toBe("verified");
    expect(result.record.errorMessage).toBeNull();
    expect(result.record.verdicts).toEqual([
      { id: "F001", pass: true, reason: "supported by the diff" },
    ]);
    expect(result.record.removedFindingIds).toEqual([]);
    expect(result.record.unverifiedFindingIds).toEqual([]);
    expect(result.record.usage).toEqual({ inputTokens: 50, outputTokens: 5 });
    expect(result.record.request?.messages).toHaveLength(2);
    expect(result.record.request?.tools).toEqual([]);
    expect(result.findings).toEqual([HAPPY_PATH_FINDING]);
  });

  it("pass=false：Finding 剔除并记 removedFindingIds", async () => {
    const client = FakeLlmClient.fromResponses([verdictReply([{ id: "F001", pass: false }])]);
    const result = await runVerifierPass(CASE, [HAPPY_PATH_FINDING], client, OPTIONS);
    expect(result.record.status).toBe("verified");
    expect(result.record.removedFindingIds).toEqual(["F001"]);
    expect(result.record.unverifiedFindingIds).toEqual([]);
    expect(result.findings).toEqual([]);
  });

  it("部分 Finding 无裁定：保留并记 unverifiedFindingIds（不静默丢弃）", async () => {
    const secondFinding = { ...HAPPY_PATH_FINDING, id: "F002" };
    const client = FakeLlmClient.fromResponses([verdictReply([{ id: "F001", pass: true }])]);
    const result = await runVerifierPass(CASE, [HAPPY_PATH_FINDING, secondFinding], client, OPTIONS);
    expect(result.record.verdicts.map((verdict) => verdict.id)).toEqual(["F001"]);
    expect(result.record.unverifiedFindingIds).toEqual(["F002"]);
    expect(result.findings.map((finding) => finding.id)).toEqual(["F001", "F002"]);
  });

  it("LLM 调用异常：status=error，Finding 原样保留，usage 为零", async () => {
    const client = new FakeLlmClient([{ kind: "fail", error: new Error("boom") }]);
    const result = await runVerifierPass(CASE, [HAPPY_PATH_FINDING], client, OPTIONS);
    expect(result.record.status).toBe("error");
    expect(result.record.errorMessage).toContain("boom");
    expect(result.record.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(result.findings).toEqual([HAPPY_PATH_FINDING]);
  });

  it("回复无可裁定条目（非法 JSON）：status=error，不伪装成已复核", async () => {
    const client = FakeLlmClient.fromResponses([reply("I cannot answer in JSON.", usage(10, 2))]);
    const result = await runVerifierPass(CASE, [HAPPY_PATH_FINDING], client, OPTIONS);
    expect(result.record.status).toBe("error");
    expect(result.record.errorMessage).toContain("no adjudicable verdicts");
    expect(result.record.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(result.findings).toEqual([HAPPY_PATH_FINDING]);
  });
});

describe("buildVerifierMessages（独立会话构造）", () => {
  it("[system(角色), user(MR + Finding 清单 + 指令)]，diff 与 issueDescription 内嵌", () => {
    const messages = buildVerifierMessages(CASE, [HAPPY_PATH_FINDING]);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toBe(VERIFIER_SYSTEM_PROMPT);
    const user = messages[1]?.content ?? "";
    expect(user).toContain(CASE.caseId);
    expect(user).toContain(CASE.diff.slice(0, 40));
    expect(user).toContain("F001");
    expect(user).toContain("Candidate findings (JSON):");
  });

  it("空 issueDescription 以 (none) 占位（消息形状稳定）", () => {
    const messages = buildVerifierMessages(
      { ...CASE, issueDescription: "" },
      [HAPPY_PATH_FINDING],
    );
    expect(messages[1]?.content).toContain("(none)");
  });
});
