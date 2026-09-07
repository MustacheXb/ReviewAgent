import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeLlmClient, type FakeLlmScriptStep } from "../src/fake/fake-llm-client.js";
import type { MRCase } from "../src/contracts/mr-case.js";
import { runReview } from "../src/run/run-review.js";
import { CONFIGS, type ReviewConfig } from "../src/contracts/config.js";
import { SAMPLE_MR_CASE } from "./fixtures/sample-mr-case.js";
import { HAPPY_PATH_RESPONSES } from "./helpers/happy-path-script.js";
import { reply } from "./helpers/llm-script.js";

let auditDir: string;

beforeAll(async () => {
  auditDir = await mkdtemp(path.join(tmpdir(), "review-agent-validation-"));
});

afterAll(async () => {
  await rm(auditDir, { recursive: true, force: true });
});

describe("runReview input validation (system boundary)", () => {
  it("rejects a config with an unknown configId", async () => {
    const badConfig: unknown = { ...CONFIGS.A, configId: "Z" };
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    await expect(runReview(badConfig as ReviewConfig, SAMPLE_MR_CASE, fake, { auditDir })).rejects.toThrow(
      /config\.configId must be one of/,
    );
  });

  it("rejects a config with a non-boolean flag", async () => {
    const badConfig: unknown = { ...CONFIGS.A, toolsEnabled: "yes" };
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    await expect(runReview(badConfig as ReviewConfig, SAMPLE_MR_CASE, fake, { auditDir })).rejects.toThrow(
      /config\.toolsEnabled must be a boolean/,
    );
  });

  it("rejects an MR case with an empty diff", async () => {
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    const badCase = { ...SAMPLE_MR_CASE, diff: "   " };
    await expect(runReview(CONFIGS.A, badCase, fake, { auditDir })).rejects.toThrow(
      /mrCase\.diff must be a non-empty string/,
    );
  });

  it("rejects an MR case with an empty caseId", async () => {
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    const badCase = { ...SAMPLE_MR_CASE, caseId: "" };
    await expect(runReview(CONFIGS.A, badCase, fake, { auditDir })).rejects.toThrow(
      /mrCase\.caseId must be a non-empty string/,
    );
  });

  it("rejects an MR case with an invalid risk class", async () => {
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    const badCase: MRCase = {
      ...SAMPLE_MR_CASE,
      labels: { ...SAMPLE_MR_CASE.labels, riskClass: "Extreme" as MRCase["labels"]["riskClass"] },
    };
    await expect(runReview(CONFIGS.A, badCase, fake, { auditDir })).rejects.toThrow(
      /mrCase\.labels\.riskClass must be/,
    );
  });

  it("rejects an llmClient without complete()", async () => {
    await expect(
      runReview(CONFIGS.A, SAMPLE_MR_CASE, {} as never, { auditDir }),
    ).rejects.toThrow(/llmClient must implement complete/);
  });

  it("rejects invalid options (empty auditDir)", async () => {
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    await expect(runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, { auditDir: "" })).rejects.toThrow(
      /options\.auditDir must be a non-empty string/,
    );
  });

  it("rejects a non-object knowledge corpus", async () => {
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    await expect(
      runReview(CONFIGS.E, SAMPLE_MR_CASE, fake, { auditDir, knowledge: "rules.md" as unknown as never }),
    ).rejects.toThrow(/options\.knowledge must be a KnowledgeCorpus object/);
  });

  it("rejects knowledge entries with empty fields or malformed shapes", async () => {
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    await expect(
      runReview(CONFIGS.E, SAMPLE_MR_CASE, fake, {
        auditDir,
        knowledge: { rules: [{ id: "", title: "t", text: "x" }] },
      }),
    ).rejects.toThrow(/options\.knowledge\.rules entry\.id must be a non-empty string/);
    await expect(
      runReview(CONFIGS.E, SAMPLE_MR_CASE, fake, {
        auditDir,
        knowledge: { history: [{ id: "H001", title: "t", text: "   " }] },
      }),
    ).rejects.toThrow(/options\.knowledge\.history entry\.text must be a non-empty string/);
    await expect(
      runReview(CONFIGS.E, SAMPLE_MR_CASE, fake, {
        auditDir,
        knowledge: { rules: ["no-null-collections"] as unknown as never },
      }),
    ).rejects.toThrow(/options\.knowledge\.rules entries must be KnowledgeEntry objects/);
  });

  it("rejects duplicate entry ids within one knowledge corpus (fail fast)", async () => {
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    await expect(
      runReview(CONFIGS.E, SAMPLE_MR_CASE, fake, {
        auditDir,
        knowledge: {
          rules: [
            { id: "R001", title: "first", text: "one" },
            { id: "R001", title: "duplicate", text: "two" },
          ],
        },
      }),
    ).rejects.toThrow(/options\.knowledge\.rules contains duplicate entry id "R001"/);
  });
});

describe("runReview LLM error propagation (explicit failure, no silent swallow)", () => {
  it("wraps client failures with phase and round context", async () => {
    const script: FakeLlmScriptStep[] = [
      { kind: "reply", response: reply('{"summary": "s"}') },
      { kind: "fail", error: new Error("simulated API error") },
    ];
    const fake = new FakeLlmClient(script);

    const error = await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, { auditDir }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('phase "Risk Classification"');
    expect((error as Error).message).toContain("round 1");
    expect((error as Error).message).toContain("simulated API error");
  });

  it("propagates simulated timeouts as run failures with cause preserved", async () => {
    const script = [
      { kind: "delay" as const, ms: 5, then: { kind: "fail" as const, error: new Error("simulated timeout") } },
    ];
    const fake = new FakeLlmClient(script);

    const error = await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, { auditDir }).catch((cause: unknown) => cause);
    expect((error as Error).message).toContain('phase "Change Understanding"');
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect((error as Error & { cause: Error }).cause.message).toBe("simulated timeout");
  });

  it("surfaces script exhaustion (under-scripted fake) instead of hanging", async () => {
    const fake = FakeLlmClient.fromResponses([reply('{"summary": "s"}')]);

    await expect(runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, { auditDir })).rejects.toThrow(
      /LLM call failed during phase "Risk Classification" \(round 1\).*script exhausted/,
    );
  });
});
