import { describe, expect, it } from "vitest";
import {
  FakeLlmClient,
  LlmScriptExhaustedError,
  type FakeLlmScriptStep,
} from "../src/fake/fake-llm-client.js";
import type { LlmRequest } from "../src/contracts/llm-client.js";
import { reply, usage } from "./helpers/llm-script.js";

function sampleRequest(model: string): LlmRequest {
  return { model, effort: "default", messages: [{ role: "user", content: "hi" }], tools: [] };
}

describe("FakeLlmClient", () => {
  it("replies in scripted order and captures every request", async () => {
    const fake = FakeLlmClient.fromResponses([reply("one"), reply("two")]);
    expect((await fake.complete(sampleRequest("m1"))).content).toBe("one");
    expect((await fake.complete(sampleRequest("m2"))).content).toBe("two");
    expect(fake.callCount).toBe(2);
    expect(fake.capturedRequests.map((request) => request.model)).toEqual(["m1", "m2"]);
  });

  it("captures full request bytes including messages and tools", async () => {
    const request: LlmRequest = {
      model: "deepseek-v4-flash",
      effort: "default",
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "phase instruction" },
      ],
      tools: [{ name: "review.get_symbol", description: "get a symbol", parametersJson: "{}" }],
    };
    const fake = FakeLlmClient.fromResponses([reply("ok")]);
    await fake.complete(request);
    expect(fake.capturedRequests).toEqual([request]);
  });

  it("throws LlmScriptExhaustedError when the script runs out and no fallback is set", async () => {
    const fake = FakeLlmClient.fromResponses([reply("only-one")]);
    await fake.complete(sampleRequest("m"));
    const error = await fake.complete(sampleRequest("m")).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(LlmScriptExhaustedError);
    expect((error as Error).message).toMatch(/script exhausted after 1 call/);
    expect(fake.callCount).toBe(2);
  });

  it("falls back to the configured step when the script is exhausted", async () => {
    const fake = new FakeLlmClient(
      [{ kind: "reply", response: reply("first") }],
      { fallback: { kind: "reply", response: reply("fallback") } },
    );
    expect((await fake.complete(sampleRequest("m"))).content).toBe("first");
    expect((await fake.complete(sampleRequest("m"))).content).toBe("fallback");
    expect((await fake.complete(sampleRequest("m"))).content).toBe("fallback");
    expect(fake.callCount).toBe(3);
  });

  it("injects an error via a fail step", async () => {
    const error = new Error("simulated API error");
    const fake = new FakeLlmClient([{ kind: "fail", error }]);
    await expect(fake.complete(sampleRequest("m"))).rejects.toThrow("simulated API error");
    expect(fake.callCount).toBe(1);
  });

  it("simulates a timeout via a delay step that ends in failure", async () => {
    const timeoutStep: FakeLlmScriptStep = {
      kind: "delay",
      ms: 5,
      then: { kind: "fail", error: new Error("simulated timeout") },
    };
    const fake = new FakeLlmClient([timeoutStep, { kind: "reply", response: reply("after timeout") }]);
    await expect(fake.complete(sampleRequest("m"))).rejects.toThrow("simulated timeout");
    expect((await fake.complete(sampleRequest("m"))).content).toBe("after timeout");
  });

  it("captures a defensive copy: later mutation of the captured array does not affect requests", async () => {
    const fake = FakeLlmClient.fromResponses([reply("ok")]);
    await fake.complete(sampleRequest("m"));
    const first = fake.capturedRequests;
    const second = fake.capturedRequests;
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });

  it("reports usage from the scripted response", async () => {
    const fake = FakeLlmClient.fromResponses([reply("ok", usage(7, 3))]);
    const response = await fake.complete(sampleRequest("m"));
    expect(response.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });
});
