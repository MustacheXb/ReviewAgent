/**
 * #21 验收：Evidence Gate 在第六阶段回合边界执行（serial join）——候选 × 裁决
 * → Finding + 拒绝留痕 + 跨轮去重；多轮驱动（complete=false → 下一轮，
 * MAX_ROUNDS 冻结硬上界，耗尽显式截断）。
 *
 * 验证面（不窥探内核内部状态）：检视产出（findings / rejections / phaseLog）+
 * POC1 形态审计（requests / rounds / truncated）+ session 事件流（turn/end 序列
 * ——Gate 位于第六阶段 turn/end 之后、下一轮首条 followup 之前，事件流上呈现为
 * 轮间无多余 turn、round-2 首请求携带 round-1 全部历史）。
 */

import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import { describe, expect, it } from "vitest";

import { FakeLlmAdapter, type FakeLlmScriptStep } from "../../src/llm/fake-adapter.js";
import type { MrInput } from "../../src/plugins/review-context.js";
import { PHASE_INSTRUCTIONS } from "../../src/plugins/review-policy.js";
import { mount, mountAdapter } from "../helpers/mount-profile.js";

const INPUT: MrInput = {
  caseId: "EVIDENCE-GATE-1",
  issueDescription: "Vulnerability fix: URL encoding",
  diff: "--- a/src/main/java/Example.java\n+++ b/src/main/java/Example.java\n@@ -1,1 +1,1 @@\n-old\n+new",
};

/** 六阶段序（POC1 PHASE_ORDER；阶段轨迹断言的期望面） */
const EXPECTED_PHASES = [
  "Change Understanding",
  "Risk Classification",
  "Context Decision",
  "Context Retrieval",
  "Deep Reasoning",
  "Evidence Verification",
] as const;

/** 有证据候选（POC1 Finding 契约全字段：id / severity / category / file / line /
 * title / description / evidence / rule / confidence） */
const CANDIDATE_F001 = {
  id: "F001",
  severity: "P2",
  category: "CORRECTNESS",
  file: "src/main/java/Example.java",
  line: 42,
  title: "Incorrect URL encoding of query parameters",
  description: "The change encodes the joined query string instead of individual parameter values, breaking clients that send reserved characters.",
  evidence: ["Example.java:42 - URLEncoder.encode applied to the joined query string"],
  rule: "CORRECTNESS-001",
  confidence: 0.9,
};

/** 轮 2 新候选（跨轮去重的对照面：与 F001 同轮提交、独立通过） */
const CANDIDATE_F002 = {
  id: "F002",
  severity: "P3",
  category: "MAINTAINABILITY",
  file: "src/main/java/Example.java",
  line: 57,
  title: "Duplicated encoding helper after refactor",
  description: "The refactor leaves a private encoding helper with no remaining callers, obscuring the intended single path.",
  evidence: ["Example.java:57 - private String encodeLegacy unused after call-site migration"],
  rule: "MAINTAINABILITY-002",
  confidence: 0.7,
};

function reply(content: string): FakeLlmScriptStep {
  return { kind: "reply", content };
}

/** 阶段 1–4 的通用回复（解析面只关心 Deep Reasoning / Evidence Verification） */
const GENERIC_PHASE_REPLIES: readonly string[] = [
  '{"summary":"Loop boundary change in query encoding."}',
  '{"riskClass":"Medium","reason":"business logic change"}',
  '{"neededContext":[],"reason":"diff is self-contained"}',
  '{"notes":"No further context in this configuration."}',
];

describe("Evidence Gate 三态（#21：第六阶段回合边界的候选 join）", () => {
  it("有证据候选通过：Finding 字段与 POC1 契约逐字段一致，零拒绝", async () => {
    const script: readonly FakeLlmScriptStep[] = [
      ...GENERIC_PHASE_REPLIES.map(reply),
      reply(JSON.stringify({ candidates: [CANDIDATE_F001] })),
      reply(JSON.stringify({ verdicts: [{ id: "F001", pass: true, reason: "evidence supports the finding" }], complete: true })),
    ];
    const { ctx } = await mount(script);

    const result = await ctx.reviewRuntime.run(INPUT);

    // Finding 过闸：候选对象逐字段投影（10 字段全携带，无增删改）
    expect(result.findings).toEqual([CANDIDATE_F001]);
    expect(result.audit.findings).toEqual([CANDIDATE_F001]);
    expect(Object.keys(result.findings[0] ?? {}).sort()).toEqual([
      "category",
      "confidence",
      "description",
      "evidence",
      "file",
      "id",
      "line",
      "rule",
      "severity",
      "title",
    ]);
    expect(result.audit.rejections).toEqual([]);
  });

  it("无证据候选被拒：No Evidence, No Finding——空 evidence 不因 verdict 通过放行", async () => {
    const noEvidence = { ...CANDIDATE_F001, evidence: [] };
    const script: readonly FakeLlmScriptStep[] = [
      ...GENERIC_PHASE_REPLIES.map(reply),
      reply(JSON.stringify({ candidates: [noEvidence] })),
      reply(JSON.stringify({ verdicts: [{ id: "F001", pass: true, reason: "evidence supports the finding" }], complete: true })),
    ];
    const { ctx } = await mount(script);

    const result = await ctx.reviewRuntime.run(INPUT);

    expect(result.findings).toEqual([]);
    // 被拒候选在审计中留痕（可归因：候选 id + 拦截阶段 + 原因）
    expect(result.audit.rejections).toEqual([
      {
        candidateId: "F001",
        stage: "NO_EVIDENCE",
        reason: "no evidence cited (No Evidence, No Finding)",
      },
    ]);
  });

  it("跨轮重复候选去重：round-1 已发出的 id 在 round-2 重复提交 → DUPLICATE_ID，Finding 只发一次", async () => {
    const script: readonly FakeLlmScriptStep[] = [
      // —— round 1：F001 有证据通过，但 verdict complete=false → 开启 round 2
      ...GENERIC_PHASE_REPLIES.map(reply),
      reply(JSON.stringify({ candidates: [CANDIDATE_F001] })),
      reply(JSON.stringify({ verdicts: [{ id: "F001", pass: true, reason: "evidence supports the finding" }], complete: false })),
      // —— round 2：F001 原样重提（有证据、verdict 通过）+ F002 新候选
      ...GENERIC_PHASE_REPLIES.map(reply),
      reply(JSON.stringify({ candidates: [CANDIDATE_F001, CANDIDATE_F002] })),
      reply(
        JSON.stringify({
          verdicts: [
            { id: "F001", pass: true, reason: "evidence still supports the finding" },
            { id: "F002", pass: true, reason: "evidence supports the finding" },
          ],
          complete: true,
        }),
      ),
    ];
    const { ctx } = await mount(script);

    // 事件流观测（不窥探内核内部状态）：turn/end 序列——Gate 在第六阶段 turn/end
    // 之后、下一轮首条 followup 之前执行，事件流上呈现为轮间无多余 turn
    const turnEnds: { turn: number; kind: string }[] = [];
    const off = ctx.on("session/event", (_session: Session, event: SessionEvent) => {
      if (event.type === "turn/end") {
        turnEnds.push({ turn: event.data.turn, kind: event.data.reason.kind });
      }
    });

    try {
      const result = await ctx.reviewRuntime.run(INPUT);

      // —— 事件流：恰好 12 个 turn（2 轮 × 6 阶段）全部 completed，Gate 未引入多余 turn
      expect(turnEnds).toEqual(Array.from({ length: 12 }, (_, index) => ({ turn: index + 1, kind: "completed" })));

      // —— 跨轮去重：F001 只发一次（round-1 发出），round-2 重提被拒
      expect(result.findings).toEqual([CANDIDATE_F001, CANDIDATE_F002]);
      expect(result.audit.rejections).toEqual([
        {
          candidateId: "F001",
          stage: "DUPLICATE_ID",
          reason: "a finding with this id was already emitted in an earlier round",
        },
      ]);

      // —— 多轮审计：rounds 实际值 2，未截断
      expect(result.audit.rounds).toBe(2);
      expect(result.audit.truncated).toBe(false);
      expect(result.audit.truncationReasons).toEqual([]);

      // —— 阶段轨迹：round 1 × 6 阶段 + round 2 × 6 阶段，每阶段 1 次请求
      expect(result.audit.phaseLog.map((entry) => [entry.round, entry.phase])).toEqual([
        ...EXPECTED_PHASES.map((phase) => [1, phase]),
        ...EXPECTED_PHASES.map((phase) => [2, phase]),
      ]);
      expect(result.audit.requests).toHaveLength(12);

      // —— Gate 边界（事件流可验证的另一面）：round-2 首请求携带 round-1 全部历史
      //（含 phase-6 的 assistant 回复），尾消息 = round-2 Phase 1 指令
      const round2First = result.audit.requests[6]?.messages;
      expect(round2First).toHaveLength(15);
      expect(round2First?.[13]).toEqual({
        role: "assistant",
        content: JSON.stringify({
          verdicts: [{ id: "F001", pass: true, reason: "evidence supports the finding" }],
          complete: false,
        }),
      });
      expect(round2First?.[14]).toEqual({ role: "user", content: PHASE_INSTRUCTIONS["Change Understanding"] });
    } finally {
      off();
    }
  });
});

describe("多轮驱动（#21：complete=false → 下一轮，MAX_ROUNDS 冻结硬上界）", () => {
  it("verdict 永不 complete：推进满 5 轮后截断——rounds=5、MAX_ROUNDS_REACHED、30 请求", async () => {
    // fallback 步：脚本耗尽后持续供给「永不完成」回复（fake 适配器为上界截断
    // 测试预留的形态）——每轮六阶段推进后 complete=false，直到 MAX_ROUNDS 耗尽
    const neverComplete: FakeLlmScriptStep = reply('{"verdicts":[],"complete":false}');
    const adapter = new FakeLlmAdapter([], { fallback: neverComplete });
    const { ctx } = await mountAdapter(adapter);

    const result = await ctx.reviewRuntime.run(INPUT);

    // —— 截断语义（POC1 1:1）：truncated = 评审未完成；MAX_ROUNDS_REACHED 记因
    expect(result.audit.rounds).toBe(5);
    expect(result.audit.truncated).toBe(true);
    expect(result.audit.truncationReasons).toEqual(["MAX_ROUNDS_REACHED"]);

    // —— 有界推进：5 轮 × 6 阶段 = 30 请求、30 条阶段轨迹，轮号 1–5 各 6 条
    expect(result.audit.requests).toHaveLength(30);
    expect(result.audit.phaseLog).toHaveLength(30);
    expect(result.audit.phaseLog.map((entry) => entry.round)).toEqual(
      Array.from({ length: 30 }, (_, index) => Math.floor(index / 6) + 1),
    );

    // —— 解析 note 逐轮落位：fallback 文本非 candidates 形态，Deep Reasoning
    // 条目逐轮携带解析 note（round 1 = 索引 4，round 2 = 索引 10）
    expect(result.audit.phaseLog[4]?.note).toBe("deep-reasoning reply has no candidates array");
    expect(result.audit.phaseLog[10]?.note).toBe("deep-reasoning reply has no candidates array");

    // —— 零候选零裁决：无 Finding、无拒绝
    expect(result.findings).toEqual([]);
    expect(result.audit.rejections).toEqual([]);
  });
});
