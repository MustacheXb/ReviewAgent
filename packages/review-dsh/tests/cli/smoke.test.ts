/**
 * #46 验收（进程内）：网关冒烟自检 runGatewaySmoke + 人话诊断渲染。
 *
 * 冒烟命令对目标 reviewer 端点发两个最小探针（1 次补全 + 1 次工具调用），
 * 产出人话诊断。本文件锁：
 *
 * - 通过路径：双探针 200 → pass verdict（model / 端点 / 回复文本 / 工具名 /
 *   usage），且请求体走生产画像序列化（deepseek-v4-flash 档 thinking 在场、
 *   工具探针带 tools + tool_choice）——冒烟即生产路径的缩影，不是旁路简化；
 * - DeepSeek 缺省配置同样可用：不设 REVIEWER_URL/DEEPSEEK_URL → 端点解析
 *   为官方缺省 https://api.deepseek.com/chat/completions（fetchFn 捕获零网络）；
 * - 自定义网关：REVIEWER_URL 指向自定义端点 → 探针打该端点；
 * - 诊断分支矩阵（票面 AC2）：鉴权失败 / 模型不存在（404 与 400 文案两路）/
 *   不支持 function calling / 画像不匹配 / 限流 / 服务端错误 / 网络不通 /
 *   响应形状异常 / 模型未调用工具 / 凭据缺失 / 退役 id——每支一个用例；
 * - 渲染：人话报告含中文诊断、探针名、原因与处置建议（fail 路径）与
 *   端点/模型/双探针摘要（pass 路径）。
 *
 * fetchFn 注入而非 stub HTTP server：诊断分支需要 401/404/400/429/5xx 状态
 * 码剧本，而共享 stub-llm-server 只会 200（检视剧本用）；Response 对象
 * 手工构造即零网络全分支覆盖。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderSmokeReport, runGatewaySmoke, type SmokeVerdict } from "../../src/cli/smoke.js";
import { SMOKE_PING_TOOL_CALL_BODY } from "../../../../tests/helpers/dsh-replies.js";

// ---------- 剧本构造 ----------

interface RecordedCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/** 顺序剧本 fetch：记录每次调用的 url 与请求体，按序返回预制 Response */
function fetchScript(replies: readonly Response[]): { readonly fetchFn: typeof fetch; readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let index = 0;
  const fetchFn = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const reply = replies[index];
    index += 1;
    if (reply === undefined) {
      throw new TypeError("fetch script exhausted (unexpected extra probe)");
    }
    return reply;
  }) as typeof fetch;
  return { fetchFn, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** 补全探针的 200 回复（usage 走官方 miss/hit 链——无缓存计量字段时 inputTokens 回落 0） */
const okCompletion = (content: string): Response =>
  jsonResponse(200, {
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_cache_miss_tokens: 9, completion_tokens: 1 },
  });

/** 工具探针的 200 回复（共用夹具：模型调用了 review_smoke_ping） */
const okToolCall = (): Response => jsonResponse(200, SMOKE_PING_TOOL_CALL_BODY);

/** 网关错误体（OpenAI 兼容 error.message 形状） */
const httpError = (status: number, message: string): Response =>
  jsonResponse(status, { error: { message } });

// ---------- verdict 收窄助手 ----------

type PassVerdict = Extract<SmokeVerdict, { readonly kind: "pass" }>;
type FailVerdict = Extract<SmokeVerdict, { readonly kind: "fail" }>;

function expectPass(verdict: SmokeVerdict): PassVerdict {
  if (verdict.kind !== "pass") {
    throw new Error(`expected pass verdict, got: ${JSON.stringify(verdict)}`);
  }
  return verdict;
}

function expectFail(verdict: SmokeVerdict): FailVerdict {
  if (verdict.kind !== "fail") {
    throw new Error(`expected fail verdict, got: ${JSON.stringify(verdict)}`);
  }
  return verdict;
}

// ---------- 冒烟本体 ----------

describe("runGatewaySmoke（#46：网关冒烟自检）", () => {
  beforeEach(() => {
    vi.stubEnv("REVIEWER_API_KEY", "sk-smoke-sentinel");
    // 其余接入变量显式置空（trim 后为空 = 未设置），保证端点走缺省解析
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    vi.stubEnv("REVIEWER_URL", "");
    vi.stubEnv("DEEPSEEK_URL", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("通过（DeepSeek 缺省配置同样可用）：双探针 200 → pass + 生产画像请求体", async () => {
    const script = fetchScript([okCompletion("pong"), okToolCall()]);

    const verdict = await runGatewaySmoke({ model: "deepseek-v4-flash", fetchFn: script.fetchFn });

    const pass = expectPass(verdict);
    expect(pass.model).toBe("deepseek-v4-flash");
    // 缺省端点 = 官方 DeepSeek（AC3：不设自定义 URL 同样可用）
    expect(pass.endpointUrl).toBe("https://api.deepseek.com/chat/completions");
    expect(pass.completion.text).toBe("pong");
    expect(pass.completion.usage).toEqual({ inputTokens: 9, outputTokens: 1 });
    expect(pass.tool.names).toEqual(["review_smoke_ping"]);
    expect(pass.tool.usage).toEqual({ inputTokens: 12, outputTokens: 3 });

    // 双探针、按序：先补全后工具
    expect(script.calls).toHaveLength(2);
    expect(script.calls[0]?.url).toBe("https://api.deepseek.com/chat/completions");
    // 补全探针请求体：生产画像序列化（deepseek 档 thinking 在场）+ 无工具字段
    const completionBody = script.calls[0]?.body;
    expect(completionBody?.model).toBe("deepseek-v4-flash");
    expect(completionBody?.thinking).toEqual({ type: "enabled" });
    expect("tools" in (completionBody ?? {})).toBe(false);
    // 工具探针请求体：tools + tool_choice "auto"（冒烟即生产路径缩影）
    const toolBody = script.calls[1]?.body;
    expect(toolBody?.tool_choice).toBe("auto");
    expect(Array.isArray(toolBody?.tools)).toBe(true);
  });

  it("自定义网关：REVIEWER_URL → 探针打该端点（verdict 带端点便于诊断）", async () => {
    vi.stubEnv("REVIEWER_URL", "http://127.0.0.1:9999");
    const script = fetchScript([okCompletion("pong"), okToolCall()]);

    const verdict = await runGatewaySmoke({ model: "glm-4.7", fetchFn: script.fetchFn });

    const pass = expectPass(verdict);
    expect(pass.endpointUrl).toBe("http://127.0.0.1:9999/chat/completions");
    expect(script.calls[0]?.url).toBe("http://127.0.0.1:9999/chat/completions");
    // glm 画像：无 thinking、32768 信封（自由 id 的画像分派在冒烟路径同样生效）
    expect("thinking" in (script.calls[0]?.body ?? {})).toBe(false);
    expect(script.calls[0]?.body.max_tokens).toBe(32_768);
  });

  it("鉴权失败：补全探针 401 → diagnosis auth-failed + 人话处置", async () => {
    const script = fetchScript([httpError(401, "Invalid API key")]);

    const verdict = await runGatewaySmoke({ model: "deepseek-v4-flash", fetchFn: script.fetchFn });

    const fail = expectFail(verdict);
    expect(fail.diagnosis).toBe("auth-failed");
    expect(fail.probe).toBe("completion");
    expect(fail.reason).toContain("Invalid API key");
    const report = renderSmokeReport(verdict);
    expect(report).toContain("鉴权失败");
    expect(report).toContain("REVIEWER_API_KEY");
    expect(report).toContain("处置");
  });

  it("模型不存在（404）：diagnosis model-not-found", async () => {
    const verdict = await runGatewaySmoke({
      model: "qwen9-nonexistent",
      fetchFn: fetchScript([httpError(404, "Model Not Found")]).fetchFn,
    });

    expect(expectFail(verdict).diagnosis).toBe("model-not-found");
  });

  it("模型不存在（400 文案）：diagnosis model-not-found", async () => {
    const verdict = await runGatewaySmoke({
      model: "qwen9-nonexistent",
      fetchFn: fetchScript([httpError(400, "Model qwen9-nonexistent not found, please check the model id")]).fetchFn,
    });

    expect(expectFail(verdict).diagnosis).toBe("model-not-found");
  });

  it("不支持 function calling：补全探针过、工具探针 400（tools 不支持）→ diagnosis function-calling-unsupported", async () => {
    const script = fetchScript([okCompletion("pong"), httpError(400, "tools is not supported for this model")]);

    const verdict = await runGatewaySmoke({ model: "deepseek-v4-flash", fetchFn: script.fetchFn });

    const fail = expectFail(verdict);
    expect(fail.diagnosis).toBe("function-calling-unsupported");
    expect(fail.probe).toBe("tool");
    expect(renderSmokeReport(verdict)).toContain("function calling");
  });

  it("画像不匹配：400 拒绝 thinking 字段 → diagnosis profile-mismatch", async () => {
    const verdict = await runGatewaySmoke({
      model: "deepseek-v4-flash",
      fetchFn: fetchScript([httpError(400, "Unknown parameter: thinking")]).fetchFn,
    });

    const fail = expectFail(verdict);
    expect(fail.diagnosis).toBe("profile-mismatch");
    expect(fail.probe).toBe("completion");
    expect(renderSmokeReport(verdict)).toContain("画像");
  });

  it("限流：429 → diagnosis rate-limited", async () => {
    const verdict = await runGatewaySmoke({
      model: "deepseek-v4-flash",
      fetchFn: fetchScript([httpError(429, "Too Many Requests")]).fetchFn,
    });

    expect(expectFail(verdict).diagnosis).toBe("rate-limited");
  });

  it("服务端错误：500 → diagnosis server-error", async () => {
    const verdict = await runGatewaySmoke({
      model: "deepseek-v4-flash",
      fetchFn: fetchScript([httpError(500, "upstream panicked")]).fetchFn,
    });

    expect(expectFail(verdict).diagnosis).toBe("server-error");
  });

  it("网络不通：fetch 抛错 → diagnosis network-error（不发探针结论，含人话处置）", async () => {
    const fetchFn = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    const verdict = await runGatewaySmoke({ model: "deepseek-v4-flash", fetchFn });

    const fail = expectFail(verdict);
    expect(fail.diagnosis).toBe("network-error");
    expect(renderSmokeReport(verdict)).toContain("REVIEWER_URL");
  });

  it("响应形状异常：200 但无 choices → diagnosis malformed-response", async () => {
    const verdict = await runGatewaySmoke({
      model: "deepseek-v4-flash",
      fetchFn: fetchScript([jsonResponse(200, { ok: true })]).fetchFn,
    });

    expect(expectFail(verdict).diagnosis).toBe("malformed-response");
  });

  it("模型未调用工具：双探针 200 但第二探针只回文本 → diagnosis no-tool-call", async () => {
    const script = fetchScript([okCompletion("pong"), okCompletion("I cannot call tools")]);

    const verdict = await runGatewaySmoke({ model: "deepseek-v4-flash", fetchFn: script.fetchFn });

    const fail = expectFail(verdict);
    expect(fail.diagnosis).toBe("no-tool-call");
    expect(fail.probe).toBe("tool");
    expect(renderSmokeReport(verdict)).toContain("未调用工具");
  });

  it("凭据缺失：无任何 key 环境变量 → diagnosis missing-credentials，且不发探针", async () => {
    vi.stubEnv("REVIEWER_API_KEY", "");
    const script = fetchScript([okCompletion("pong"), okToolCall()]);

    const verdict = await runGatewaySmoke({ model: "deepseek-v4-flash", fetchFn: script.fetchFn });

    const fail = expectFail(verdict);
    expect(fail.diagnosis).toBe("missing-credentials");
    expect(fail.probe).toBe("completion");
    expect(script.calls).toHaveLength(0);
    const report = renderSmokeReport(verdict);
    expect(report).toContain("凭据缺失");
    expect(report).toContain("REVIEWER_API_KEY");
    expect(report).toContain(".env.local");
  });

  it("退役模型：deepseek-chat 本地即拒 → diagnosis invalid-model（reason 含退役说明）", async () => {
    const verdict = await runGatewaySmoke({
      model: "deepseek-chat",
      fetchFn: fetchScript([okCompletion("pong"), okToolCall()]).fetchFn,
    });

    const fail = expectFail(verdict);
    expect(fail.diagnosis).toBe("invalid-model");
    expect(fail.reason).toMatch(/retired/u);
  });

  it("渲染（pass）：人话报告含结论、端点、模型与双探针摘要", async () => {
    const verdict = await runGatewaySmoke({
      model: "deepseek-v4-flash",
      fetchFn: fetchScript([okCompletion("pong"), okToolCall()]).fetchFn,
    });

    const report = renderSmokeReport(verdict);
    expect(report).toContain("通过");
    expect(report).toContain("deepseek-v4-flash");
    expect(report).toContain("https://api.deepseek.com/chat/completions");
    expect(report).toContain("pong");
    expect(report).toContain("review_smoke_ping");
    expect(report).toContain("补全");
    expect(report).toContain("工具");
  });
});
