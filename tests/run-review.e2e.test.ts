import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeLlmClient } from "../src/fake/fake-llm-client.js";
import { validateFinding } from "../src/finding/finding-schema.js";
import { PHASE_INSTRUCTIONS, PHASE_ORDER } from "../src/loop/phases.js";
import { SYSTEM_PROMPT } from "../src/loop/messages.js";
import { DEFAULT_EFFORT, DEFAULT_MODEL, runReview } from "../src/run/run-review.js";
import { CONFIGS } from "../src/contracts/config.js";
import type { LlmMessage } from "../src/contracts/llm-client.js";
import { SAMPLE_MR_CASE } from "./fixtures/sample-mr-case.js";
import { HAPPY_PATH_FINDING, HAPPY_PATH_RESPONSES, HAPPY_PATH_TOTAL_USAGE } from "./helpers/happy-path-script.js";

let auditDir: string;

beforeAll(async () => {
  auditDir = await mkdtemp(path.join(tmpdir(), "review-agent-audit-"));
});

afterAll(async () => {
  await rm(auditDir, { recursive: true, force: true });
});

describe("runReview — config A end-to-end (fake LLM)", () => {
  it("returns a schema-valid RunResult with findings, usage accounting and audit", async () => {
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    const result = await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, { auditDir });

    expect(result.caseId).toBe(SAMPLE_MR_CASE.caseId);
    expect(result.configId).toBe("A");
    expect(result.rounds).toBe(1);
    expect(result.toolCalls).toBe(0);
    expect(result.findings).toHaveLength(1);

    const finding = result.findings[0];
    expect(finding).toEqual({ ...HAPPY_PATH_FINDING, evidence: [...HAPPY_PATH_FINDING.evidence] });
    expect(validateFinding(finding)).toEqual([]);

    expect(result.usage).toEqual(HAPPY_PATH_TOTAL_USAGE);
    expect(result.audit.requests).toHaveLength(6);
    expect(result.audit.toolCallLog).toEqual([]);
    expect(result.audit.truncated).toBe(false);
    expect(result.audit.truncationReasons).toEqual([]);
    expect(result.audit.rejections).toEqual([]);
    expect(result.auditPath).toBeDefined();
  });

  it("drives the six phases in fixed order (observable at the LLM seam)", async () => {
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    const result = await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, { auditDir });

    // 每个请求的最后一条 user 消息 = 当前阶段的 harness 指令
    const phaseInstructions = fake.capturedRequests.map(
      (request) => request.messages[request.messages.length - 1],
    );
    for (const [index, phase] of PHASE_ORDER.entries()) {
      const message = phaseInstructions[index];
      expect(message?.role, `request ${index} should end with a user message`).toBe("user");
      expect(message?.content).toBe(PHASE_INSTRUCTIONS[phase]);
    }
    expect(fake.callCount).toBe(6);

    // 审计的 phaseLog 同样证明六阶段顺序固定
    expect(result.audit.phaseLog.map((entry) => entry.phase)).toEqual([...PHASE_ORDER]);
    expect(result.audit.phaseLog.every((entry) => entry.round === 1 && entry.requestCount === 1)).toBe(true);
  });

  it("includes no tool schema in any config A request, even when tools are mounted via options", async () => {
    const mountedTool = {
      name: "review.get_symbol",
      description: "Get a symbol definition",
      parametersJson: '{"type":"object"}',
    };
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, {
      auditDir,
      tools: [mountedTool],
    });
    for (const request of fake.capturedRequests) {
      expect(request.tools).toEqual([]);
    }
  });

  it("keeps Zone A byte-stable: identical system prompt, free of run-specific data", async () => {
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, { auditDir });
    const systemMessages = fake.capturedRequests.map((request) => request.messages[0]);
    for (const message of systemMessages) {
      expect(message?.role).toBe("system");
      expect(message?.content).toBe(SYSTEM_PROMPT);
    }
    expect(SYSTEM_PROMPT).not.toContain(SAMPLE_MR_CASE.caseId);
    expect(SYSTEM_PROMPT).not.toContain("sumFirst");
    expect(SYSTEM_PROMPT).toContain("No Evidence, No Finding");
  });

  it("builds Zone C append-only: each request's messages are a prefix of the next", async () => {
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, { auditDir });
    const requests = fake.capturedRequests;
    for (let i = 0; i + 1 < requests.length; i++) {
      const earlier = requests[i]?.messages ?? [];
      const later = requests[i + 1]?.messages ?? [];
      expect(earlier.length).toBeLessThan(later.length);
      expect(later.slice(0, earlier.length)).toEqual(earlier);
    }
  });

  it("carries the MR case (issue description + diff) in the initial user message", async () => {
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, { auditDir });
    const initialUser = fake.capturedRequests[0]?.messages.find(
      (message: LlmMessage) => message.role === "user",
    );
    expect(initialUser?.content).toContain(SAMPLE_MR_CASE.caseId);
    expect(initialUser?.content).toContain("for (int i = 0; i <= count; i++) {");
    expect(initialUser?.content).toContain(SAMPLE_MR_CASE.issueDescription);
  });

  it("pins model and effort to the locked experiment values", async () => {
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, { auditDir });
    for (const request of fake.capturedRequests) {
      expect(request.model).toBe(DEFAULT_MODEL);
      expect(request.effort).toBe(DEFAULT_EFFORT);
    }
  });

  it("produces all-English findings", async () => {
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    const result = await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, { auditDir });
    const cjk = /[㐀-䶿一-鿿豈-﫿　-〿＀-￯]/;
    for (const finding of result.findings) {
      expect(cjk.test(finding.title)).toBe(false);
      expect(cjk.test(finding.description)).toBe(false);
      for (const evidence of finding.evidence) {
        expect(cjk.test(evidence)).toBe(false);
      }
    }
  });

  it("persists every request byte and usage as an audit file on disk", async () => {
    const startedAt = new Date("2026-01-15T08:30:00.000Z");
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    const result = await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, {
      auditDir,
      now: () => startedAt,
    });

    expect(result.auditPath).toBeDefined();
    const raw = await readFile(result.auditPath as string, "utf8");
    const auditFile = JSON.parse(raw) as Record<string, unknown>;

    expect(auditFile.runId).toBe("20260115T083000.000-A-sample-mathutils-offbyone-001");
    expect(auditFile.caseId).toBe(SAMPLE_MR_CASE.caseId);
    expect(auditFile.configId).toBe("A");
    expect(auditFile.model).toBe(DEFAULT_MODEL);
    expect(auditFile.effort).toBe(DEFAULT_EFFORT);
    expect(auditFile.rounds).toBe(1);
    expect(auditFile.toolCalls).toBe(0);
    expect(auditFile.usage).toEqual(HAPPY_PATH_TOTAL_USAGE);
    expect(auditFile.findings).toEqual(result.findings);
    expect(auditFile.requests).toEqual(result.audit.requests);
    expect(auditFile.phaseLog).toEqual(result.audit.phaseLog);
    expect(auditFile.toolCallLog).toEqual([]);
    expect(auditFile.rejections).toEqual([]);
    // 请求字节可重放：落盘内容与 seam 捕获完全一致
    expect(auditFile.requests).toEqual(fake.capturedRequests);
  });
});
