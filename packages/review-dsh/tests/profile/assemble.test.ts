import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { renderPrompt } from "@deepseek-ai/dsh-system-prompt";
import { describe, expect, it } from "vitest";

import { SYSTEM_PROMPT } from "../../../../src/loop/messages.js";
import { FakeLlmAdapter } from "../../src/llm/fake-adapter.js";
import { assembleReviewProfile } from "../../src/profile/assemble.js";
import { mount } from "../helpers/mount-profile.js";

describe("review profile：显式最小树组装（不继承 dsh-base）", () => {
  it("九个 DSH 行 + 五个核内插件全部挂载为可注入服务", async () => {
    const { ctx } = await mount();

    // DSH 行（ADR-0006 行集；session-projection 为 agent-loop 硬注入的必需行）
    for (const service of [
      "cmdlineArgs",
      "appExit",
      "llm",
      "sessions",
      "sessionProjections",
      "systemPrompt",
      "tools",
      "agents",
      "agentLoop",
    ]) {
      expect(ctx.get(service), `service: ${service}`).toBeTruthy();
    }

    // 五个核内插件胚胎
    for (const service of ["reviewPolicy", "reviewContext", "reviewRuntime", "reviewCache", "reviewEvidence"]) {
      expect(ctx.get(service), `service: ${service}`).toBeTruthy();
    }
  });

  it("fake 适配器经 ctx.llm seam 注册，deepseek 路由可见", async () => {
    const { ctx } = await mount();

    expect(ctx.llm.listProviders().map((info) => info.id)).toContain("deepseek");
  });

  it("reviewPolicy 携带 config A 政策：六阶段、硬上界、模型路由、零工具", async () => {
    const { ctx } = await mount();

    expect(ctx.reviewPolicy.phases).toEqual([
      "Change Understanding",
      "Risk Classification",
      "Context Decision",
      "Context Retrieval",
      "Deep Reasoning",
      "Evidence Verification",
    ]);
    expect(ctx.reviewPolicy.maxRounds).toBe(5);
    expect(ctx.reviewPolicy.maxToolCalls).toBe(6);
    expect(ctx.reviewPolicy.provider).toBe("deepseek");
    expect(ctx.reviewPolicy.model).toBe("deepseek-v4-flash");
    expect(ctx.reviewPolicy.effortLabel).toBe("default");
    expect(ctx.reviewPolicy.toolsEnabled).toBe(false);
  });

  it("Zone A 以 complete section 落位：渲染后的 system prompt 与冻结 harness 字节一致", async () => {
    const { ctx } = await mount();

    const assembly = await ctx.systemPrompt.assemble();
    expect(renderPrompt(assembly)).toBe(SYSTEM_PROMPT);
  });

  it("dispose 后服务全部卸载，树可干净拆除", async () => {
    const ctx = new Context();
    const sessionRoot = await mkdtemp(join(tmpdir(), "review-dsh-profile-"));
    const handle = await assembleReviewProfile(ctx, {
      sessionRoot,
      adapter: new FakeLlmAdapter([]),
    });
    expect(ctx.get("llm")).toBeTruthy();
    expect(ctx.get("reviewPolicy")).toBeTruthy();

    await handle.dispose();
    await rm(sessionRoot, { recursive: true, force: true });

    // 根 fiber dispose 卸载全部已挂载插件（根 context 自身保持可用，仅插件 fiber 转入 DISPOSED）
    expect(ctx.get("llm")).toBeUndefined();
    expect(ctx.get("sessions")).toBeUndefined();
    expect(ctx.get("agentLoop")).toBeUndefined();
    expect(ctx.get("reviewPolicy")).toBeUndefined();
    expect(ctx.get("reviewRuntime")).toBeUndefined();
  });
});
