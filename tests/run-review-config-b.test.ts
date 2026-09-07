import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeLlmClient } from "../src/fake/fake-llm-client.js";
import { SYSTEM_PROMPT } from "../src/loop/messages.js";
import { runReview } from "../src/run/run-review.js";
import { CONFIGS } from "../src/contracts/config.js";
import type { LlmMessage } from "../src/contracts/llm-client.js";
import { SAMPLE_MR_CASE } from "./fixtures/sample-mr-case.js";
import { HAPPY_PATH_FINDING, HAPPY_PATH_RESPONSES, HAPPY_PATH_TOTAL_USAGE } from "./helpers/happy-path-script.js";

/**
 * 工单 #4 主 seam 断言（fake LLM 捕获的请求）：
 * config B 请求含预取上下文且零工具；Zone B 位置与内容可复现；
 * Zone A 字节稳定不因 config 变化；预取顺序符合固定管线。
 */
let auditDir: string;

beforeAll(async () => {
  auditDir = await mkdtemp(path.join(tmpdir(), "review-agent-config-b-"));
});

afterAll(async () => {
  await rm(auditDir, { recursive: true, force: true });
});

describe("runReview — config B end-to-end (fake LLM, deterministic prefetch)", () => {
  it("completes the six-phase run with findings and usage accounting", async () => {
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    const result = await runReview(CONFIGS.B, SAMPLE_MR_CASE, fake, { auditDir });

    expect(result.configId).toBe("B");
    expect(result.rounds).toBe(1);
    expect(result.toolCalls).toBe(0);
    expect(result.findings).toEqual([{ ...HAPPY_PATH_FINDING, evidence: [...HAPPY_PATH_FINDING.evidence] }]);
    expect(result.usage).toEqual(HAPPY_PATH_TOTAL_USAGE);
    expect(result.audit.requests).toHaveLength(6);
    expect(result.audit.truncated).toBe(false);
  });

  it("sends zero tools in every config B request, even when tools are mounted via options", async () => {
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    await runReview(CONFIGS.B, SAMPLE_MR_CASE, fake, {
      auditDir,
      tools: [{ name: "review.get_symbol", description: "Get a symbol", parametersJson: '{"type":"object"}' }],
      toolExecutor: { execute: async () => "unused" },
    });
    expect(fake.callCount).toBe(6);
    for (const request of fake.capturedRequests) {
      expect(request.tools).toEqual([]);
    }
  });

  it("keeps Zone A byte-stable across configs: A and B send the identical system prompt", async () => {
    const fakeA = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    const fakeB = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    await runReview(CONFIGS.A, SAMPLE_MR_CASE, fakeA, { auditDir });
    await runReview(CONFIGS.B, SAMPLE_MR_CASE, fakeB, { auditDir });

    for (const request of [...fakeA.capturedRequests, ...fakeB.capturedRequests]) {
      const system = request.messages[0];
      expect(system?.role).toBe("system");
      expect(system?.content).toBe(SYSTEM_PROMPT);
    }
    expect(fakeA.capturedRequests[0]?.messages[0]).toEqual(fakeB.capturedRequests[0]?.messages[0]);
  });

  it("injects Zone B at a fixed position before the initial user message in every request", async () => {
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    await runReview(CONFIGS.B, SAMPLE_MR_CASE, fake, { auditDir });

    for (const request of fake.capturedRequests) {
      const zoneB = request.messages[1];
      expect(zoneB?.role).toBe("user");
      expect(zoneB?.content.startsWith("Repository context (Zone B).")).toBe(true);
      // Zone C 起点仍是初始 user 消息（diff），紧跟 Zone B 之后
      const initialUser = request.messages[2];
      expect(initialUser?.content).toContain(`Case ID: ${SAMPLE_MR_CASE.caseId}`);
      expect(initialUser?.content).toContain("Unified diff:");
    }
  });

  it("appends the prefetch layers after the diff message in fixed pipeline order", async () => {
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    await runReview(CONFIGS.B, SAMPLE_MR_CASE, fake, { auditDir });

    for (const request of fake.capturedRequests) {
      const messages = request.messages;
      const indexOf = (predicate: (message: LlmMessage) => boolean): number =>
        messages.findIndex(predicate);

      const diffIndex = indexOf((message) => message.content.includes("Unified diff:"));
      const symbolIndex = indexOf((message) => message.content.includes("- Symbol layer."));
      const referenceIndex = indexOf((message) => message.content.includes("- Reference layer."));
      const callChainIndex = indexOf((message) => message.content.includes("- Call chain layer."));
      const zoneBIndex = indexOf((message) => message.content.startsWith("Repository context (Zone B)."));

      // 固定管线：Diff → Symbol → Reference → Call Chain（Zone B 在 Zone C 起点之前）
      expect(zoneBIndex).toBe(1);
      expect(diffIndex).toBe(2);
      expect(symbolIndex).toBe(3);
      expect(referenceIndex).toBe(4);
      expect(callChainIndex).toBe(5);
    }
  });

  it("carries the prefetched symbol, reference and call-chain content", async () => {
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    await runReview(CONFIGS.B, SAMPLE_MR_CASE, fake, { auditDir });
    const messages = fake.capturedRequests[0]?.messages ?? [];
    const joined = messages.map((message) => message.content).join("\n");

    expect(joined).toContain("Repo name: sample-java-repo");
    expect(joined).toContain("public static int sumFirst(int[] values, int count)");
    expect(joined).toContain('Symbol "sumFirst": 2 match(es)');
    expect(joined).toContain("Calculator.total - src/main/java/com/example/math/Calculator.java:12");
    expect(joined).toContain("Main.main - src/main/java/com/example/math/Main.java:11");
  });

  it("keeps Zone C append-only: each request's messages are a strict prefix of the next", async () => {
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    await runReview(CONFIGS.B, SAMPLE_MR_CASE, fake, { auditDir });
    const requests = fake.capturedRequests;
    for (let i = 0; i + 1 < requests.length; i++) {
      const earlier = requests[i]?.messages ?? [];
      const later = requests[i + 1]?.messages ?? [];
      expect(earlier.length).toBeLessThan(later.length);
      expect(later.slice(0, earlier.length)).toEqual(earlier);
    }
  });

  it("reproduces the exact request bytes across two independent config B runs", async () => {
    const first = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    const second = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    await runReview(CONFIGS.B, SAMPLE_MR_CASE, first, { auditDir });
    await runReview(CONFIGS.B, SAMPLE_MR_CASE, second, { auditDir });

    expect(second.capturedRequests).toEqual(first.capturedRequests);
  });

  it("records the prefetch layer accounting in the audit and persists it to disk", async () => {
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    const result = await runReview(CONFIGS.B, SAMPLE_MR_CASE, fake, { auditDir });

    expect(result.audit.prefetch?.map((record) => record.layer)).toEqual([
      "zone-b",
      "symbol",
      "reference",
      "call-chain",
    ]);
    expect(result.audit.prefetch?.every((record) => record.truncated === false)).toBe(true);

    const raw = await readFile(result.auditPath as string, "utf8");
    const auditFile = JSON.parse(raw) as Record<string, unknown>;
    expect(auditFile.prefetch).toEqual(result.audit.prefetch);
    expect(auditFile.requests).toEqual(fake.capturedRequests);
  });

  it("keeps config A audits free of prefetch fields (no behavior change for non-prefetch configs)", async () => {
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    const result = await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, { auditDir });
    expect(result.audit.prefetch).toBeUndefined();
  });

  it("leaves an explicit truncation trail when prefetch budgets are exceeded via options", async () => {
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    const result = await runReview(CONFIGS.B, SAMPLE_MR_CASE, fake, {
      auditDir,
      prefetch: {
        zoneBBudgetChars: 700,
        symbolLayerBudgetChars: 150,
        referenceLayerBudgetChars: 150,
        callChainLayerBudgetChars: 150,
      },
    });

    const records = result.audit.prefetch ?? [];
    expect(records.map((record) => record.truncated)).toEqual([true, true, true, true]);
    const messages = fake.capturedRequests[0]?.messages ?? [];
    const joined = messages.map((message) => message.content).join("\n");
    expect(joined).toMatch(/truncated: showing \d+ of \d+ .+ \(zone B (repo-map|package-structure|symbol-index) budget \d+ chars exceeded\)/);
    expect(joined).toContain("Symbol layer truncated: showing 0 of 1 file entries (budget 150 chars exceeded).");
    expect(joined).toContain("Reference layer truncated: showing 0 of 1 symbol entries (budget 150 chars exceeded).");
    expect(joined).toContain("Call chain layer truncated: showing 0 of 1 chain entries (budget 150 chars exceeded).");
  });

  it("rejects a config B run against a missing repository path with a clear error", async () => {
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    await expect(
      runReview(CONFIGS.B, { ...SAMPLE_MR_CASE, repoPath: "Z:/definitely/not/a/repo" }, fake, { auditDir }),
    ).rejects.toThrow(/failed to build deterministic prefetch context: failed to list Java files/);
  });

  it("rejects invalid prefetch budget options at the system boundary", async () => {
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    await expect(
      runReview(CONFIGS.B, SAMPLE_MR_CASE, fake, {
        auditDir,
        prefetch: { referenceLayerBudgetChars: 0 },
      }),
    ).rejects.toThrow(/options\.prefetch\.referenceLayerBudgetChars must be a positive integer/);
  });
});
