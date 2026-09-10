import { LlmAdapter, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from "@deepseek-ai/dsh-llm";
import { describe, expect, it } from "vitest";

import { DEFAULT_TURN_TIMEOUT_MS } from "../../src/plugins/review-policy.js";
import type { MrInput } from "../../src/plugins/review-context.js";
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
});
