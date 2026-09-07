import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIGS } from "../../src/contracts/config.js";
import type { LlmRequest } from "../../src/contracts/llm-client.js";
import {
  DEEPSEEK_API_KEY_ENV_VAR,
  DeepSeekClient,
  DEFAULT_DEEPSEEK_RETRY_BASE_DELAY_MS,
} from "../../src/deepseek/deepseek-client.js";
import {
  DeepSeekHttpError,
  DeepSeekInsufficientResourceError,
  DeepSeekNetworkError,
  DeepSeekResponseFormatError,
} from "../../src/deepseek/errors.js";
import { SYSTEM_PROMPT } from "../../src/loop/messages.js";
import { runReview } from "../../src/run/run-review.js";
import { SAMPLE_MR_CASE } from "../fixtures/sample-mr-case.js";
import { HAPPY_PATH_FINDING, HAPPY_PATH_RESPONSES } from "../helpers/happy-path-script.js";
import {
  createFetchStub,
  createSleepRecorder,
  httpErrorBody,
  jsonResponse,
  textResponse,
  wireChatCompletion,
  type WireUsageFields,
} from "../helpers/deepseek-stub.js";

function baseRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: "deepseek-v4-flash",
    effort: "default",
    messages: [
      { role: "system", content: "system prompt" },
      { role: "user", content: "phase instruction" },
    ],
    tools: [],
    ...overrides,
  };
}

function okResponse(usage?: WireUsageFields | undefined): Response {
  return jsonResponse(200, wireChatCompletion({ content: "ok", usage }));
}

/** 环境变量隔离：每个用例从干净环境出发，结束恢复原始值 */
const originalEnvKey = process.env[DEEPSEEK_API_KEY_ENV_VAR];

beforeEach(() => {
  delete process.env[DEEPSEEK_API_KEY_ENV_VAR];
});

afterEach(() => {
  if (originalEnvKey === undefined) {
    delete process.env[DEEPSEEK_API_KEY_ENV_VAR];
  } else {
    process.env[DEEPSEEK_API_KEY_ENV_VAR] = originalEnvKey;
  }
});

describe("DeepSeekClient — API key handling", () => {
  it("fails fast with a clear message when no key is configured anywhere", () => {
    expect(() => new DeepSeekClient()).toThrowError(/DeepSeek API key is missing: set the DEEPSEEK_API_KEY/);
  });

  it("rejects a blank key instead of sending an empty credential", () => {
    expect(() => new DeepSeekClient({ apiKey: "   " })).toThrowError(
      /DeepSeek API key is missing: set the DEEPSEEK_API_KEY/,
    );
  });

  it("reads the key from the environment and sends it as a bearer token", async () => {
    process.env[DEEPSEEK_API_KEY_ENV_VAR] = "env-key-001";
    const stub = createFetchStub(() => okResponse());
    const client = new DeepSeekClient({ fetchFn: stub.fetch });
    await client.complete(baseRequest());
    expect(stub.requests[0]?.headers.Authorization).toBe("Bearer env-key-001");
  });

  it("prefers an explicitly passed key over the environment", async () => {
    process.env[DEEPSEEK_API_KEY_ENV_VAR] = "env-key-001";
    const stub = createFetchStub(() => okResponse());
    const client = new DeepSeekClient({ apiKey: "option-key-001", fetchFn: stub.fetch });
    await client.complete(baseRequest());
    expect(stub.requests[0]?.headers.Authorization).toBe("Bearer option-key-001");
  });
});

describe("DeepSeekClient — constructor option validation", () => {
  it("rejects invalid baseUrl, timeoutMs and maxRetries values", () => {
    expect(() => new DeepSeekClient({ apiKey: "test-key-001", baseUrl: "ftp://api.example.com" })).toThrowError(
      /baseUrl must start with/,
    );
    expect(() => new DeepSeekClient({ apiKey: "test-key-001", timeoutMs: 0 })).toThrowError(/timeoutMs must be a positive integer/);
    expect(() => new DeepSeekClient({ apiKey: "test-key-001", maxRetries: -1 })).toThrowError(
      /maxRetries must be a non-negative integer/,
    );
    expect(() => new DeepSeekClient({ apiKey: "test-key-001", retryBaseDelayMs: -5 })).toThrowError(
      /retryBaseDelayMs must be a non-negative integer/,
    );
  });

  it("normalizes a trailing slash in baseUrl", async () => {
    const stub = createFetchStub(() => okResponse());
    const client = new DeepSeekClient({ apiKey: "test-key-001", baseUrl: "https://api.deepseek.com/", fetchFn: stub.fetch });
    await client.complete(baseRequest());
    expect(stub.requests[0]?.url).toBe("https://api.deepseek.com/chat/completions");
  });
});

describe("DeepSeekClient — request wire shape", () => {
  it("posts an OpenAI-compatible body with locked bytes to the chat completions endpoint", async () => {
    const stub = createFetchStub(() => okResponse());
    const client = new DeepSeekClient({ apiKey: "test-key-001", fetchFn: stub.fetch });
    await client.complete(baseRequest());

    const request = stub.requests[0];
    expect(request?.url).toBe("https://api.deepseek.com/chat/completions");
    expect(request?.method).toBe("POST");
    expect(request?.headers["Content-Type"]).toBe("application/json");
    expect(request?.headers.Authorization).toBe("Bearer test-key-001");

    const body = JSON.parse(request?.body ?? "{}") as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["model", "messages", "thinking", "reasoning_effort", "stream"]);
    expect(body.model).toBe("deepseek-v4-flash");
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("high");
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "phase instruction" },
    ]);
  });

  it("serializes tool schemas and assistant tool-call rounds in the wire body", async () => {
    const stub = createFetchStub(() => okResponse());
    const client = new DeepSeekClient({ apiKey: "test-key-001", fetchFn: stub.fetch });
    await client.complete(
      baseRequest({
        messages: [
          { role: "system", content: "s" },
          { role: "user", content: "u" },
          { role: "assistant", content: "", toolCalls: [{ id: "call_0", name: "review.get_symbol", argumentsJson: '{"symbol":"X"}' }] },
          { role: "tool", content: "result", toolCallId: "call_0" },
        ],
        tools: [
          { name: "review.get_symbol", description: "Get a symbol", parametersJson: '{"type":"object"}' },
        ],
      }),
    );
    const body = JSON.parse(stub.requests[0]?.body ?? "{}") as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["model", "messages", "thinking", "reasoning_effort", "tools", "tool_choice", "stream"]);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: { name: "review.get_symbol", description: "Get a symbol", parameters: { type: "object" } },
      },
    ]);
    expect(body.tool_choice).toBe("auto");
    expect(body.messages).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "u" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_0", type: "function", function: { name: "review.get_symbol", arguments: '{"symbol":"X"}' } },
        ],
      },
      { role: "tool", content: "result", tool_call_id: "call_0" },
    ]);
  });

  it("validates the request before any network activity", async () => {
    const stub = createFetchStub(() => okResponse());
    const client = new DeepSeekClient({ apiKey: "test-key-001", fetchFn: stub.fetch });
    await expect(client.complete(baseRequest({ model: "deepseek-chat" }))).rejects.toThrowError(
      /unsupported model/,
    );
    await expect(client.complete(baseRequest({ effort: "low" }))).rejects.toThrowError(/effort is locked/);
    expect(stub.requests).toHaveLength(0);
  });
});

describe("DeepSeekClient — response mapping", () => {
  it("accounts real usage from the wire response (miss/hit split)", async () => {
    const stub = createFetchStub(() =>
      okResponse({ prompt_tokens: 24, prompt_cache_hit_tokens: 16, prompt_cache_miss_tokens: 8, completion_tokens: 12 }),
    );
    const client = new DeepSeekClient({ apiKey: "test-key-001", fetchFn: stub.fetch });
    const response = await client.complete(baseRequest());
    expect(response.content).toBe("ok");
    expect(response.toolCalls).toEqual([]);
    expect(response.usage).toEqual({ inputTokens: 8, outputTokens: 12, cacheReadTokens: 16 });
  });
});

describe("DeepSeekClient — retry policy (bounded, safe errors only)", () => {
  it("retries HTTP 429 with exponential backoff and succeeds", async () => {
    const sleep = createSleepRecorder();
    const stub = createFetchStub((_request, index) =>
      index === 0 ? jsonResponse(429, httpErrorBody("rate limit exceeded", "rate_limit_exceeded")) : okResponse(),
    );
    const client = new DeepSeekClient({ apiKey: "test-key-001", fetchFn: stub.fetch, sleepFn: sleep.sleep });
    const response = await client.complete(baseRequest());
    expect(response.content).toBe("ok");
    expect(stub.requests).toHaveLength(2);
    expect(sleep.delays).toEqual([DEFAULT_DEEPSEEK_RETRY_BASE_DELAY_MS]);
  });

  it("backs off exponentially across consecutive retries", async () => {
    const sleep = createSleepRecorder();
    const stub = createFetchStub((_request, index) =>
      index < 2 ? jsonResponse(429, httpErrorBody("rate limit exceeded")) : okResponse(),
    );
    const client = new DeepSeekClient({ apiKey: "test-key-001", fetchFn: stub.fetch, sleepFn: sleep.sleep });
    await client.complete(baseRequest());
    expect(sleep.delays).toEqual([1_000, 2_000]);
  });

  it.each([429, 500, 503])("retries transient HTTP %s", async (status) => {
    const stub = createFetchStub((_request, index) =>
      index === 0 ? jsonResponse(status, httpErrorBody("transient")) : okResponse(),
    );
    const client = new DeepSeekClient({ apiKey: "test-key-001", fetchFn: stub.fetch, sleepFn: async () => {} });
    const response = await client.complete(baseRequest());
    expect(response.content).toBe("ok");
    expect(stub.requests).toHaveLength(2);
  });

  it.each([400, 401, 402, 404, 422])("does not retry client-error HTTP %s", async (status) => {
    const stub = createFetchStub(() => jsonResponse(status, httpErrorBody("client error")));
    const client = new DeepSeekClient({ apiKey: "test-key-001", fetchFn: stub.fetch, sleepFn: async () => {} });
    await expect(client.complete(baseRequest())).rejects.toBeInstanceOf(DeepSeekHttpError);
    expect(stub.requests).toHaveLength(1);
  });

  it("gives up after maxRetries and throws the final HTTP error", async () => {
    const sleep = createSleepRecorder();
    const stub = createFetchStub(() => jsonResponse(429, httpErrorBody("rate limit exceeded")));
    const client = new DeepSeekClient({ apiKey: "test-key-001", fetchFn: stub.fetch, maxRetries: 2, sleepFn: sleep.sleep });
    const error = await client.complete(baseRequest()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DeepSeekHttpError);
    expect((error as DeepSeekHttpError).status).toBe(429);
    expect((error as DeepSeekHttpError).message).toContain("rate limit exceeded");
    expect(stub.requests).toHaveLength(3);
    expect(sleep.delays).toEqual([1_000, 2_000]);
  });

  it("falls back to statusText when the error body carries no message", async () => {
    const stub = createFetchStub(() => textResponse(503, ""));
    const client = new DeepSeekClient({ apiKey: "test-key-001", fetchFn: stub.fetch, sleepFn: async () => {} });
    const error = await client.complete(baseRequest()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DeepSeekHttpError);
    expect((error as DeepSeekHttpError).message).toMatch(/HTTP 503/);
  });

  it("includes the server message from a non-JSON error body", async () => {
    const stub = createFetchStub(() => textResponse(500, "<html>upstream exploded</html>"));
    const client = new DeepSeekClient({ apiKey: "test-key-001", fetchFn: stub.fetch, sleepFn: async () => {} });
    const error = await client.complete(baseRequest()).catch((cause: unknown) => cause);
    expect((error as DeepSeekHttpError).message).toContain("upstream exploded");
  });

  it("never leaks the API key in error messages", async () => {
    const stub = createFetchStub(() => jsonResponse(401, httpErrorBody("Authentication Fails")));
    const client = new DeepSeekClient({ apiKey: "sk-secret-value-001", fetchFn: stub.fetch, sleepFn: async () => {} });
    const error = await client.complete(baseRequest()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DeepSeekHttpError);
    expect((error as Error).message).toContain("401");
    expect((error as Error).message).not.toContain("sk-secret-value-001");
    for (const request of stub.requests) {
      expect(request.body).not.toContain("sk-secret-value-001");
    }
  });
});

describe("DeepSeekClient — error message redaction（key 绝不回显）", () => {
  const SECRET = "sk-redaction-secret-001";

  it("redacts the key echoed by an HTTP error body (server message path)", async () => {
    const stub = createFetchStub(() =>
      jsonResponse(401, httpErrorBody(`Authentication Fails for key ${SECRET}`)),
    );
    const client = new DeepSeekClient({ apiKey: SECRET, fetchFn: stub.fetch, sleepFn: async () => {} });
    const error = await client.complete(baseRequest()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DeepSeekHttpError);
    expect((error as Error).message).toContain("[REDACTED]");
    expect((error as Error).message).not.toContain(SECRET);
  });

  it("redacts the key echoed by a non-JSON 200 body (parseWire snippet path)", async () => {
    const stub = createFetchStub(() => textResponse(200, `Bearer ${SECRET} is not json`));
    const client = new DeepSeekClient({ apiKey: SECRET, fetchFn: stub.fetch, sleepFn: async () => {} });
    const error = await client.complete(baseRequest()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DeepSeekResponseFormatError);
    expect((error as Error).message).toContain("[REDACTED]");
    expect((error as Error).message).not.toContain(SECRET);
  });

  it("redacts the key echoed by a network failure message (post catch path)", async () => {
    const stub = createFetchStub(() => {
      throw new TypeError(`connection reset while sending Bearer ${SECRET}`);
    });
    const client = new DeepSeekClient({ apiKey: SECRET, fetchFn: stub.fetch, maxRetries: 0, sleepFn: async () => {} });
    const error = await client.complete(baseRequest()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DeepSeekNetworkError);
    expect((error as Error).message).toContain("[REDACTED]");
    expect((error as Error).message).not.toContain(SECRET);
  });

  it("redacts the key echoed by a failing body read (readBodyText path)", async () => {
    // Response 替身：ok = true 但 text() 拒绝并回显 key
    const bodyRejecting = {
      ok: true,
      status: 200,
      statusText: "OK",
      text: () => Promise.reject(new TypeError(`stream aborted after Bearer ${SECRET}`)),
    } as unknown as Response;
    const stub = createFetchStub(() => bodyRejecting);
    const client = new DeepSeekClient({ apiKey: SECRET, fetchFn: stub.fetch, maxRetries: 0, sleepFn: async () => {} });
    const error = await client.complete(baseRequest()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DeepSeekNetworkError);
    expect((error as Error).message).toContain("[REDACTED]");
    expect((error as Error).message).not.toContain(SECRET);
  });
});

describe("DeepSeekClient — network and timeout errors", () => {
  it("retries transient network failures", async () => {
    const stub = createFetchStub((_request, index) => {
      if (index === 0) {
        throw new TypeError("fetch failed");
      }
      return okResponse();
    });
    const client = new DeepSeekClient({ apiKey: "test-key-001", fetchFn: stub.fetch, sleepFn: async () => {} });
    const response = await client.complete(baseRequest());
    expect(response.content).toBe("ok");
    expect(stub.requests).toHaveLength(2);
  });

  it("wraps exhausted network failures in DeepSeekNetworkError with the cause preserved", async () => {
    const stub = createFetchStub(() => {
      throw new TypeError("fetch failed");
    });
    // key 用真实形态的长串：单字符 key 会被脱敏逻辑当作子串误伤错误文本
    const client = new DeepSeekClient({
      apiKey: "test-key-001",
      fetchFn: stub.fetch,
      maxRetries: 1,
      sleepFn: async () => {},
    });
    const error = await client.complete(baseRequest()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DeepSeekNetworkError);
    expect((error as Error).message).toContain("network error");
    expect((error as DeepSeekNetworkError).cause).toBeInstanceOf(TypeError);
    expect(stub.requests).toHaveLength(2);
  });

  it("treats timeouts as retryable transient errors and reports the configured budget", async () => {
    const stub = createFetchStub((_request, index) => {
      if (index === 0) {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return okResponse();
    });
    const client = new DeepSeekClient({ apiKey: "test-key-001", fetchFn: stub.fetch, timeoutMs: 5_000, sleepFn: async () => {} });
    const response = await client.complete(baseRequest());
    expect(response.content).toBe("ok");

    const exhausted = createFetchStub(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const failing = new DeepSeekClient({
      apiKey: "test-key-001",
      fetchFn: exhausted.fetch,
      timeoutMs: 5_000,
      maxRetries: 0,
      sleepFn: async () => {},
    });
    const error = await failing.complete(baseRequest()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DeepSeekNetworkError);
    expect((error as DeepSeekNetworkError).timedOut).toBe(true);
    expect((error as Error).message).toContain("timed out after 5000ms");
  });
});

describe("DeepSeekClient — malformed response bodies", () => {
  it("fails fast on a non-JSON 200 body without retrying", async () => {
    const stub = createFetchStub(() => textResponse(200, "<html>not json</html>"));
    const client = new DeepSeekClient({ apiKey: "test-key-001", fetchFn: stub.fetch, sleepFn: async () => {} });
    const error = await client.complete(baseRequest()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DeepSeekResponseFormatError);
    expect((error as Error).message).toContain("not valid JSON");
    expect(stub.requests).toHaveLength(1);
  });

  it("fails fast when the JSON body does not match the chat completions shape", async () => {
    const stub = createFetchStub(() => jsonResponse(200, { id: "unexpected" }));
    const client = new DeepSeekClient({ apiKey: "test-key-001", fetchFn: stub.fetch, sleepFn: async () => {} });
    await expect(client.complete(baseRequest())).rejects.toBeInstanceOf(DeepSeekResponseFormatError);
    expect(stub.requests).toHaveLength(1);
  });
});

describe("DeepSeekClient — insufficient_system_resource", () => {
  it("retries the DeepSeek-specific overload signal and merges usage across attempts", async () => {
    const insufficient = wireChatCompletion({
      content: "",
      finishReason: "insufficient_system_resource",
      usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10, completion_tokens: 5 },
    });
    const recovered = wireChatCompletion({
      content: "done",
      usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 7, completion_tokens: 2 },
    });
    const stub = createFetchStub((_request, index) => jsonResponse(200, index === 0 ? insufficient : recovered));
    const client = new DeepSeekClient({ apiKey: "test-key-001", fetchFn: stub.fetch, maxRetries: 1, sleepFn: async () => {} });
    const response = await client.complete(baseRequest());
    expect(response.content).toBe("done");
    expect(response.usage).toEqual({ inputTokens: 17, outputTokens: 7, cacheReadTokens: 3 });
    expect(stub.requests).toHaveLength(2);
  });

  it("throws DeepSeekInsufficientResourceError when retries are exhausted", async () => {
    const insufficient = wireChatCompletion({
      finishReason: "insufficient_system_resource",
      usage: { prompt_tokens: 10, prompt_cache_miss_tokens: 10, completion_tokens: 5 },
    });
    const stub = createFetchStub(() => jsonResponse(200, insufficient));
    const client = new DeepSeekClient({ apiKey: "test-key-001", fetchFn: stub.fetch, maxRetries: 1, sleepFn: async () => {} });
    const error = await client.complete(baseRequest()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DeepSeekInsufficientResourceError);
    expect(stub.requests).toHaveLength(2);
  });
});

describe("DeepSeekClient — drop-in replacement in runReview (zero harness changes)", () => {
  let auditDir: string;

  beforeEach(async () => {
    auditDir = await mkdtemp(path.join(tmpdir(), "review-agent-deepseek-"));
  });

  afterEach(async () => {
    await rm(auditDir, { recursive: true, force: true });
  });

  it("runs config A end-to-end against scripted wire responses and accounts miss/hit usage", async () => {
    // 与 fake happy-path 相同的六阶段回复内容，usage 换成 DeepSeek 线上字段（hit/miss 二分）
    const wireUsages: readonly WireUsageFields[] = [
      { prompt_tokens: 100, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100, completion_tokens: 10 },
      { prompt_tokens: 110, prompt_cache_hit_tokens: 50, prompt_cache_miss_tokens: 60, completion_tokens: 20 },
      { prompt_tokens: 120, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 60, completion_tokens: 30 },
      { prompt_tokens: 130, prompt_cache_hit_tokens: 70, prompt_cache_miss_tokens: 60, completion_tokens: 40 },
      { prompt_tokens: 140, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 60, completion_tokens: 50 },
      { prompt_tokens: 150, prompt_cache_hit_tokens: 90, prompt_cache_miss_tokens: 60, completion_tokens: 60 },
    ];
    const responses = HAPPY_PATH_RESPONSES.map((response, index) =>
      wireChatCompletion({ content: response.content, usage: wireUsages[index] }),
    );
    const stub = createFetchStub((_request, index) => jsonResponse(200, responses[index]));
    const client = new DeepSeekClient({
      apiKey: "test-key-001",
      fetchFn: stub.fetch,
      sleepFn: async () => {},
    });

    const result = await runReview(CONFIGS.A, SAMPLE_MR_CASE, client, { auditDir });

    expect(result.findings).toEqual([{ ...HAPPY_PATH_FINDING, evidence: [...HAPPY_PATH_FINDING.evidence] }]);
    // miss 求和进 inputTokens、hit 求和进 cacheReadTokens；cacheWriteTokens 保持缺省（无重复计数）
    expect(result.usage).toEqual({ inputTokens: 400, outputTokens: 210, cacheReadTokens: 350 });
    expect(result.usage).not.toHaveProperty("cacheWriteTokens");
    expect(result.auditPath).toBeDefined();
    expect(stub.requests).toHaveLength(6);

    const firstBody = JSON.parse(stub.requests[0]?.body ?? "{}") as Record<string, unknown>;
    expect(firstBody.model).toBe("deepseek-v4-flash");
    expect(firstBody.thinking).toEqual({ type: "enabled" });
    expect(firstBody.reasoning_effort).toBe("high");
    // 首个请求 = Zone A system + Zone C 初始 user（MR 输入）+ Phase 1 阶段指令
    expect(firstBody.messages).toHaveLength(3);
    const messages = firstBody.messages as { readonly role: string; readonly content: string }[];
    expect(messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    expect(messages[1]?.role).toBe("user");
    expect(messages[1]?.content).toContain(SAMPLE_MR_CASE.caseId);
    expect(messages[2]?.role).toBe("user");
  });
});
