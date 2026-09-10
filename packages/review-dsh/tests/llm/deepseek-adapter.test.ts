import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import { createUserMessage, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { describe, expect, it, vi } from "vitest";

import { buildInitialUserMessage, SYSTEM_PROMPT } from "../../../../src/loop/messages.js";
import { DeepSeekLlmAdapter } from "../../src/llm/deepseek-adapter.js";
import { WireRequestLog } from "../../src/llm/wire-log.js";
import type { MrInput } from "../../src/plugins/review-context.js";
import { mountAdapter } from "../helpers/mount-profile.js";

// ---------- 测试基建：fake fetch（零网络）----------

interface RecordedFetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

/** 可脚本化 fetch：按序消耗步骤，记录全部调用（url + init 原文） */
function scriptedFetch(steps: readonly Response[]) {
  const calls: RecordedFetchCall[] = [];
  let next = 0;
  const fetchFn = async (url: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? ({} as RequestInit) });
    const step = steps[next];
    next += 1;
    if (step === undefined) {
      throw new Error(`fake fetch script exhausted after ${calls.length} call(s)`);
    }
    return step;
  };
  return { fetchFn, calls };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number, message: string): Response {
  return jsonResponse({ error: { message, type: "server_error" } }, status);
}

interface ChatResponseFields {
  readonly content?: string | null;
  readonly reasoning?: string;
  readonly toolCalls?: readonly { readonly id: string; readonly name: string; readonly arguments: string }[];
  readonly usage?: Record<string, unknown>;
  readonly finishReason?: string;
}

/** chat/completions 非流式成功响应（DeepSeek 线上形状） */
function chatResponse(fields: ChatResponseFields): Response {
  return jsonResponse({
    choices: [
      {
        message: {
          content: fields.content ?? null,
          ...(fields.reasoning !== undefined ? { reasoning_content: fields.reasoning } : {}),
          ...(fields.toolCalls !== undefined
            ? {
                tool_calls: fields.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
        },
        finish_reason: fields.finishReason ?? "stop",
      },
    ],
    ...(fields.usage !== undefined ? { usage: fields.usage } : {}),
  });
}

function requestOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    reasoningEffort: ReasoningEffortId("default"),
    messages: [
      createUserMessage({ content: [{ type: "text", text: "hello" }], source: { kind: "user" } }),
    ],
    system: "Zone A bytes",
    ...overrides,
  };
}

const ZERO_WAIT_SLEEP = async () => {};

function makeAdapter(fetchFn: typeof fetch, wireLog?: WireRequestLog): DeepSeekLlmAdapter {
  return new DeepSeekLlmAdapter({
    apiKey: "sk-test-secret-123",
    fetchFn,
    sleepFn: ZERO_WAIT_SLEEP,
    ...(wireLog !== undefined ? { wireLog } : {}),
  });
}

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

/** 发送的请求体（fetch 收到的 body 原文反序列化） */
function sentBody(call: RecordedFetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

// ---------- ADR-0002 语义 ----------

describe("DeepSeekLlmAdapter：ADR-0002 语义（stream 直连，fake fetch 零网络）", () => {
  it("effort default 映射锁定档线上字节：thinking enabled + reasoning_effort high + stream false", async () => {
    const { fetchFn, calls } = scriptedFetch([chatResponse({ content: "ok" })]);
    const adapter = makeAdapter(fetchFn);

    await collect(adapter.stream(requestOptions()));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.deepseek.com/chat/completions");
    const body = sentBody(calls[0]!);
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("high");
    expect(body.stream).toBe(false);
  });

  it("请求不携带任何采样参数（temperature / top_p / max_tokens 一律缺席）", async () => {
    const { fetchFn, calls } = scriptedFetch([chatResponse({ content: "ok" })]);
    const adapter = makeAdapter(fetchFn);

    await collect(
      adapter.stream(requestOptions({ temperature: 0.7, maxTokens: 999, stop: ["END"] })),
    );

    const body = sentBody(calls[0]!);
    expect("temperature" in body).toBe(false);
    expect("top_p" in body).toBe(false);
    expect("max_tokens" in body).toBe(false);
    expect("stop" in body).toBe(false);
  });

  it("模型白名单：退役 id（deepseek-chat / deepseek-reasoner）拒绝，白名单内放行", async () => {
    const ok = scriptedFetch([chatResponse({ content: "ok" })]);
    await collect(makeAdapter(ok.fetchFn).stream(requestOptions()));
    expect(ok.calls).toHaveLength(1);

    const pro = scriptedFetch([chatResponse({ content: "ok" })]);
    await collect(makeAdapter(pro.fetchFn).stream(requestOptions({ model: "deepseek-v4-pro" })));
    expect(pro.calls).toHaveLength(1);

    for (const retired of ["deepseek-chat", "deepseek-reasoner"]) {
      const rejected = scriptedFetch([]);
      await expect(collect(makeAdapter(rejected.fetchFn).stream(requestOptions({ model: retired }))))
        .rejects.toThrow(/unsupported model/u);
      expect(rejected.calls).toHaveLength(0);
    }
  });

  it("effort 单档锁定：非 default effort 拒绝（实验不可漂移）", async () => {
    const { fetchFn, calls } = scriptedFetch([]);
    const adapter = makeAdapter(fetchFn);

    await expect(
      collect(adapter.stream(requestOptions({ reasoningEffort: ReasoningEffortId("medium") }))),
    ).rejects.toThrow(/effort is locked/u);
    expect(calls).toHaveLength(0);
  });

  it("usage 记账含 cached tokens：官方口径 miss/hit 不相交", async () => {
    const { fetchFn } = scriptedFetch([
      chatResponse({
        content: "ok",
        usage: {
          prompt_tokens: 1000,
          prompt_cache_hit_tokens: 700,
          prompt_cache_miss_tokens: 300,
          completion_tokens: 42,
        },
      }),
    ]);
    const adapter = makeAdapter(fetchFn);

    const chunks = await collect(adapter.stream(requestOptions()));

    expect(chunks).toContainEqual({
      type: "usage",
      usage: { inputTokens: 300, outputTokens: 42, cacheReadTokens: 700 },
    });
  });

  it("工具名双向映射：请求 review.* → wire review_*，响应 wire 名反解回内部点分名", async () => {
    const { fetchFn, calls } = scriptedFetch([
      chatResponse({
        content: null,
        toolCalls: [{ id: "call_1", name: "review_get_diff", arguments: "{}" }],
        finishReason: "tool_calls",
      }),
    ]);
    const adapter = makeAdapter(fetchFn);

    const chunks = await collect(
      adapter.stream(
        requestOptions({
          tools: [
            {
              name: "review.get_diff",
              description: "Get the MR diff.",
              parameters: { type: "object", properties: {} },
            },
          ],
        }),
      ),
    );

    // 请求侧：schema 名映射
    const body = sentBody(calls[0]!);
    const tools = body.tools as { function: { name: string } }[];
    expect(tools[0]?.function.name).toBe("review_get_diff");

    // 响应侧：wire 名反解回内部名
    const blockEnd = chunks.find(
      (chunk) => chunk.type === "block-end" && chunk.block.type === "tool-call",
    );
    expect(blockEnd).toMatchObject({ block: { type: "tool-call", name: "review.get_diff" } });
    expect(chunks.at(-1)).toMatchObject({ type: "finish", reason: { kind: "tool-calls" } });
  });
});

// ---------- wire 字节捕获 ----------

describe("DeepSeekLlmAdapter：wire 序列化点字节捕获（POC1 可重放字节契约）", () => {
  it("捕获的即发送的：wireLog 记录与 fetch 收到的 body 原文逐字节相等", async () => {
    const wireLog = new WireRequestLog();
    const { fetchFn, calls } = scriptedFetch([chatResponse({ content: "ok" })]);
    const adapter = makeAdapter(fetchFn, wireLog);

    await collect(adapter.stream(requestOptions()));

    expect(wireLog.requests).toHaveLength(1);
    const captured = wireLog.requests[0]!;
    expect(captured.text).toBe(String(calls[0]?.init.body));
    // 可重放性：原文反序列化回完整请求体
    expect(JSON.parse(captured.text)).toMatchObject({
      model: "deepseek-v4-flash",
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
  });

  it("一次逻辑调用只记一条：重试复用同一字节（429 → 200）", async () => {
    const wireLog = new WireRequestLog();
    const { fetchFn, calls } = scriptedFetch([
      errorResponse(429, "rate limited"),
      chatResponse({ content: "ok" }),
    ]);
    const adapter = makeAdapter(fetchFn, wireLog);

    const chunks = await collect(adapter.stream(requestOptions()));

    expect(calls).toHaveLength(2);
    expect(calls[0]?.init.body).toBe(calls[1]?.init.body);
    expect(wireLog.requests).toHaveLength(1);
    expect(chunks.at(-1)).toMatchObject({ type: "finish", reason: { kind: "stop" } });
  });

  it("本地构造错不消耗脚本也不捕获（模型白名单拒绝先于序列化）", async () => {
    const wireLog = new WireRequestLog();
    const { fetchFn, calls } = scriptedFetch([]);
    const adapter = makeAdapter(fetchFn, wireLog);

    await expect(
      collect(adapter.stream(requestOptions({ model: "deepseek-chat" }))),
    ).rejects.toThrow(/unsupported model/u);
    expect(calls).toHaveLength(0);
    expect(wireLog.requests).toHaveLength(0);
  });
});

// ---------- StreamChunk 块协议 ----------

describe("DeepSeekLlmAdapter：非流式响应 → 块序列（DSH StreamChunk 协议）", () => {
  it("纯文本回复：block-start → text-delta → block-end → usage → finish(stop)", async () => {
    const { fetchFn } = scriptedFetch([
      chatResponse({ content: '{"summary":"x"}', usage: { prompt_cache_miss_tokens: 5, completion_tokens: 3 } }),
    ]);
    const adapter = makeAdapter(fetchFn);

    const chunks = await collect(adapter.stream(requestOptions()));

    expect(chunks).toEqual([
      { type: "block-start", index: 0, blockType: "text" },
      { type: "text-delta", index: 0, text: '{"summary":"x"}' },
      { type: "block-end", index: 0, block: { type: "text", text: '{"summary":"x"}' } },
      { type: "usage", usage: { inputTokens: 5, outputTokens: 3 } },
      { type: "finish", reason: { kind: "stop" } },
    ]);
  });

  it("reasoning_content 先行（thinking 模式：reasoning 块在 text 块之前）", async () => {
    const { fetchFn } = scriptedFetch([
      chatResponse({ reasoning: "let me think", content: "answer" }),
    ]);
    const adapter = makeAdapter(fetchFn);

    const chunks = await collect(adapter.stream(requestOptions()));

    expect(chunks[0]).toEqual({ type: "block-start", index: 0, blockType: "reasoning" });
    expect(chunks[1]).toEqual({ type: "reasoning-delta", index: 0, text: "let me think" });
    expect(chunks[2]).toEqual({ type: "block-end", index: 0, block: { type: "reasoning", text: "let me think" } });
    expect(chunks[3]).toEqual({ type: "block-start", index: 1, blockType: "text" });
    expect(chunks.at(-1)).toEqual({ type: "finish", reason: { kind: "stop" } });
  });

  it("工具调用回复：tool-call 块 + finish(tool-calls)", async () => {
    const { fetchFn } = scriptedFetch([
      chatResponse({
        content: "checking",
        toolCalls: [{ id: "call_9", name: "review_get_diff", arguments: "{\"path\":\"a\"}" }],
        finishReason: "tool_calls",
      }),
    ]);
    const adapter = makeAdapter(fetchFn);

    const chunks = await collect(
      adapter.stream(
        requestOptions({
          tools: [
            { name: "review.get_diff", description: "Get the MR diff.", parameters: { type: "object", properties: {} } },
          ],
        }),
      ),
    );

    expect(chunks).toEqual([
      { type: "block-start", index: 0, blockType: "text" },
      { type: "text-delta", index: 0, text: "checking" },
      { type: "block-end", index: 0, block: { type: "text", text: "checking" } },
      { type: "block-start", index: 1, blockType: "tool-call" },
      { type: "tool-call-delta", index: 1, id: "call_9", name: "review.get_diff", argumentsDelta: "{\"path\":\"a\"}" },
      {
        type: "block-end",
        index: 1,
        block: { type: "tool-call", id: "call_9", name: "review.get_diff", arguments: "{\"path\":\"a\"}" },
      },
      { type: "finish", reason: { kind: "tool-calls" } },
    ]);
  });

  it("finish_reason 映射：length → max-tokens；未知值 → error（code = 大写原值）", async () => {
    const lengthFetch = scriptedFetch([chatResponse({ content: "x", finishReason: "length" })]);
    const lengthChunks = await collect(makeAdapter(lengthFetch.fetchFn).stream(requestOptions()));
    expect(lengthChunks.at(-1)).toEqual({ type: "finish", reason: { kind: "max-tokens" } });

    const filterFetch = scriptedFetch([chatResponse({ content: "x", finishReason: "content_filter" })]);
    const filterChunks = await collect(makeAdapter(filterFetch.fetchFn).stream(requestOptions()));
    expect(filterChunks.at(-1)).toEqual({
      type: "finish",
      reason: { kind: "error", failure: { message: expect.stringMatching(/content_filter/u), code: "CONTENT_FILTER" } },
    });
  });
});

// ---------- 重试语义 ----------

describe("DeepSeekLlmAdapter：重试语义（POC1 有界重试，适配器内保留）", () => {
  it("可重试状态码（429/500/503）重试后成功", async () => {
    for (const status of [429, 500, 503]) {
      const { fetchFn, calls } = scriptedFetch([
        errorResponse(status, "transient"),
        chatResponse({ content: "ok" }),
      ]);
      const chunks = await collect(makeAdapter(fetchFn).stream(requestOptions()));
      expect(calls).toHaveLength(2);
      expect(chunks.at(-1)).toMatchObject({ type: "finish", reason: { kind: "stop" } });
    }
  });

  it("insufficient_system_resource：失败尝试已消耗的 usage 并账（真实成本不丢）", async () => {
    const { fetchFn } = scriptedFetch([
      chatResponse({
        content: null,
        finishReason: "insufficient_system_resource",
        usage: { prompt_cache_miss_tokens: 10, completion_tokens: 2 },
      }),
      chatResponse({
        content: "ok",
        usage: { prompt_cache_miss_tokens: 300, prompt_cache_hit_tokens: 700, completion_tokens: 42 },
      }),
    ]);
    const adapter = makeAdapter(fetchFn);

    const chunks = await collect(adapter.stream(requestOptions()));

    expect(chunks).toContainEqual({
      type: "usage",
      usage: { inputTokens: 310, outputTokens: 44, cacheReadTokens: 700 },
    });
    expect(chunks.at(-1)).toMatchObject({ type: "finish", reason: { kind: "stop" } });
  });

  it("重试耗尽 → 终态 error finish（携 status 与稳定 code）", async () => {
    const { fetchFn, calls } = scriptedFetch([
      errorResponse(429, "rate limited"),
      errorResponse(429, "rate limited"),
      errorResponse(429, "rate limited"),
      errorResponse(429, "rate limited"),
    ]);
    const adapter = makeAdapter(fetchFn);

    const chunks = await collect(adapter.stream(requestOptions()));

    // 默认 maxRetries = 3 → 总尝试 4
    expect(calls).toHaveLength(4);
    expect(chunks.at(-1)).toEqual({
      type: "finish",
      reason: {
        kind: "error",
        failure: { message: expect.stringMatching(/429/u) as string, code: "RATE_LIMIT", status: 429 },
      },
    });
  });

  it("不可重试 HTTP（400）直接终态，单次尝试", async () => {
    const { fetchFn, calls } = scriptedFetch([errorResponse(400, "bad request")]);
    const adapter = makeAdapter(fetchFn);

    const chunks = await collect(adapter.stream(requestOptions()));

    expect(calls).toHaveLength(1);
    expect(chunks.at(-1)).toMatchObject({
      type: "finish",
      reason: { kind: "error", failure: { status: 400 } },
    });
  });
});

// ---------- 凭据与请求头纪律 ----------

describe("DeepSeekLlmAdapter：凭据与请求头纪律", () => {
  it("attribution headers 必带（LlmAdapter 契约：每个 provider 请求都携带）", async () => {
    const { fetchFn, calls } = scriptedFetch([chatResponse({ content: "ok" })]);
    await collect(makeAdapter(fetchFn).stream(requestOptions()));

    const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.authorization).toBe("Bearer sk-test-secret-123");
    expect(headers["user-agent"]).toBeTruthy();
  });

  it("key 绝不落错误信息（服务端回显时脱敏）", async () => {
    // 400 不可重试：单次尝试即终态，脱敏断言不受重试路径干扰
    const { fetchFn } = scriptedFetch([errorResponse(400, "echoed sk-test-secret-123 in message")]);
    const adapter = makeAdapter(fetchFn);

    const chunks = await collect(adapter.stream(requestOptions()));

    const finish = chunks.at(-1);
    expect(finish?.type).toBe("finish");
    if (finish?.type === "finish" && finish.reason.kind === "error") {
      expect(finish.reason.failure.message).not.toContain("sk-test-secret-123");
      expect(finish.reason.failure.message).toContain("[REDACTED]");
    } else {
      expect.unreachable("expected terminal error finish");
    }
  });

  it("缺 key fail fast：构造期即报 DEEPSEEK_API_KEY（消息不回显任何值）", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    try {
      expect(
        () => new DeepSeekLlmAdapter({ fetchFn: async () => new Response("{}", { status: 200 }) }),
      ).toThrow(/DEEPSEEK_API_KEY/u);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("options.signal 预中止 → aborted finish，零网络", async () => {
    const { fetchFn, calls } = scriptedFetch([chatResponse({ content: "ok" })]);
    const adapter = makeAdapter(fetchFn);
    const controller = new AbortController();
    controller.abort();

    const chunks = await collect(adapter.stream(requestOptions({ signal: controller.signal })));

    expect(calls).toHaveLength(0);
    expect(chunks).toEqual([
      { type: "finish", reason: { kind: "aborted", failure: { message: expect.any(String), code: "ABORTED" } } },
    ]);
  });

  it("resolveModel 申报 default 单档 effort；listModels 通报白名单（advisory）", async () => {
    const { fetchFn } = scriptedFetch([chatResponse({ content: "ok" })]);
    const adapter = makeAdapter(fetchFn);

    const info = await adapter.resolveModel("deepseek", "deepseek-v4-flash");
    expect(info.reasoning?.efforts.map((effort) => effort.id)).toEqual([ReasoningEffortId("default")]);
    expect(info.reasoning?.defaultEffort).toBe(ReasoningEffortId("default"));

    const models = await adapter.listModels("deepseek");
    expect(models.map((model) => model.id)).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);

    expect(adapter.providerInfo("deepseek")).toEqual({ id: "deepseek", name: "DeepSeek" });
  });
});

// ---------- 与 FakeLlmAdapter 同 seam 互换 ----------

const INPUT: MrInput = {
  caseId: "VUL4J-38",
  issueDescription: "Vulnerability fix: URL encoding",
  diff: "--- a/src/main/java/Example.java\n+++ b/src/main/java/Example.java\n@@ -1,1 +1,1 @@\n-old\n+new",
};

const CANDIDATE_F001 = {
  id: "F001",
  severity: "P2",
  category: "CORRECTNESS",
  file: "src/main/java/Example.java",
  line: 42,
  title: "Incorrect URL encoding of query parameters",
  description: "The change encodes the joined query string instead of individual parameter values.",
  evidence: ["Example.java:42 - URLEncoder.encode applied to the joined query string"],
  rule: "CORRECTNESS-001",
  confidence: 0.9,
};

/** 冻结 harness 的 MR intro 字节（独立真源：不重算，直接对齐薄 harness 输出） */
function frozenMrIntroText(input: MrInput): string {
  const message = buildInitialUserMessage({
    caseId: input.caseId,
    repoPath: "",
    diff: input.diff,
    issueDescription: input.issueDescription,
    truth: null,
    labels: { source: "test", riskClass: "Low", allowedConfigs: [] },
  });
  return message.content;
}

/** config A 六阶段的真实响应序列（与 walking-skeleton 脚本同内容，Response 形态） */
function configAResponses(): Response[] {
  return [
    chatResponse({ content: '{"summary":"The change replaces manual URL encoding with a utility call."}', usage: { prompt_cache_miss_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 50 } }),
    chatResponse({ content: '{"riskClass":"Medium","reason":"business logic change"}', usage: { prompt_cache_miss_tokens: 101, completion_tokens: 11 } }),
    chatResponse({ content: '{"neededContext":[],"reason":"diff is self-contained"}', usage: { prompt_cache_miss_tokens: 102, completion_tokens: 12 } }),
    chatResponse({ content: '{"notes":"No further context can be retrieved in this configuration."}', usage: { prompt_cache_miss_tokens: 103, completion_tokens: 13 } }),
    chatResponse({ content: JSON.stringify({ candidates: [CANDIDATE_F001] }), usage: { prompt_cache_miss_tokens: 104, completion_tokens: 14 } }),
    chatResponse({ content: '{"verdicts":[{"id":"F001","pass":true,"reason":"evidence supports the finding"}],"complete":true}', usage: { prompt_cache_miss_tokens: 105, completion_tokens: 15 } }),
  ];
}

describe("DeepSeekLlmAdapter：与 FakeLlmAdapter 同 seam 互换（完整 config A 会话）", () => {
  it("六阶段检视经真实适配器代码路径跑通，wire 字节进审计", async () => {
    const { fetchFn, calls } = scriptedFetch(configAResponses());
    const adapter = makeAdapter(fetchFn);

    const { ctx } = await mountAdapter(adapter);
    expect(ctx.llm.listProviders().map((info) => info.id)).toContain("deepseek");

    const result = await ctx.reviewRuntime.run(INPUT);

    // 六次模型调用，全部经真实 HTTP 代码路径
    expect(calls).toHaveLength(6);
    expect(result.phaseLog.map((entry) => entry.requestCount)).toEqual([1, 1, 1, 1, 1, 1]);

    // Finding 过闸产出
    expect(result.findings).toEqual([CANDIDATE_F001]);

    // usage 记账（miss 不相交合计 615 + hit 50）
    expect(result.audit.usage).toEqual({ inputTokens: 615, outputTokens: 75, cacheReadTokens: 50 });

    // wire 字节进审计：每条请求携带序列化点原文，可重放
    expect(result.audit.requests).toHaveLength(6);
    const firstWire = result.audit.requests[0]?.wireBody;
    expect(firstWire).toBeDefined();
    const parsed = JSON.parse(firstWire!) as {
      model: string;
      messages: { role: string; content: string }[];
    };
    expect(parsed.model).toBe("deepseek-v4-flash");
    expect(parsed.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    expect(parsed.messages[1]).toEqual({ role: "user", content: frozenMrIntroText(INPUT) });
    expect(result.audit.requests.every((request) => request.wireBody !== undefined)).toBe(true);
  });
});
