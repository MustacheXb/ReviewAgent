import { LlmAdapter, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from "@deepseek-ai/dsh-llm";
import { describe, expect, it } from "vitest";

import { DEFAULT_TURN_TIMEOUT_MS, REAL_LLM_TURN_TIMEOUT_MS } from "../../src/plugins/review-policy.js";
import { DEFAULT_DEEPSEEK_TIMEOUT_MS } from "../../src/llm/deepseek-adapter.js";
import { realApiReviewPolicy } from "../../src/profile/assemble.js";
import type { MrInput } from "../../src/plugins/review-context.js";
import { REVIEW_PRESETS } from "../../src/presets/review-presets.js";
import { mount, mountAdapter } from "../helpers/mount-profile.js";

const INPUT: MrInput = {
  caseId: "TIMEOUT-1",
  issueDescription: "turn timeout probe",
  diff: "--- a/src/main/java/Example.java\n+++ b/src/main/java/Example.java\n@@ -1,1 +1,1 @@\n-old\n+new",
};

/**
 * 悬停适配器：stream 起即挂起、释放门后才收尾——制造「turn 不结束」观测条件
 * （turnTimeoutMs 是防御性上界，只有真悬停才能证明运行时读的是政策值而非常量）。
 */
class HangAdapter extends LlmAdapter {
  private readonly gate: Promise<void>;

  constructor(gate: Promise<void>) {
    super();
    this.gate = gate;
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [{ id: ReasoningEffortId("default"), name: "Default" }],
        defaultEffort: ReasoningEffortId("default"),
      },
    });
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    void options;
    await this.gate;
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

describe("turnTimeoutMs 政策化（policy 服务 + runtime 等待上界 + 组装转发）", () => {
  it("缺省政策：服务暴露 10_000ms 单 turn 等待上界", async () => {
    const { ctx } = await mount();

    expect(DEFAULT_TURN_TIMEOUT_MS).toBe(10_000);
    expect(ctx.reviewPolicy.turnTimeoutMs).toBe(10_000);
  });

  it("组装转发：policy.turnTimeoutMs 覆盖直达服务", async () => {
    const { ctx } = await mountAdapter(new HangAdapter(Promise.resolve()), {
      policy: { turnTimeoutMs: 60_000 },
    });

    expect(ctx.reviewPolicy.turnTimeoutMs).toBe(60_000);
  });

  it("运行时读政策：turn 未在政策时限内结束 → 显式失败并携带政策值", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { ctx } = await mountAdapter(new HangAdapter(gate), { policy: { turnTimeoutMs: 30 } });

    try {
      await expect(ctx.reviewRuntime.run(INPUT)).rejects.toThrow(
        "review-runtime: turn 1 did not end within 30ms",
      );
    } finally {
      // 释放悬停 turn 并留一拍让其落定，再交由 afterEach 统一拆卸
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });

  it("非法值 fail fast：0 / 负数 / 非整数在组装期拒绝", async () => {
    await expect(mount([], { policy: { turnTimeoutMs: 0 } })).rejects.toThrow(
      /turnTimeoutMs must be a positive integer/,
    );
    await expect(mount([], { policy: { turnTimeoutMs: -5 } })).rejects.toThrow(
      /turnTimeoutMs must be a positive integer/,
    );
    await expect(mount([], { policy: { turnTimeoutMs: 12.5 } })).rejects.toThrow(
      /turnTimeoutMs must be a positive integer/,
    );
  });

  it("组合校验 fail fast：ledger=true 而 toolsEnabled 缺省 → 组装期拒绝（不静默空转）", async () => {
    await expect(mount([], { policy: { ledger: true } })).rejects.toThrow(/ledger requires toolsEnabled/);
  });

  it("真实 API 级上界不变式：不早于适配器单请求超时（护栏不得先于延迟权威绑定）", () => {
    // 900s 上界须容下一整次适配器超时重试周期（单请求 600s）——若有人调小
    // REAL_LLM_TURN_TIMEOUT_MS 或调大 DEFAULT_DEEPSEEK_TIMEOUT_MS，先在这里红
    expect(REAL_LLM_TURN_TIMEOUT_MS).toBeGreaterThan(DEFAULT_DEEPSEEK_TIMEOUT_MS);
  });

  it("生产组装政策面：realApiReviewPolicy（host/CLI 共用）preset 语义 + 真实级 turn 预算直达服务", async () => {
    const { ctx } = await mount([], { policy: realApiReviewPolicy("D") });

    // preset 语义不被 turnTimeoutMs 覆盖冲掉（spread 后仍逐字段直达）
    expect(ctx.reviewPolicy.toolsEnabled).toBe(true);
    expect(ctx.reviewPolicy.stablePrefix).toBe(true);
    expect(ctx.reviewPolicy.ledger).toBe(false);
    expect(ctx.reviewPolicy.fullRepo).toBe(false);
    expect(ctx.reviewPolicy.prefetch).toBe(false);
    // 真实 API 级 turn 预算（缺省 10s 只对进程内 fake 成立）
    expect(ctx.reviewPolicy.turnTimeoutMs).toBe(REAL_LLM_TURN_TIMEOUT_MS);
  });
});

describe("prefetch 开关（config B 形态）", () => {
  it("缺省政策：prefetch=false（config A，零预取零工具）", async () => {
    const { ctx } = await mount();

    expect(ctx.reviewPolicy.prefetch).toBe(false);
  });

  it("组装转发：policy.prefetch 覆盖直达服务", async () => {
    const { ctx } = await mount([], { policy: { prefetch: true } });

    expect(ctx.reviewPolicy.prefetch).toBe(true);
  });

  it("组合校验 fail fast：prefetch 与 toolsEnabled 同启 → 组装期拒绝（不在 A–E 实验矩阵）", async () => {
    await expect(mount([], { policy: { prefetch: true, toolsEnabled: true } })).rejects.toThrow(
      /mutually exclusive/,
    );
  });
});

describe("A–E 矩阵收口（#25：内核只装五形态，非矩阵组合组装期拒绝）", () => {
  it("fullRepo 而无 toolsEnabled → 拒绝（矩阵上 C = 工具 + 全仓，无零工具全仓形态）", async () => {
    await expect(mount([], { policy: { fullRepo: true } })).rejects.toThrow(/outside the A-E matrix/);
  });

  it("stablePrefix 而无 toolsEnabled → 拒绝（矩阵上 D/E 均挂工具）", async () => {
    await expect(mount([], { policy: { stablePrefix: true } })).rejects.toThrow(/outside the A-E matrix/);
  });

  it("toolsEnabled 而无 fullRepo/stablePrefix → 拒绝（裸工具形态不在矩阵：C 需全仓、D/E 需 stablePrefix）", async () => {
    await expect(mount([], { policy: { toolsEnabled: true } })).rejects.toThrow(/outside the A-E matrix/);
  });

  it("工具 + fullRepo + stablePrefix 杂交 → 拒绝（C 与 D/E 的混合形态）", async () => {
    await expect(
      mount([], { policy: { toolsEnabled: true, fullRepo: true, stablePrefix: true } }),
    ).rejects.toThrow(/outside the A-E matrix/);
  });

  it("preset 直通：REVIEW_PRESETS.E 经组装校验，服务开关面逐字段直达", async () => {
    const { ctx } = await mount([], { policy: REVIEW_PRESETS.E });

    expect(ctx.reviewPolicy.toolsEnabled).toBe(true);
    expect(ctx.reviewPolicy.stablePrefix).toBe(true);
    expect(ctx.reviewPolicy.ledger).toBe(true);
    expect(ctx.reviewPolicy.fullRepo).toBe(false);
    expect(ctx.reviewPolicy.prefetch).toBe(false);
  });
});
