import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmRequest } from "../../src/contracts/llm-client.js";
import { FakeLlmClient } from "../../src/fake/fake-llm-client.js";
import {
  CACHE_BREAK_REASONS,
  classifyCacheBreaks,
  tallyCacheBreakReasons,
} from "../../src/loop/cache-break.js";
import { CONFIGS } from "../../src/contracts/config.js";
import { runReview } from "../../src/run/run-review.js";
import { buildCacheBreakReport } from "../../src/experiment/report.js";
import { renderDashboardMarkdown } from "../../src/experiment/dashboard.js";
import { toRunSnapshot, type RunRecord } from "../../src/experiment/run-store.js";
import { SAMPLE_MR_CASE } from "../fixtures/sample-mr-case.js";
import { HAPPY_PATH_RESPONSES } from "../helpers/happy-path-script.js";

/**
 * Cache Break 原因分类（spec #1 user story 13）：
 * 相邻请求字节前缀分歧 → Zone 分区 → 原因分类；纯观测（不改变请求字节），
 * 随审计留痕，报告 / dashboard 可见统计。
 */

let auditDir: string;

beforeAll(async () => {
  auditDir = await mkdtemp(path.join(tmpdir(), "review-agent-cache-break-"));
});

afterAll(async () => {
  await rm(auditDir, { recursive: true, force: true });
});

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: "deepseek-v4-flash",
    effort: "default",
    messages: [
      { role: "system", content: "zone-a system prompt" },
      { role: "user", content: "zone-c initial user message" },
    ],
    tools: [],
    ...overrides,
  };
}

describe("classifyCacheBreaks — 前缀语义（非 break）", () => {
  it("append-only 增长（Zone C 追加）不产生 break", () => {
    const first = request({
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "u1" },
      ],
    });
    const second = request({
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
      ],
    });
    expect(classifyCacheBreaks([first, second])).toEqual([]);
  });

  it("字节完全一致的相邻请求不产生 break", () => {
    expect(classifyCacheBreaks([request(), request()])).toEqual([]);
  });

  it("下一请求是前一请求的前缀（收缩）不产生 break——前缀缓存仍全额命中", () => {
    const first = request({
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
      ],
    });
    const second = request({
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "u1" },
      ],
    });
    expect(classifyCacheBreaks([first, second])).toEqual([]);
  });

  it("少于两个请求或畸形请求直接返回空（防御性）", () => {
    expect(classifyCacheBreaks([])).toEqual([]);
    expect(classifyCacheBreaks([request()])).toEqual([]);
    expect(classifyCacheBreaks([request(), undefined as unknown as LlmRequest])).toEqual([]);
  });
});

describe("classifyCacheBreaks — 原因分类（Zone 分区映射）", () => {
  it("model 分歧 → MODEL_CHANGED（zone MODEL）", () => {
    const records = classifyCacheBreaks([request(), request({ model: "deepseek-v4-pro" })]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ requestIndex: 1, reason: "MODEL_CHANGED", zone: "MODEL" });
    expect(records[0]?.divergeByteOffset).toBeGreaterThanOrEqual(0);
  });

  it("system 消息（Zone A 头部）分歧 → SYSTEM_PROMPT_CHANGED（zone A）", () => {
    const records = classifyCacheBreaks([
      request(),
      request({ messages: [{ role: "system", content: "changed system prompt" }, { role: "user", content: "zone-c initial user message" }] }),
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ requestIndex: 1, reason: "SYSTEM_PROMPT_CHANGED", zone: "A" });
  });

  it("消息序列中段分歧 → CONTEXT_REORDERED（zone B/C）", () => {
    const records = classifyCacheBreaks([
      request({
        messages: [
          { role: "system", content: "s" },
          { role: "user", content: "u1" },
          { role: "user", content: "phase instruction" },
        ],
      }),
      request({
        messages: [
          { role: "system", content: "s" },
          { role: "user", content: "u1 REORDERED INSERT" },
          { role: "user", content: "phase instruction" },
        ],
      }),
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ requestIndex: 1, reason: "CONTEXT_REORDERED", zone: "B/C" });
  });

  it("消息序列一致而 tools schema 分歧 → TOOL_SCHEMA_CHANGED（zone A）", () => {
    const tool = {
      name: "review.get_symbol",
      description: "Get a symbol",
      parametersJson: '{"type":"object"}',
    };
    const records = classifyCacheBreaks([request(), request({ tools: [tool] })]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ requestIndex: 1, reason: "TOOL_SCHEMA_CHANGED", zone: "A" });
  });

  it("消息分歧优先于 tools 分歧（规范布局中 messages 段在前）", () => {
    const tool = {
      name: "review.get_symbol",
      description: "Get a symbol",
      parametersJson: '{"type":"object"}',
    };
    const records = classifyCacheBreaks([
      request(),
      request({
        messages: [
          { role: "system", content: "zone-a system prompt" },
          { role: "user", content: "changed" },
        ],
        tools: [tool],
      }),
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]?.reason).toBe("CONTEXT_REORDERED");
  });

  it("分歧字节位置精确：落在变更消息内的首个差异字符处", () => {
    const prev = request({
      model: "deepseek-v4-flash",
      messages: [{ role: "system", content: "s" }, { role: "user", content: "u1" }],
    });
    const next = request({
      model: "deepseek-v4-flash",
      messages: [{ role: "system", content: "s" }, { role: "user", content: "uX" }],
    });
    const records = classifyCacheBreaks([prev, next]);
    expect(records).toHaveLength(1);
    // 布局 = JSON(model) + [ JSON(m0) , JSON(m1) ] ；m1 = {"role":"user","content":"u1"}
    const modelBytes = JSON.stringify(prev.model);
    const m0 = JSON.stringify(prev.messages[0]);
    const m1Prev = JSON.stringify(prev.messages[1]);
    const m1Next = JSON.stringify(next.messages[1]);
    const innerDiff = [...m1Prev].findIndex((ch, i) => ch !== m1Next[i]);
    const expected =
      modelBytes.length + 1 + m0.length + 1 + innerDiff;
    expect(m1Prev).not.toBe(m1Next);
    expect(records[0]?.divergeByteOffset).toBe(expected);
    expect(m1Prev.length).toBeGreaterThan(0);
  });

  it("多对分歧：requestIndex 逐对递增，原因独立判定", () => {
    const a = request({ model: "m1" });
    const b = request({ model: "m2" });
    const c = request({ model: "m2", messages: [{ role: "system", content: "changed" }, { role: "user", content: "u" }] });
    const records = classifyCacheBreaks([a, b, c]);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ requestIndex: 1, reason: "MODEL_CHANGED" });
    expect(records[1]).toMatchObject({ requestIndex: 2, reason: "SYSTEM_PROMPT_CHANGED" });
  });
});

describe("tallyCacheBreakReasons — 统计口径", () => {
  it("零值字段保留、列序恒定", () => {
    const tally = tallyCacheBreakReasons([]);
    expect(CACHE_BREAK_REASONS).toEqual([
      "MODEL_CHANGED",
      "SYSTEM_PROMPT_CHANGED",
      "TOOL_SCHEMA_CHANGED",
      "CONTEXT_REORDERED",
    ]);
    expect(tally).toEqual({
      MODEL_CHANGED: 0,
      SYSTEM_PROMPT_CHANGED: 0,
      TOOL_SCHEMA_CHANGED: 0,
      CONTEXT_REORDERED: 0,
    });
  });

  it("按原因计数", () => {
    const tally = tallyCacheBreakReasons([
      { requestIndex: 1, reason: "MODEL_CHANGED", zone: "MODEL", divergeByteOffset: 0 },
      { requestIndex: 2, reason: "MODEL_CHANGED", zone: "MODEL", divergeByteOffset: 0 },
      { requestIndex: 3, reason: "CONTEXT_REORDERED", zone: "B/C", divergeByteOffset: 42 },
    ]);
    expect(tally.MODEL_CHANGED).toBe(2);
    expect(tally.CONTEXT_REORDERED).toBe(1);
    expect(tally.SYSTEM_PROMPT_CHANGED).toBe(0);
    expect(tally.TOOL_SCHEMA_CHANGED).toBe(0);
  });
});

describe("runReview 集成 — 审计留痕（纯观测，不改变请求字节）", () => {
  it("happy path：Zone C append-only 纪律下 cacheBreaks 为空数组", async () => {
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    const result = await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, { auditDir });
    expect(result.audit.requests.length).toBeGreaterThanOrEqual(6);
    expect(result.audit.cacheBreaks).toEqual([]);
  });

  it("审计文件含 cacheBreaks 字段（与 rejections/phaseLog 同级）", async () => {
    const fake = FakeLlmClient.fromResponses(HAPPY_PATH_RESPONSES);
    const result = await runReview(CONFIGS.A, SAMPLE_MR_CASE, fake, { auditDir });
    expect(result.auditPath).toBeDefined();
    const content = JSON.parse(await readFile(result.auditPath ?? "", "utf8")) as Record<string, unknown>;
    expect(Array.isArray(content.cacheBreaks)).toBe(true);
    expect(content.cacheBreaks).toEqual([]);
    expect(Array.isArray(content.rejections)).toBe(true);
    expect(Array.isArray(content.phaseLog)).toBe(true);
  });
});

describe("报告与 dashboard — Cache Break 统计可见", () => {
  /** 带两条 break 留痕的手工记录（config A） */
  function recordWithBreaks(caseId: string): RunRecord {
    return {
      source: "defects4j",
      caseId,
      configId: "A",
      rep: 1,
      model: "deepseek-v4-flash",
      verifier: "off",
      completedAt: "2026-09-04T00:00:00.000Z",
      baseline: toRunSnapshot({
        caseId,
        configId: "A",
        findings: [],
        usage: { inputTokens: 100, outputTokens: 10 },
        rounds: 1,
        toolCalls: 0,
        audit: {
          requests: [],
          toolCallLog: [],
          phaseLog: [],
          rejections: [],
          cacheBreaks: [
            { requestIndex: 2, reason: "CONTEXT_REORDERED", zone: "B/C", divergeByteOffset: 42 },
            { requestIndex: 3, reason: "SYSTEM_PROMPT_CHANGED", zone: "A", divergeByteOffset: 7 },
          ],
          truncated: false,
          truncationReasons: [],
        },
        auditPath: "unused.json",
      }),
      effective: null,
      verifierPass: null,
    };
  }

  it("buildCacheBreakReport 按 config 汇总原因计数", () => {
    const entries = buildCacheBreakReport([recordWithBreaks("case-1"), recordWithBreaks("case-2")]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ configId: "A", runCount: 2, breakCount: 4 });
    expect(entries[0]?.byReason).toEqual({
      MODEL_CHANGED: 0,
      SYSTEM_PROMPT_CHANGED: 2,
      TOOL_SCHEMA_CHANGED: 0,
      CONTEXT_REORDERED: 2,
    });
  });

  it("dashboard 渲染 Cache Break 分类表", () => {
    const entries = buildCacheBreakReport([recordWithBreaks("case-1")]);
    const markdown = renderDashboardMarkdown(dashboardReportWith(entries));
    expect(markdown).toContain("## Cache break classification");
    expect(markdown).toContain("| A | 1 | 2 | 0 | 1 | 0 | 1 |");
  });

  function dashboardReportWith(
    cacheBreaks: ReturnType<typeof buildCacheBreakReport>,
  ): Parameters<typeof renderDashboardMarkdown>[0] {
    return {
      experimentId: "cache-break-dashboard-test",
      plan: {
        experimentId: "cache-break-dashboard-test",
        sources: ["defects4j"],
        configs: ["A"],
        reps: 1,
        verifier: "off",
        model: "deepseek-v4-flash",
        highRiskOnly: false,
        perSourceLimit: null,
        caseFilter: [],
        judge: false,
        humanReviewRate: 0.1,
        humanReviewSeed: "seed",
      },
      executed: 1,
      resumed: 0,
      failed: 0,
      failures: [],
      caseCount: 1,
      negativeControlCaseCount: 0,
      metrics: null,
      verdicts: null,
      negativeControl: null,
      verifierAblation: null,
      dedup: [],
      cacheBreaks,
      judge: null,
      humanReview: null,
    };
  }
});
