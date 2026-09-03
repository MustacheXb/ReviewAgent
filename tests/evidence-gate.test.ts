import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmResponse } from "../src/contracts/llm-client.js";
import { FakeLlmClient } from "../src/fake/fake-llm-client.js";
import { runReview } from "../src/run/run-review.js";
import { CONFIGS } from "../src/contracts/config.js";
import { SAMPLE_MR_CASE } from "./fixtures/sample-mr-case.js";
import { reply } from "./helpers/llm-script.js";

/** Evidence Gate（No Evidence, No Finding）与候选拦截链 */

const VALID_CANDIDATE = {
  id: "F001",
  severity: "P1",
  category: "CORRECTNESS",
  file: "src/main/java/com/example/math/MathUtils.java",
  line: 20,
  title: "Off-by-one loop bound",
  description: "The loop reads one element beyond the requested range.",
  evidence: ["Diff line 20 shows the changed loop bound"],
  rule: "CORRECTNESS-001",
  confidence: 0.9,
};

const candidate = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  ...VALID_CANDIDATE,
  ...overrides,
});

const verdict = (id: string, pass: boolean, reason = "checked"): Record<string, unknown> => ({ id, pass, reason });

function oneRoundScript(candidates: unknown, verdicts: readonly unknown[]): readonly LlmResponse[] {
  return [
    reply('{"summary": "The change modifies a loop bound."}'),
    reply('{"riskClass": "Medium", "reason": "core logic"}'),
    reply('{"neededContext": [], "reason": "diff is enough"}'),
    reply('{"notes": "no additional context available"}'),
    reply(JSON.stringify({ candidates })),
    reply(JSON.stringify({ verdicts, complete: true })),
  ];
}

let auditDir: string;

beforeAll(async () => {
  auditDir = await mkdtemp(path.join(tmpdir(), "review-agent-gate-"));
});

afterAll(async () => {
  await rm(auditDir, { recursive: true, force: true });
});

describe("Evidence Gate", () => {
  it("blocks candidates without evidence and leaves a rejection trace (No Evidence, No Finding)", async () => {
    const withoutEvidence = candidate({ id: "F100", evidence: [] });
    const script = oneRoundScript([withoutEvidence, VALID_CANDIDATE], [verdict("F100", true), verdict("F001", true)]);
    const fake = FakeLlmClient.fromResponses(script);

    const result = await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, { auditDir });

    expect(result.findings.map((finding) => finding.id)).toEqual(["F001"]);
    expect(result.audit.rejections).toHaveLength(1);
    expect(result.audit.rejections[0]).toEqual({
      candidateId: "F100",
      stage: "NO_EVIDENCE",
      reason: "no evidence cited (No Evidence, No Finding)",
    });
  });

  it("blocks candidates whose evidence entries are all blank strings", async () => {
    const blankEvidence = candidate({ id: "F101", evidence: ["", "   "] });
    const script = oneRoundScript([blankEvidence], [verdict("F101", true)]);
    const fake = FakeLlmClient.fromResponses(script);

    const result = await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, { auditDir });

    expect(result.findings).toEqual([]);
    expect(result.audit.rejections[0]?.stage).toBe("NO_EVIDENCE");
  });

  it("blocks candidates whose evidence field is missing (schema-invalid)", async () => {
    const missingEvidence = { ...VALID_CANDIDATE, id: "F102" } as Record<string, unknown>;
    delete missingEvidence.evidence;
    const script = oneRoundScript([missingEvidence], [verdict("F102", true)]);
    const fake = FakeLlmClient.fromResponses(script);

    const result = await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, { auditDir });

    expect(result.findings).toEqual([]);
    expect(result.audit.rejections[0]?.stage).toBe("SCHEMA_INVALID");
    expect(result.audit.rejections[0]?.reason).toContain('"evidence"');
  });

  it("blocks candidates the verification verdict rejects, keeping the verdict reason", async () => {
    const script = oneRoundScript([VALID_CANDIDATE], [verdict("F001", false, "evidence does not support the claim")]);
    const fake = FakeLlmClient.fromResponses(script);

    const result = await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, { auditDir });

    expect(result.findings).toEqual([]);
    expect(result.audit.rejections[0]?.stage).toBe("VERIFICATION_FAILED");
    expect(result.audit.rejections[0]?.reason).toContain("evidence does not support the claim");
  });

  it("blocks candidates that received no verification verdict", async () => {
    const script = oneRoundScript([VALID_CANDIDATE], []);
    const fake = FakeLlmClient.fromResponses(script);

    const result = await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, { auditDir });

    expect(result.findings).toEqual([]);
    expect(result.audit.rejections[0]).toEqual({
      candidateId: "F001",
      stage: "VERIFICATION_FAILED",
      reason: "no verification verdict for candidate",
    });
  });

  it("blocks schema-invalid candidates with field-level reasons", async () => {
    const noSeverity = candidate({ id: "F200", severity: undefined });
    const badLine = candidate({ id: "F201", line: 0 });
    const badConfidence = candidate({ id: "F202", confidence: 1.5 });
    const script = oneRoundScript(
      [noSeverity, badLine, badConfidence],
      [verdict("F200", true), verdict("F201", true), verdict("F202", true)],
    );
    const fake = FakeLlmClient.fromResponses(script);

    const result = await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, { auditDir });

    expect(result.findings).toEqual([]);
    const rejections = result.audit.rejections;
    expect(rejections).toHaveLength(3);
    expect(rejections.every((rejection) => rejection.stage === "SCHEMA_INVALID")).toBe(true);
    expect(rejections[0]?.reason).toContain('"severity"');
    expect(rejections[1]?.reason).toContain('"line"');
    expect(rejections[2]?.reason).toContain('"confidence"');
  });

  it("blocks non-English candidates (POC1 output is all-English)", async () => {
    const chineseFinding = candidate({
      id: "F300",
      title: "循环边界差一错误",
      description: "循环会读取越界元素。",
    });
    const script = oneRoundScript([chineseFinding], [verdict("F300", true)]);
    const fake = FakeLlmClient.fromResponses(script);

    const result = await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, { auditDir });

    expect(result.findings).toEqual([]);
    expect(result.audit.rejections[0]).toEqual({
      candidateId: "F300",
      stage: "NON_ENGLISH",
      reason: "finding text must be English only",
    });
  });

  it("blocks duplicate candidate ids across rounds while keeping the first finding", async () => {
    const script = [
      reply('{"summary": "s"}'),
      reply('{"riskClass": "Low", "reason": "r"}'),
      reply('{"neededContext": [], "reason": "r"}'),
      reply('{"notes": "n"}'),
      reply(JSON.stringify({ candidates: [VALID_CANDIDATE] })),
      reply(JSON.stringify({ verdicts: [verdict("F001", true)], complete: false })),
      reply('{"summary": "s2"}'),
      reply('{"riskClass": "Low", "reason": "r"}'),
      reply('{"neededContext": [], "reason": "r"}'),
      reply('{"notes": "n"}'),
      reply(JSON.stringify({ candidates: [VALID_CANDIDATE] })),
      reply(JSON.stringify({ verdicts: [verdict("F001", true)], complete: true })),
    ];
    const fake = FakeLlmClient.fromResponses(script);

    const result = await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, { auditDir });

    expect(result.rounds).toBe(2);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.id).toBe("F001");
    expect(result.audit.rejections).toHaveLength(1);
    expect(result.audit.rejections[0]).toEqual({
      candidateId: "F001",
      stage: "DUPLICATE_ID",
      reason: "a finding with this id was already emitted in an earlier round",
    });
  });

  it("synthesizes a rejection id for candidates whose own id is missing", async () => {
    const idless = candidate({ id: "" });
    const script = oneRoundScript([idless], [verdict("", true)]);
    const fake = FakeLlmClient.fromResponses(script);

    const result = await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, { auditDir });

    expect(result.findings).toEqual([]);
    expect(result.audit.rejections[0]?.candidateId).toBe("round-1-candidate-0");
  });

  it("parses candidates wrapped in markdown code fences", async () => {
    const fenced = `\`\`\`json\n${JSON.stringify({ candidates: [VALID_CANDIDATE] })}\n\`\`\``;
    const script = [
      reply('{"summary": "s"}'),
      reply('{"riskClass": "Low", "reason": "r"}'),
      reply('{"neededContext": [], "reason": "r"}'),
      reply('{"notes": "n"}'),
      reply(fenced),
      reply(JSON.stringify({ verdicts: [verdict("F001", true)], complete: true })),
    ];
    const fake = FakeLlmClient.fromResponses(script);

    const result = await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, { auditDir });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.id).toBe("F001");
  });

  it("records a parse-failure note when Deep Reasoning replies with non-JSON", async () => {
    const script = [
      reply('{"summary": "s"}'),
      reply('{"riskClass": "Low", "reason": "r"}'),
      reply('{"neededContext": [], "reason": "r"}'),
      reply('{"notes": "n"}'),
      reply("I cannot answer in JSON, sorry."),
      reply(JSON.stringify({ verdicts: [], complete: true })),
    ];
    const fake = FakeLlmClient.fromResponses(script);

    const result = await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, { auditDir });

    expect(result.findings).toEqual([]);
    const deepReasoning = result.audit.phaseLog.find((entry) => entry.phase === "Deep Reasoning");
    expect(deepReasoning?.note).toContain("not valid JSON");
  });

  it("persists rejection traces to the audit file", async () => {
    const script = oneRoundScript([candidate({ id: "F400", evidence: [] })], [verdict("F400", true)]);
    const fake = FakeLlmClient.fromResponses(script);

    const result = await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, { auditDir });
    const auditFile = JSON.parse(await readFile(result.auditPath as string, "utf8")) as {
      rejections: { stage: string }[];
    };

    expect(auditFile.rejections).toEqual([{ candidateId: "F400", stage: "NO_EVIDENCE", reason: "no evidence cited (No Evidence, No Finding)" }]);
  });
});
