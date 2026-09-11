/**
 * #24 验收：审计导出适配器完整化 + 读取端回归。
 *
 * 四条锁线（对位票面 AC）：
 * - 导出审计 ≡ POC1 AuditFileContent 契约：全字段在（经冻结 buildAuditFileContent
 *   组装，零漂移）、请求为 POC1 LlmRequest 形态（parametersJson 字节、工具调用/
 *   结果消息投影）、phaseLog 阶段名收窄为 POC1 ReviewPhase；
 * - 审计重放：导出字节 JSON round-trip 后逐请求重建等价请求并通过校验——
 *   wire 在场（真实适配器）从 wire 字节反解（review_* → review.*、thinking 锁档
 *   → effort 标签）且与结构化请求逐字段等价；wire 缺席（fake）结构化请求自校验；
 * - 读取端回归网：冻结 evaluateRun / judgeRun 直接消费 DSH 导出的 RunResult
 *   （读取端零改动——本文件 import 的就是生产读取函数本体）；
 * - fake 与真实 adapter 来源的审计同构：同一脚本内容双跑，剥离时变字段
 *   （runId/时间戳/duration）与 wireBody 后逐字段相等。
 */

import { describe, expect, it } from "vitest";

import type { MRCase } from "../../../../src/contracts/mr-case.js";
import type { AuditFileContent } from "../../../../src/audit/audit-writer.js";
import { evaluateRun } from "../../../../src/metrics/aggregate.js";
import { judgeRun } from "../../../../src/judge/orchestrate.js";
import { FakeJudgeClient } from "../../../../src/judge/fake-judge-client.js";
import { SAMPLE_MR_CASE } from "../../../../tests/fixtures/sample-mr-case.js";

import { DeepSeekLlmAdapter } from "../../src/llm/deepseek-adapter.js";
import type { FakeLlmScriptStep } from "../../src/llm/fake-adapter.js";
import type { MrInput } from "../../src/plugins/review-context.js";
import { REVIEW_PRESETS } from "../../src/presets/review-presets.js";
import type { ReviewRunResult } from "../../src/plugins/review-runtime.js";
import {
  replayAuditRequest,
  toAuditFileContent,
  toPoc1RunResult,
  type DshAuditFileContent,
} from "../../src/audit/audit-export.js";
import { mount, mountAdapter, runIsolated } from "../helpers/mount-profile.js";

// ---------- 公共夹具 ----------

const INPUT: MrInput = {
  caseId: "AUDIT-EXPORT-1",
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

/** 与真值对齐的 MR 用例（line-level TP=1 的最小真值） */
const MR_CASE: MRCase = {
  caseId: INPUT.caseId,
  repoPath: "/repos/sample",
  diff: INPUT.diff,
  issueDescription: INPUT.issueDescription,
  truth: {
    locations: [{ file: "src/main/java/Example.java", lineStart: 42, lineEnd: 42, defectNature: "CORRECTNESS" }],
    fixPatch: "--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-old\n+new",
  },
  labels: { source: "test", riskClass: "Medium", allowedConfigs: ["A", "B", "C", "D", "E"] },
};

/** config A 六阶段脚本：产出 F001 且过闸（usage 与真实适配器响应序列同数） */
function configAFindingScript(): readonly FakeLlmScriptStep[] {
  return [
    { kind: "reply", content: '{"summary":"The change replaces manual URL encoding with a utility call."}', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 } },
    { kind: "reply", content: '{"riskClass":"Medium","reason":"business logic change"}', usage: { inputTokens: 101, outputTokens: 11 } },
    { kind: "reply", content: '{"neededContext":[],"reason":"diff is self-contained"}', usage: { inputTokens: 102, outputTokens: 12 } },
    { kind: "reply", content: '{"notes":"No further context can be retrieved in this configuration."}', usage: { inputTokens: 103, outputTokens: 13 } },
    { kind: "reply", content: JSON.stringify({ candidates: [CANDIDATE_F001] }), usage: { inputTokens: 104, outputTokens: 14 } },
    { kind: "reply", content: '{"verdicts":[{"id":"F001","pass":true,"reason":"evidence supports the finding"}],"complete":true}', usage: { inputTokens: 105, outputTokens: 15 } },
  ];
}

/** 一次 fake config A 会话（独立装配，inline 拆卸） */
async function runConfigA(): Promise<ReviewRunResult> {
  const { result } = await runIsolated(configAFindingScript(), {}, INPUT);
  return result;
}

// ---------- 真实适配器测试基建：fake fetch（零网络） ----------

interface RecordedFetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

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

/** chat/completions 非流式成功响应（DeepSeek 线上形状；工具调用为 wire 名） */
function chatResponse(fields: {
  readonly content?: string | null;
  readonly toolCalls?: readonly { readonly id: string; readonly name: string; readonly arguments: string }[];
  readonly usage?: Record<string, unknown>;
}): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: fields.content ?? null,
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
          finish_reason: fields.toolCalls !== undefined ? "tool_calls" : "stop",
        },
      ],
      ...(fields.usage !== undefined ? { usage: fields.usage } : {}),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** 与 configAFindingScript 同内容同 usage 的真实适配器响应序列 */
function configAFindingResponses(): readonly Response[] {
  return [
    chatResponse({ content: '{"summary":"The change replaces manual URL encoding with a utility call."}', usage: { prompt_cache_miss_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 50 } }),
    chatResponse({ content: '{"riskClass":"Medium","reason":"business logic change"}', usage: { prompt_cache_miss_tokens: 101, completion_tokens: 11 } }),
    chatResponse({ content: '{"neededContext":[],"reason":"diff is self-contained"}', usage: { prompt_cache_miss_tokens: 102, completion_tokens: 12 } }),
    chatResponse({ content: '{"notes":"No further context can be retrieved in this configuration."}', usage: { prompt_cache_miss_tokens: 103, completion_tokens: 13 } }),
    chatResponse({ content: JSON.stringify({ candidates: [CANDIDATE_F001] }), usage: { prompt_cache_miss_tokens: 104, completion_tokens: 14 } }),
    chatResponse({ content: '{"verdicts":[{"id":"F001","pass":true,"reason":"evidence supports the finding"}],"complete":true}', usage: { prompt_cache_miss_tokens: 105, completion_tokens: 15 } }),
  ];
}

const ZERO_WAIT_SLEEP = async () => {};

/** 一次真实适配器 config A 会话（DeepSeek 代码路径 + fake fetch，零网络） */
async function runConfigARealAdapter(): Promise<ReviewRunResult> {
  const { fetchFn } = scriptedFetch(configAFindingResponses());
  const adapter = new DeepSeekLlmAdapter({
    apiKey: "sk-test-secret-123",
    fetchFn,
    sleepFn: ZERO_WAIT_SLEEP,
  });
  const { ctx } = await mountAdapter(adapter);
  return ctx.reviewRuntime.run(INPUT);
}

// ---------- AC1：导出审计 ≡ POC1 AuditFileContent 契约 ----------

describe("导出审计 ≡ POC1 AuditFileContent（#24 AC1）", () => {
  it("config A 全字段在（POC1 类型可装填），请求为 POC1 LlmRequest 形态", async () => {
    const result = await runConfigA();
    const content = toAuditFileContent(result);

    // 编译期即契约：DSH 导出可装填进 POC1 AuditFileContent（多余键 wireBody 为
    // DSH 扩展，POC1 读取端按结构化字段消费、忽略扩展）
    const asPoc1: AuditFileContent = content;

    expect(asPoc1.runId).toBe(result.audit.runId);
    expect(asPoc1.caseId).toBe(INPUT.caseId);
    expect(asPoc1.configId).toBe("A");
    expect(asPoc1.model).toBe("deepseek-v4-flash");
    expect(asPoc1.effort).toBe("default");
    expect(asPoc1.startedAt).toBe(result.audit.startedAt);
    expect(asPoc1.finishedAt).toBe(result.audit.finishedAt);
    expect(asPoc1.rounds).toBe(1);
    expect(asPoc1.toolCalls).toBe(0);
    expect(asPoc1.truncated).toBe(false);
    expect(asPoc1.truncationReasons).toEqual([]);
    expect(asPoc1.usage).toEqual({ inputTokens: 615, outputTokens: 75, cacheReadTokens: 50 });
    expect(asPoc1.findings).toEqual([CANDIDATE_F001]);
    expect(asPoc1.phaseLog).toHaveLength(6);
    expect(asPoc1.phaseLog.map((entry) => entry.round)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(asPoc1.rejections).toEqual([]);
    expect(asPoc1.cacheBreaks).toEqual([]);
    expect(asPoc1.toolCallLog).toEqual([]);
    expect(asPoc1.requests).toHaveLength(6);
    // POC1 请求形态：messages 为 LlmMessage（system 在 messages[0]），tools 空数组
    expect(asPoc1.requests[0]?.messages[0]).toMatchObject({ role: "system" });
    expect(asPoc1.requests[0]?.tools).toEqual([]);
  });

  it("Evidence Gate 判定留痕：被拒候选经导出在场（rejections 非空形态）", async () => {
    // 与 configAFindingScript 同六步，但 Phase 6 裁决 F001 不通过 → 候选被
    // Gate 拦截，留痕必须经导出在场（findings 空、rejections 携带拦截阶段）
    const script: readonly FakeLlmScriptStep[] = [
      { kind: "reply", content: '{"summary":"The change replaces manual URL encoding with a utility call."}' },
      { kind: "reply", content: '{"riskClass":"Medium","reason":"business logic change"}' },
      { kind: "reply", content: '{"neededContext":[],"reason":"diff is self-contained"}' },
      { kind: "reply", content: '{"notes":"No further context can be retrieved in this configuration."}' },
      { kind: "reply", content: JSON.stringify({ candidates: [CANDIDATE_F001] }) },
      { kind: "reply", content: '{"verdicts":[{"id":"F001","pass":false,"reason":"quoted evidence does not support the finding"}],"complete":true}' },
    ];
    const { ctx } = await mount(script);
    const result = await ctx.reviewRuntime.run(INPUT);
    const content = toAuditFileContent(result);

    expect(content.findings).toEqual([]);
    expect(content.rejections).toHaveLength(1);
    expect(content.rejections[0]).toMatchObject({
      candidateId: "F001",
      stage: "VERIFICATION_FAILED",
    });
  });

  it("config E（工具 + Ledger）：工具 schema 带 parametersJson 字节，工具调用/结果消息投影，ledger/prefetch 记账随形态", async () => {
    const MATH_UTILS = "src/main/java/com/example/math/MathUtils.java";
    const script: readonly FakeLlmScriptStep[] = [
      { kind: "reply", content: '{"summary":"Loop boundary change."}' },
      { kind: "reply", content: '{"riskClass":"High","reason":"array indexing"}' },
      { kind: "reply", content: '{"neededContext":["sumFirst signature"],"reason":"verify bounds"}' },
      {
        kind: "reply",
        content: "",
        toolCalls: [{ id: "call-1", name: "review.get_file", arguments: `{"path":"${MATH_UTILS}","startLine":1,"endLine":40}` }],
      },
      { kind: "reply", content: '{"notes":"source retrieved"}' },
      { kind: "reply", content: '{"candidates":[]}' },
      { kind: "reply", content: '{"verdicts":[],"complete":true}' },
    ];
    const { ctx } = await mount(script, { policy: REVIEW_PRESETS.E });
    const result = await ctx.reviewRuntime.run({ ...INPUT, repoPath: SAMPLE_MR_CASE.repoPath });
    const content = toAuditFileContent(result);

    expect(content.configId).toBe("E");
    expect(content.requests).toHaveLength(7);
    // 工具 schema：POC1 形态（parametersJson 为字符串字节，7 个）
    for (const request of content.requests) {
      expect(request.tools).toHaveLength(7);
      for (const tool of request.tools) {
        expect(typeof tool.parametersJson).toBe("string");
        expect(() => JSON.parse(tool.parametersJson)).not.toThrow();
      }
    }
    // Phase 4 第二次请求携带：assistant 工具调用消息 + tool 结果消息（POC1 投影）
    const fifth = content.requests[4]?.messages ?? [];
    const assistantWithCalls = fifth.find(
      (message) => message.role === "assistant" && message.toolCalls !== undefined && message.toolCalls.length > 0,
    );
    expect(assistantWithCalls?.toolCalls?.[0]).toMatchObject({
      id: "call-1",
      name: "review.get_file",
      argumentsJson: expect.stringContaining("MathUtils"),
    });
    const toolMessage = fifth.find((message) => message.role === "tool");
    expect(toolMessage?.toolCallId).toBe("call-1");
    // 每回合工具账目：toolCalls 计数与 toolCallLog 明细（内部名 + 结果摘要）
    expect(content.toolCalls).toBe(1);
    expect(content.toolCallLog).toHaveLength(1);
    expect(content.toolCallLog[0]).toMatchObject({ name: "review.get_file" });
    expect(content.toolCallLog[0]?.resultSummary.length).toBeGreaterThan(0);
    // 记账：Ledger 快照在场；E 无预取/全仓 → 字段缺席
    expect(content.ledger?.[0]?.id).toBe("ctx#001");
    expect(content.prefetch).toBeUndefined();
    expect(content.fullRepo).toBeUndefined();
    // phaseLog：阶段名收窄为 POC1 ReviewPhase（六名之一），Phase 4 双请求
    expect(content.phaseLog).toHaveLength(6);
    expect(content.phaseLog[3]).toMatchObject({ round: 1, phase: "Context Retrieval", requestCount: 2 });
  });
});

// ---------- AC2：审计重放（从审计字节重建等价请求并通过校验） ----------

describe("审计重放（#24 AC2）", () => {
  it("fake 来源（无 wire）：导出字节 JSON round-trip 后逐请求重放，等价原请求", async () => {
    const result = await runConfigA();
    const content = toAuditFileContent(result);
    // 文件字节：writeAuditFile 同款序列化 → 重读（模拟从盘上审计重建）
    const fromDisk = JSON.parse(JSON.stringify(content)) as DshAuditFileContent;

    expect(fromDisk.requests.every((request) => request.wireBody === undefined)).toBe(true);
    const replayed = fromDisk.requests.map((request) => replayAuditRequest(request));
    expect(replayed).toEqual(content.requests.map(({ wireBody: _wire, ...request }) => request));
  });

  it("真实 wire 来源：wire 字节反解（review_* → review.*、thinking 锁档 → effort）与结构化请求逐字段等价", async () => {
    const result = await runConfigARealAdapter();
    const content = toAuditFileContent(result);

    // 真实适配器来源：每条请求携带 wire 字节（序列化点原文）
    expect(content.requests.every((request) => request.wireBody !== undefined)).toBe(true);
    // 重放：wire 反解 + 与结构化对照，不等价即抛（校验闭环）
    const replayed = content.requests.map((request) => replayAuditRequest(request));
    expect(replayed).toEqual(content.requests.map(({ wireBody: _wire, ...request }) => request));
    // 抽查反解细节：首请求 system 在 messages[0]，工具名内部点号形态
    expect(replayed[0]?.messages[0]?.role).toBe("system");
  });

  it("真实 wire 来源（config E 工具面）：工具 schema 与工具调用/结果消息经反解等价", async () => {
    const MATH_UTILS = "src/main/java/com/example/math/MathUtils.java";
    // config E 七步响应：Phase 4 工具调用（wire 工具名 review_get_file）+ notes 收尾
    const responses: readonly Response[] = [
      chatResponse({ content: '{"summary":"Loop boundary change."}' }),
      chatResponse({ content: '{"riskClass":"High","reason":"array indexing"}' }),
      chatResponse({ content: '{"neededContext":["sumFirst signature"],"reason":"verify bounds"}' }),
      chatResponse({
        content: "",
        toolCalls: [{ id: "call-1", name: "review_get_file", arguments: `{"path":"${MATH_UTILS}","startLine":1,"endLine":40}` }],
      }),
      chatResponse({ content: '{"notes":"source retrieved"}' }),
      chatResponse({ content: '{"candidates":[]}' }),
      chatResponse({ content: '{"verdicts":[],"complete":true}' }),
    ];
    const { fetchFn } = scriptedFetch(responses);
    const adapter = new DeepSeekLlmAdapter({ apiKey: "sk-test-secret-123", fetchFn, sleepFn: ZERO_WAIT_SLEEP });
    const { ctx } = await mountAdapter(adapter, { policy: REVIEW_PRESETS.E });
    const result = await ctx.reviewRuntime.run({ ...INPUT, repoPath: SAMPLE_MR_CASE.repoPath });
    const content = toAuditFileContent(result);

    expect(content.requests).toHaveLength(7);
    // 重放全部请求（含工具面）：wire 反解（7 个 review_* schema + 工具调用消息）
    // 与结构化请求逐字段等价，不等价即抛
    const replayed = content.requests.map((request) => replayAuditRequest(request));
    expect(replayed).toEqual(content.requests.map(({ wireBody: _wire, ...request }) => request));
    // 工具面反解细节：schema 名点号形态；第 5 请求携带工具调用消息与结果消息
    const firstTools = replayed[0]?.tools ?? [];
    expect(firstTools).toHaveLength(7);
    expect(firstTools.map((tool) => tool.name)).toContain("review.get_file");
    const fifthMessages = replayed[4]?.messages ?? [];
    const assistantWithCalls = fifthMessages.find(
      (message) => message.role === "assistant" && message.toolCalls !== undefined && message.toolCalls.length > 0,
    );
    expect(assistantWithCalls?.toolCalls?.[0]).toMatchObject({
      id: "call-1",
      name: "review.get_file",
    });
    expect(fifthMessages.find((message) => message.role === "tool")?.toolCallId).toBe("call-1");
  });
});

// ---------- AC3：读取端回归网（metrics / judge 零改动直跑） ----------

describe("读取端回归网（#24 AC3：冻结读取函数直接消费 DSH 导出）", () => {
  it("metrics evaluateRun：DSH 导出 RunResult 过冻结评估管线（line TP=1）", async () => {
    const result = await runConfigA();
    const run = toPoc1RunResult(result);

    const metrics = evaluateRun(run, MR_CASE);

    expect(metrics.caseId).toBe(INPUT.caseId);
    expect(metrics.configId).toBe("A");
    expect(metrics.lineCounts).toEqual({ tp: 1, fp: 0, fn: 0 });
    expect(metrics.tokens).toMatchObject({ uncachedInputTokens: 615, cachedInputTokens: 50, outputTokens: 75 });
    expect(metrics.rounds).toBe(1);
    expect(metrics.toolCalls).toBe(0);
  });

  it("judge judgeRun：DSH 导出 RunResult 过冻结判定链（FakeJudgeClient 裁定 match）", async () => {
    const result = await runConfigA();
    const run = toPoc1RunResult(result);
    const judge = FakeJudgeClient.fromAdjudications([
      {
        matches: [{ findingIndex: 0, truthIndex: 0, matchConfidence: "high", matchReason: "same defect confirmed" }],
        summary: "judge agrees with the rule screening",
      },
    ]);

    const judged = await judgeRun(run, MR_CASE, judge);

    expect(judged.status).toBe("judged");
    expect(judged.judgeCounts).toEqual({ tp: 1, fp: 0, fn: 0 });
    expect(judged.disagreements).toEqual([]);
  });
});

// ---------- AC4：fake 与真实 adapter 来源的审计同构 ----------

describe("fake 与真实 adapter 审计同构（#24 AC4）", () => {
  it("同一脚本内容双跑：剥离时变字段与 wireBody 后逐字段相等", async () => {
    const fakeResult = await runConfigA();
    const realResult = await runConfigARealAdapter();

    const fakeContent = toAuditFileContent(fakeResult);
    const realContent = toAuditFileContent(realResult);

    // 时变字段（runId/时间戳/duration）与 wireBody（真实来源独有）之外全同构
    const strip = (content: DshAuditFileContent) => {
      const { runId: _runId, startedAt: _startedAt, finishedAt: _finishedAt, durationMs: _durationMs, requests, ...rest } = content;
      return { ...rest, requests: requests.map(({ wireBody: _wire, ...request }) => request) };
    };

    expect(strip(fakeContent)).toEqual(strip(realContent));
  });
});
