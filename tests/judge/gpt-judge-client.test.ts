import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JudgeRequest } from "../../src/judge/contracts.js";
import {
  DEFAULT_GPT_JUDGE_RETRY_BASE_DELAY_MS,
  GptJudgeClient,
  OPENAI_API_KEY_ENV_VAR,
} from "../../src/judge/gpt-judge-client.js";
import {
  GptJudgeHttpError,
  GptJudgeNetworkError,
  GptJudgeResponseFormatError,
  JudgeClientError,
} from "../../src/judge/errors.js";
import { JUDGE_MAX_TOKENS, JUDGE_TEMPERATURE, JUDGE_TOP_P, validateModel } from "../../src/judge/gpt-request-mapper.js";
import {
  createFetchStub,
  createSleepRecorder,
  httpErrorBody,
  jsonResponse,
} from "../helpers/deepseek-stub.js";
import { wireAdjudicationText, wireMatch } from "./helpers.js";

const API_KEY = "test-judge-key-001";

function judgeRequest(): JudgeRequest {
  return {
    caseId: "case-001",
    findings: [
      { id: "F001", title: "t", description: "d", file: "f", line: 1, category: null, evidence: [] },
    ],
    truths: [
      { id: "TRUTH-1", title: "t", description: "d", file: null, lineStart: null, lineEnd: null, category: null, severity: null },
    ],
    context: null,
  };
}

function okJudgeResponse(content: string): Response {
  return jsonResponse(200, {
    id: "chatcmpl-test",
    object: "chat.completion",
    model: "gpt-5.2-pro",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  });
}

function happyAdjudication(): string {
  return wireAdjudicationText([wireMatch({ model: 1, truth: 1, confidence: "high" })]);
}

function makeClient(overrides: {
  readonly handler: Parameters<typeof createFetchStub>[0];
  readonly sleep?: (ms: number) => Promise<void>;
  readonly model?: string;
  readonly maxRetries?: number;
  readonly baseUrl?: string;
}): { readonly client: GptJudgeClient; readonly stub: ReturnType<typeof createFetchStub> } {
  const stub = createFetchStub(overrides.handler);
  const client = new GptJudgeClient({
    apiKey: API_KEY,
    fetchFn: stub.fetch,
    sleepFn: overrides.sleep ?? (async () => {}),
    ...(overrides.model !== undefined ? { model: overrides.model } : {}),
    ...(overrides.maxRetries !== undefined ? { maxRetries: overrides.maxRetries } : {}),
    ...(overrides.baseUrl !== undefined ? { baseUrl: overrides.baseUrl } : {}),
  });
  return { client, stub };
}

const originalEnvKey = process.env[OPENAI_API_KEY_ENV_VAR];

beforeEach(() => {
  delete process.env[OPENAI_API_KEY_ENV_VAR];
});

afterEach(() => {
  if (originalEnvKey === undefined) {
    delete process.env[OPENAI_API_KEY_ENV_VAR];
  } else {
    process.env[OPENAI_API_KEY_ENV_VAR] = originalEnvKey;
  }
});

describe("GptJudgeClient — API key 纪律", () => {
  it("无任何 key 来源时 fail fast", () => {
    expect(() => new GptJudgeClient()).toThrowError(
      /OpenAI API key is missing: set the OPENAI_API_KEY environment variable/,
    );
  });

  it("空白 key 拒绝；显式 key 优先于环境变量", async () => {
    expect(() => new GptJudgeClient({ apiKey: "   " })).toThrowError(/key is missing/);
    process.env[OPENAI_API_KEY_ENV_VAR] = "env-key";
    const { client, stub } = makeClient({ handler: () => okJudgeResponse(happyAdjudication()) });
    await client.adjudicate(judgeRequest());
    expect(stub.requests[0]?.headers.Authorization).toBe(`Bearer ${API_KEY}`);
  });

  it("环境变量 key 经 Bearer 头发送", async () => {
    process.env[OPENAI_API_KEY_ENV_VAR] = "env-judge-key";
    const stub = createFetchStub(() => okJudgeResponse(happyAdjudication()));
    const client = new GptJudgeClient({ fetchFn: stub.fetch, sleepFn: async () => {} });
    await client.adjudicate(judgeRequest());
    expect(stub.requests[0]?.headers.Authorization).toBe("Bearer env-judge-key");
  });
});

describe("GptJudgeClient — 请求 wire 形状（协议参数锁定）", () => {
  it("POST 到 OpenAI chat completions，judge 参数 = 论文协议值", async () => {
    const { client, stub } = makeClient({ handler: () => okJudgeResponse(happyAdjudication()) });
    await client.adjudicate(judgeRequest());

    const request = stub.requests[0];
    expect(request?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(request?.method).toBe("POST");
    expect(request?.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(request?.body ?? "{}") as Record<string, unknown>;
    expect(body.model).toBe("gpt-5.2-pro");
    expect(body.temperature).toBe(JUDGE_TEMPERATURE);
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(JUDGE_TOP_P);
    expect(body.top_p).toBe(0.95);
    expect(body.max_tokens).toBe(JUDGE_MAX_TOKENS);
    expect(body.max_tokens).toBe(8192);
    expect(body.stream).toBe(false);
    const messages = body.messages as { role: string; content: string }[];
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.role).toBe("user");
    expect(messages[1]?.content).toContain("<model_defect_1>");
    expect(messages[1]?.content).toContain("<ground_truth_defect_1>");
  });

  it("baseUrl 归一化（尾斜杠合并）", async () => {
    const { client, stub } = makeClient({
      handler: () => okJudgeResponse(happyAdjudication()),
      baseUrl: "http://localhost:9999/v1/",
    });
    await client.adjudicate(judgeRequest());
    expect(stub.requests[0]?.url).toBe("http://localhost:9999/v1/chat/completions");
  });

  it("构造参数校验：baseUrl 协议 / timeoutMs / maxRetries / retryBaseDelayMs", () => {
    expect(() => new GptJudgeClient({ apiKey: "k", baseUrl: "ftp://x" })).toThrowError(/baseUrl must start with/);
    expect(() => new GptJudgeClient({ apiKey: "k", timeoutMs: 0 })).toThrowError(/timeoutMs must be a positive integer/);
    expect(() => new GptJudgeClient({ apiKey: "k", maxRetries: -1 })).toThrowError(/maxRetries must be a non-negative integer/);
    expect(() => new GptJudgeClient({ apiKey: "k", retryBaseDelayMs: -1 })).toThrowError(/retryBaseDelayMs must be a non-negative integer/);
  });
});

describe("GptJudgeClient — 模型异构约束（spec user story 25）", () => {
  it("deepseek 系 model id 客户端层拒绝", async () => {
    const { client } = makeClient({
      handler: () => okJudgeResponse(happyAdjudication()),
      model: "deepseek-v3.2",
    });
    await expect(client.adjudicate(judgeRequest())).rejects.toThrowError(
      /must be GPT-family and heterogeneous/,
    );
  });

  it("validateModel：空 model 拒绝；gpt 系接受", () => {
    expect(() => validateModel("")).toThrowError(/must be a non-empty string/);
    expect(validateModel("gpt-5.2")).toBe("gpt-5.2");
  });
});

describe("GptJudgeClient — 有界重试", () => {
  it("429 → 指数退避重试后成功", async () => {
    const sleep = createSleepRecorder();
    const { client, stub } = makeClient({
      handler: (_request, index) =>
        index === 0
          ? jsonResponse(429, httpErrorBody("rate limited", "429"))
          : okJudgeResponse(happyAdjudication()),
      sleep: sleep.sleep,
    });
    const adjudication = await client.adjudicate(judgeRequest());
    expect(adjudication.matches).toHaveLength(1);
    expect(stub.requests).toHaveLength(2);
    expect(sleep.delays).toEqual([DEFAULT_GPT_JUDGE_RETRY_BASE_DELAY_MS]);
  });

  it("500 连续失败 → 重试 maxRetries 次后放弃（总尝试 = 1 + maxRetries）", async () => {
    const sleep = createSleepRecorder();
    const { client, stub } = makeClient({
      handler: () => jsonResponse(500, httpErrorBody("server exploded")),
      sleep: sleep.sleep,
      maxRetries: 3,
    });
    await expect(client.adjudicate(judgeRequest())).rejects.toThrowError(GptJudgeHttpError);
    expect(stub.requests).toHaveLength(4);
    expect(sleep.delays).toEqual([1000, 2000, 4000]);
  });

  it("503 可重试；400 不可重试（立即失败）", async () => {
    const sleep = createSleepRecorder();
    const retryable = makeClient({
      handler: (_request, index) =>
        index === 0 ? jsonResponse(503, httpErrorBody("unavailable")) : okJudgeResponse(happyAdjudication()),
      sleep: sleep.sleep,
    });
    await expect(retryable.client.adjudicate(judgeRequest())).resolves.toHaveProperty("matches");
    expect(retryable.stub.requests).toHaveLength(2);

    const fatal = makeClient({
      handler: () => jsonResponse(400, httpErrorBody("bad request")),
      sleep: sleep.sleep,
    });
    await expect(fatal.client.adjudicate(judgeRequest())).rejects.toThrowError(GptJudgeHttpError);
    expect(fatal.stub.requests).toHaveLength(1);
  });

  it("网络错误（fetch 抛错）可重试；重试后成功", async () => {
    const sleep = createSleepRecorder();
    const { client, stub } = makeClient({
      handler: (_request, index) => {
        if (index === 0) {
          throw new TypeError("fetch failed");
        }
        return okJudgeResponse(happyAdjudication());
      },
      sleep: sleep.sleep,
    });
    await expect(client.adjudicate(judgeRequest())).resolves.toHaveProperty("matches");
    expect(stub.requests).toHaveLength(2);
  });

  it("超时错误归类为 timedOut 网络错误", async () => {
    const { client } = makeClient({
      handler: () => {
        const error = new Error("The operation was aborted due to timeout");
        error.name = "TimeoutError";
        throw error;
      },
    });
    try {
      await client.adjudicate(judgeRequest());
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(GptJudgeNetworkError);
      expect((error as GptJudgeNetworkError).timedOut).toBe(true);
      expect((error as Error).message).toContain("timed out");
    }
  });
});

describe("GptJudgeClient — 响应处理", () => {
  it("解析 judge 裁定 JSON（1 起 → 0 起归一）", async () => {
    const { client } = makeClient({ handler: () => okJudgeResponse(happyAdjudication()) });
    const adjudication = await client.adjudicate(judgeRequest());
    expect(adjudication.matches).toEqual([
      { findingIndex: 0, truthIndex: 0, matchConfidence: "high", matchReason: "test reason" },
    ]);
  });

  it("响应体非法 JSON → GptJudgeResponseFormatError 且不重试", async () => {
    const { client, stub } = makeClient({ handler: () => jsonResponse(200, undefined) });
    await expect(client.adjudicate(judgeRequest())).rejects.toThrowError(GptJudgeResponseFormatError);
    expect(stub.requests).toHaveLength(1);
  });

  it("choices 缺失 / 空数组 → 格式错误", async () => {
    const emptyChoices = makeClient({ handler: () => jsonResponse(200, { choices: [] }) });
    await expect(emptyChoices.client.adjudicate(judgeRequest())).rejects.toThrowError(
      /choices must be a non-empty array/,
    );
  });

  it("finish_reason = length（max_tokens 截断）→ 显式失败不自动重试", async () => {
    const { client, stub } = makeClient({
      handler: () =>
        jsonResponse(200, {
          choices: [{ index: 0, message: { role: "assistant", content: '{"matches": [' }, finish_reason: "length" }],
        }),
    });
    await expect(client.adjudicate(judgeRequest())).rejects.toThrowError(
      /finish_reason "length"/,
    );
    expect(stub.requests).toHaveLength(1);
  });

  it("裁定正文不是 JSON（模型拒答文本）→ 格式错误，有界失败", async () => {
    const { client } = makeClient({
      handler: () => okJudgeResponse("I cannot evaluate these defects."),
    });
    await expect(client.adjudicate(judgeRequest())).rejects.toThrowError(
      /contains no JSON object/,
    );
  });
});

describe("GptJudgeClient — 错误信息安全", () => {
  it("错误消息不含 API key：异常文本回显 → [REDACTED]（网络错误路径）", async () => {
    const network = makeClient({ handler: () => {
      throw new TypeError(`connection refused for key ${API_KEY}`);
    } });
    try {
      await network.client.adjudicate(judgeRequest());
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("[REDACTED]");
      expect(message).not.toContain(API_KEY);
      expect(message).not.toContain("Bearer");
    }
  });

  it("错误消息不含 API key：服务端回显 → [REDACTED]（HTTP 错误路径）", async () => {
    const http = makeClient({
      handler: () => jsonResponse(400, httpErrorBody(`invalid api key ${API_KEY}`)),
    });
    try {
      await http.client.adjudicate(judgeRequest());
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("[REDACTED]");
      expect(message).not.toContain(API_KEY);
    }
  });

  it("JudgeClientError 判定链错误类型可用（is-a 校验）", () => {
    const error = new JudgeClientError("plain judge error");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("JudgeClientError");
  });
});
