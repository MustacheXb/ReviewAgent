/**
 * #25 验收：A–E 五 preset——配置语义复刻（spec #1 配置表）。
 *
 * 四条锁线：
 * - 注册表 ≡ 冻结 CONFIGS 逐字段（配置表零漂移）+ deriveConfigId 对每个
 *   preset 往返回环（非矩阵组合组装期拒绝，见 review-policy.test.ts）；
 * - 同一单元五配置 fake 运行全部跑通，审计呈现预期上下文/工具差异：
 *   A/B 零工具调用、B 三层预取记账、C 全仓上下文（请求字节 + fullRepo 记账，
 *   冻结管线 oracle 逐字节）、D/E 工具自主检索（E 加 Ledger 留痕）；
 * - 每配置 Zone A 字节确定：同配置两次独立装配运行全部请求逐字节相等；
 * - stablePrefix（D/E）为纯声明开关——请求字节与 C 形态的工具面同源。
 */

import { describe, expect, it } from "vitest";

import type { ConfigId } from "../../../../src/contracts/config.js";
import { CONFIGS } from "../../../../src/contracts/config.js";
import { DEFAULT_FULL_REPO_BUDGET_CHARS } from "../../../../src/zoneb/full-repo-injection.js";
import { buildFullRepoInjection } from "../../../../src/zoneb/full-repo-injection.js";
import { loadRepoContext } from "../../../../src/zoneb/repo-context.js";
import { SAMPLE_MR_CASE } from "../../../../tests/fixtures/sample-mr-case.js";

import type { FakeLlmScriptStep } from "../../src/llm/fake-adapter.js";
import type { MrInput } from "../../src/plugins/review-context.js";
import type { ReviewAudit } from "../../src/plugins/review-runtime.js";
import { REVIEW_PRESETS, deriveConfigId } from "../../src/presets/review-presets.js";
import { mount, runIsolated } from "../helpers/mount-profile.js";

const CONFIG_IDS: readonly ConfigId[] = ["A", "B", "C", "D", "E"];

const MATH_UTILS = "src/main/java/com/example/math/MathUtils.java";

/** 同一单元（五配置共用 MR 输入；repoPath 供 C 全仓注入与 D/E 工具数据源） */
const INPUT: MrInput = {
  caseId: "PRESET-MATRIX-1",
  issueDescription: SAMPLE_MR_CASE.issueDescription,
  diff: SAMPLE_MR_CASE.diff,
  repoPath: SAMPLE_MR_CASE.repoPath,
};

/** A/B/C 脚本：六阶段纯文本（A/B 零工具；C 全仓上下文在手，脚本不调工具） */
function plainScript(): readonly FakeLlmScriptStep[] {
  return [
    { kind: "reply", content: '{"summary":"Loop boundary change in MathUtils.sumFirst."}' },
    { kind: "reply", content: '{"riskClass":"High","reason":"array indexing logic"}' },
    { kind: "reply", content: '{"neededContext":[],"reason":"context already complete"}' },
    { kind: "reply", content: '{"notes":"No further context retrieval needed."}' },
    { kind: "reply", content: '{"candidates":[]}' },
    { kind: "reply", content: '{"verdicts":[],"complete":true}' },
  ];
}

/** D/E 脚本：Phase 4 工具自主检索（get_file 一次 + notes 收尾——Phase 4 两次请求） */
function toolRetrievalScript(): readonly FakeLlmScriptStep[] {
  return [
    { kind: "reply", content: '{"summary":"Loop boundary change in MathUtils.sumFirst."}' },
    { kind: "reply", content: '{"riskClass":"High","reason":"array indexing logic"}' },
    { kind: "reply", content: '{"neededContext":["sumFirst signature"],"reason":"verify loop bounds"}' },
    {
      kind: "reply",
      content: "",
      toolCalls: [
        { id: "call-1", name: "review.get_file", arguments: `{"path":"${MATH_UTILS}","startLine":1,"endLine":40}` },
      ],
    },
    { kind: "reply", content: '{"notes":"sumFirst source retrieved."}' },
    { kind: "reply", content: '{"candidates":[]}' },
    { kind: "reply", content: '{"verdicts":[],"complete":true}' },
  ];
}

/** 各配置的 fake 脚本形态（A/B/C 零调用；D/E 自主检索） */
const SCRIPTS: Readonly<Record<ConfigId, () => readonly FakeLlmScriptStep[]>> = {
  A: plainScript,
  B: plainScript,
  C: plainScript,
  D: toolRetrievalScript,
  E: toolRetrievalScript,
};

/** 一次 preset 运行（挂载 + run，afterEach 统一拆卸） */
async function runPreset(configId: ConfigId): Promise<ReviewAudit> {
  const { ctx } = await mount(SCRIPTS[configId](), { policy: REVIEW_PRESETS[configId] });
  const result = await ctx.reviewRuntime.run(INPUT);
  return result.audit;
}

describe("preset 注册表 ≡ 冻结配置表（spec #1 零漂移）", () => {
  it("五配置开关逐字段一致；deriveConfigId 对每个 preset 往返回环", () => {
    for (const configId of CONFIG_IDS) {
      const preset = REVIEW_PRESETS[configId];
      const frozen = CONFIGS[configId];

      expect({
        toolsEnabled: preset.toolsEnabled === true,
        prefetch: preset.prefetch === true,
        fullRepo: preset.fullRepo === true,
        stablePrefix: preset.stablePrefix === true,
        ledger: preset.ledger === true,
      }).toEqual({
        toolsEnabled: frozen.toolsEnabled,
        prefetch: frozen.prefetch,
        fullRepo: frozen.fullRepo,
        stablePrefix: frozen.stablePrefix,
        ledger: frozen.ledger,
      });

      expect(deriveConfigId(preset)).toBe(configId);
    }
  });
});

describe("五 preset 全跑通（同一单元 × 五配置 fake 运行，审计差异呈现）", () => {
  it("config A：零工具零注入——tools 恒 []，无 prefetch/fullRepo/ledger 记账", async () => {
    const audit = await runPreset("A");

    expect(audit.configId).toBe("A");
    expect(audit.requests).toHaveLength(6);
    for (const request of audit.requests) {
      expect(request.tools).toEqual([]);
    }
    expect(audit.toolCalls).toBe(0);
    expect(audit.toolCallLog).toEqual([]);
    expect(audit.prefetch).toBeUndefined();
    expect(audit.fullRepo).toBeUndefined();
    expect(audit.ledger).toBeUndefined();
    // 请求 1 布局：[system, MR intro, Phase 1]
    expect(audit.requests[0]?.messages).toHaveLength(3);
  });

  it("config B：确定性预取——4 条注入层记账，Zone B + 三层进请求字节，零工具", async () => {
    const audit = await runPreset("B");

    expect(audit.configId).toBe("B");
    expect(audit.prefetch).toHaveLength(4);
    expect(audit.requests[0]?.messages).toHaveLength(7);
    for (const request of audit.requests) {
      expect(request.tools).toEqual([]);
    }
    expect(audit.toolCalls).toBe(0);
    expect(audit.fullRepo).toBeUndefined();
  });

  it("config C：全仓上下文——fullRepo 记账 = 冻结管线 oracle，全仓消息在 MR intro 之后进请求字节，7 工具零调用", async () => {
    const audit = await runPreset("C");
    const oracle = await buildFullRepoInjection({
      repo: await loadRepoContext(SAMPLE_MR_CASE.repoPath),
      budgetChars: DEFAULT_FULL_REPO_BUDGET_CHARS,
    });

    expect(audit.configId).toBe("C");
    // 注入记账（POC1 RunAudit.fullRepo 契约）与冻结管线同参直跑逐字段一致
    expect(audit.fullRepo).toEqual(oracle.record);
    // 请求 1 布局：[system, MR intro, 全仓消息, Phase 1]（POC1 fullRepo 注入位次）
    expect(audit.requests[0]?.messages).toHaveLength(4);
    expect(audit.requests[0]?.messages[2]).toEqual({ role: "user", content: oracle.message.content });
    // 工具面：7 schema 逐请求挂载（Zone A），脚本零调用
    for (const request of audit.requests) {
      expect(request.tools).toHaveLength(7);
    }
    expect(audit.toolCalls).toBe(0);
    expect(audit.prefetch).toBeUndefined();
  });

  it("config D：工具自主检索——get_file 过注册面执行，toolCallLog 留痕，无 Ledger", async () => {
    const audit = await runPreset("D");

    expect(audit.configId).toBe("D");
    expect(audit.requests).toHaveLength(7); // Phase 4 工具循环多一次
    for (const request of audit.requests) {
      expect(request.tools).toHaveLength(7);
    }
    expect(audit.toolCalls).toBe(1);
    expect(audit.toolCallLog).toHaveLength(1);
    expect(audit.toolCallLog[0]?.name).toBe("review.get_file");
    expect(audit.toolCallLog[0]?.resultSummary.length).toBeGreaterThan(0);
    expect(audit.fullRepo).toBeUndefined();
    expect(audit.prefetch).toBeUndefined();
    expect(audit.ledger).toBeUndefined();
  });

  it("config E：D + Ledger——同一次检索登记 ctx#001，快照进审计", async () => {
    const audit = await runPreset("E");

    expect(audit.configId).toBe("E");
    expect(audit.toolCalls).toBe(1);
    expect(audit.ledger).toHaveLength(1);
    expect(audit.ledger?.[0]?.id).toBe("ctx#001");
  });
});

describe("每配置 Zone A 字节确定（同配置两次独立装配运行）", () => {
  for (const configId of CONFIG_IDS) {
    it(`config ${configId}：两次独立运行全部请求逐字节相等`, async () => {
      const first = await runOnce(configId);
      const second = await runOnce(configId);

      expect(first.requests.length).toBeGreaterThan(0);
      expect(second.requests.map((request) => JSON.stringify(request))).toEqual(
        first.requests.map((request) => JSON.stringify(request)),
      );
    });
  }
});

/** 一次完整独立装配 + preset 会话（inline 拆卸，两次运行零共享状态） */
async function runOnce(configId: ConfigId): Promise<ReviewAudit> {
  const { result } = await runIsolated(SCRIPTS[configId](), { policy: REVIEW_PRESETS[configId] }, INPUT);
  return result.audit;
}
