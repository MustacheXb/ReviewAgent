/**
 * #22 集成层验收：缓存纪律——Zone B 注入 + 记账 + Cache Break 归因。
 *
 * 五条锁线：
 * - config B 布局：请求 1 = [system(Zone A), Zone B, MR intro, Symbol,
 *   Reference, Call chain, Phase 1]，Zone B 与三层消息字节 = 冻结
 *   buildPrefetchContext 同参直跑 oracle（#18 落锤注入序的生产化）；
 * - 注入记账：audit.prefetch = 4 条 PrefetchLayerRecord；configId 如实标
 *   "B"；config B 零工具（tools 恒 []）；
 * - 无变更重跑零 Cache Break：append-only 会话内 cacheBreaks = []，两次
 *   独立运行全部请求 JSON 序列化逐字节相等（Zone A/B 稳定前缀）；
 * - usage 记账：事件流 usage（含 cached/uncached）聚进 audit.usage，可选
 *   字段「定义即在」（含 0）——POC1 addUsage 语义；
 * - 工具成本数据源：audit.toolCallLog + audit.usage 装进 POC1 RunResult 形态
 *   即可喂冻结 computeToolCostTokens（核外 RIE/CARC 聚合的前置）。
 */

import { describe, expect, it } from "vitest";

import type { RunResult } from "../../../../src/contracts/run.js";
import { DEFAULT_PREFETCH_BUDGETS } from "../../../../src/contracts/prefetch.js";
import { SYSTEM_PROMPT } from "../../../../src/loop/messages.js";
import { computeToolCostTokens } from "../../../../src/metrics/tokens.js";
import { buildPrefetchContext } from "../../../../src/zoneb/prefetch.js";
import { SAMPLE_MR_CASE } from "../../../../tests/fixtures/sample-mr-case.js";

import type { FakeLlmScriptStep } from "../../src/llm/fake-adapter.js";
import type { MrInput } from "../../src/plugins/review-context.js";
import { REVIEW_PRESETS } from "../../src/presets/review-presets.js";
import { buildMrIntroText } from "../../src/plugins/review-context.js";
import { PHASE_INSTRUCTIONS } from "../../src/plugins/review-policy.js";
import type { ReviewAudit } from "../../src/plugins/review-runtime.js";
import { mount, runIsolated } from "../helpers/mount-profile.js";

const INPUT: MrInput = {
  caseId: "CACHE-DISCIPLINE-1",
  issueDescription: SAMPLE_MR_CASE.issueDescription,
  diff: SAMPLE_MR_CASE.diff,
  repoPath: SAMPLE_MR_CASE.repoPath,
};

/** 六阶段纯文本回复脚本（config B 零工具，一阶段一请求） */
const PHASE_REPLIES: readonly string[] = [
  '{"summary":"Loop boundary change in MathUtils.sumFirst."}',
  '{"riskClass":"High","reason":"array indexing logic"}',
  '{"neededContext":["sumFirst signature"],"reason":"verify loop bounds"}',
  '{"notes":"Deterministic prefetch supplied the needed context."}',
  '{"candidates":[]}',
  '{"verdicts":[],"complete":true}',
];

function configBScript(): readonly FakeLlmScriptStep[] {
  return PHASE_REPLIES.map((content) => ({ kind: "reply" as const, content }));
}

describe("config B 注入布局与记账（prefetch 政策开关）", () => {
  it("请求 1 = [Zone A, Zone B, MR intro, Symbol, Reference, Call chain, Phase 1]，Zone B/三层 = 冻结管线字节", async () => {
    const oracle = await buildPrefetchContext({
      repoPath: SAMPLE_MR_CASE.repoPath,
      diff: SAMPLE_MR_CASE.diff,
      budgets: DEFAULT_PREFETCH_BUDGETS,
    });
    const { ctx } = await mount(configBScript(), { policy: { prefetch: true } });

    const result = await ctx.reviewRuntime.run(INPUT);
    const audit = result.audit;

    // —— 请求 1 布局（#18 落锤注入序的生产化：多连 inject 按调用序，Zone B 在
    // system 之后、MR intro 之前，三层随后，首条 followup 收尾）
    const messages = audit.requests[0]?.messages;
    if (messages === undefined) throw new Error("request 1 was not captured");
    expect(messages).toHaveLength(7);
    expect(messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    expect(messages[1]).toEqual({ role: "user", content: oracle.zoneBMessage.content });
    expect(messages[2]).toEqual({ role: "user", content: buildMrIntroText(INPUT) });
    expect(messages[3]).toEqual({ role: "user", content: oracle.layerMessages[0]?.content });
    expect(messages[4]).toEqual({ role: "user", content: oracle.layerMessages[1]?.content });
    expect(messages[5]).toEqual({ role: "user", content: oracle.layerMessages[2]?.content });
    expect(messages[6]).toEqual({ role: "user", content: PHASE_INSTRUCTIONS["Change Understanding"] });

    // —— 注入记账：4 条 PrefetchLayerRecord（POC1 RunAudit.prefetch 契约）；
    // configId 如实标 B；config B 零工具
    expect(audit.prefetch).toEqual(oracle.records);
    expect(audit.configId).toBe("B");
    for (const request of audit.requests) {
      expect(request.tools).toEqual([]);
    }

    // —— append-only 会话：请求 2 = 请求 1 全前缀 + assistant 回复 + Phase 2 指令
    expect(audit.requests[1]?.messages.slice(0, 7)).toEqual(messages);
    expect(audit.requests[1]?.messages[7]).toEqual({ role: "assistant", content: PHASE_REPLIES[0] });
    expect(audit.requests[1]?.messages[8]).toEqual({
      role: "user",
      content: PHASE_INSTRUCTIONS["Risk Classification"],
    });
  });

  it("无变更重跑零 Cache Break：两次独立运行 cacheBreaks 均 []，全部请求逐字节相等", async () => {
    const first = await runConfigB();
    const second = await runConfigB();

    expect(first.requests).toHaveLength(6);
    expect(first.cacheBreaks).toEqual([]);
    expect(second.cacheBreaks).toEqual([]);

    // 两次运行之间：全部请求的规范序列化逐字节相等（Zone A/B 稳定 + 前缀纪律）
    expect(second.requests.map((request) => JSON.stringify(request))).toEqual(
      first.requests.map((request) => JSON.stringify(request)),
    );
  });
});

describe("usage 记账（事件流 → audit.usage，POC1 addUsage 语义）", () => {
  it("可选字段「定义即在」：事件定义 0 则审计记 0；cacheWriteTokens 并入聚合", async () => {
    const script: readonly FakeLlmScriptStep[] = PHASE_REPLIES.map((content, index) => ({
      kind: "reply" as const,
      content,
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        // 第二个事件显式定义 0：字段必须在场（定义即在），不被 >0 门吞掉
        ...(index === 1 ? { cacheReadTokens: 0 } : {}),
        ...(index === 2 ? { cacheWriteTokens: 7 } : {}),
      },
    }));
    const { ctx } = await mount(script);

    const result = await ctx.reviewRuntime.run(INPUT);

    expect(result.audit.usage).toEqual({
      inputTokens: 600,
      outputTokens: 60,
      cacheReadTokens: 0,
      cacheWriteTokens: 7,
    });
  });
});

describe("工具成本数据源（audit.toolCallLog → 冻结 computeToolCostTokens）", () => {
  it("DSH 审计字段装进 POC1 RunResult 形态即可计价（核外 RIE/CARC 前置）", async () => {
    const getFileArgs = `{"path":"src/main/java/com/example/math/MathUtils.java","startLine":1,"endLine":20}`;
    const script: readonly FakeLlmScriptStep[] = [
      { kind: "reply", content: PHASE_REPLIES[0] ?? "" },
      { kind: "reply", content: PHASE_REPLIES[1] ?? "" },
      { kind: "reply", content: PHASE_REPLIES[2] ?? "" },
      {
        kind: "reply",
        content: "",
        toolCalls: [{ id: "call-1", name: "review.get_file", arguments: getFileArgs }],
      },
      { kind: "reply", content: '{"notes":"source retrieved"}' },
      { kind: "reply", content: PHASE_REPLIES[4] ?? "" },
      { kind: "reply", content: PHASE_REPLIES[5] ?? "" },
    ];
    // #25 起 preset C = 工具 + 全仓（run 启动加载仓库并注入全仓消息；工具成本
    // 计价只消费 toolCallLog / toolCalls，注入不改变计价口径）
    const { ctx } = await mount(script, { policy: REVIEW_PRESETS.C });

    const result = await ctx.reviewRuntime.run(INPUT);
    const audit = result.audit;

    expect(audit.configId).toBe("C");
    expect(audit.toolCalls).toBe(1);
    expect(audit.toolCallLog).toHaveLength(1);

    // POC1 RunResult 形态装填：DSH 审计的 usage / toolCallLog 即插（类型即契约：
    // 装得进 = 口径 1:1）；其余字段与计价无关，空形态即可
    const priced: RunResult = {
      caseId: audit.caseId,
      configId: "C",
      findings: [],
      usage: audit.usage,
      rounds: audit.rounds,
      toolCalls: audit.toolCalls,
      audit: {
        requests: [],
        toolCallLog: audit.toolCallLog,
        phaseLog: [],
        rejections: [],
        cacheBreaks: [],
        truncated: false,
        truncationReasons: [],
      },
    };

    const resultChars = audit.toolCallLog.reduce((sum, call) => sum + call.resultSummary.length, 0);
    expect(resultChars).toBeGreaterThan(0);
    // 计价分解：按调用次数（10/次）与按结果字符（1/char）各自独立可算
    expect(computeToolCostTokens(priced, { fixedCostPerCall: 10, costPerResultChar: 0 })).toBe(10);
    expect(computeToolCostTokens(priced, { fixedCostPerCall: 0, costPerResultChar: 1 })).toBe(resultChars);
  });
});

/** 一次完整独立装配 + config B 会话（inline 拆卸，两次运行零共享状态） */
async function runConfigB(): Promise<ReviewAudit> {
  const { result } = await runIsolated(configBScript(), { policy: { prefetch: true } }, INPUT);
  return result.audit;
}
