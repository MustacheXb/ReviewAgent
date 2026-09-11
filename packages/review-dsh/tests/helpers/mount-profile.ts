import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { LlmAdapter } from "@deepseek-ai/dsh-llm";
import { afterEach } from "vitest";

import { FakeLlmAdapter, type FakeLlmScriptStep } from "../../src/llm/fake-adapter.js";
import { assembleReviewProfile, type ReviewProfileHandle } from "../../src/profile/assemble.js";
import type { MrInput } from "../../src/plugins/review-context.js";
import type { ReviewPolicyConfig } from "../../src/plugins/review-policy.js";
import type { ReviewRunResult } from "../../src/plugins/review-runtime.js";

/** 适配器由调用方注入的组装结果（生产适配器与 fake 同 seam 互换测试用） */
export interface MountedWithAdapter {
  readonly ctx: Context;
  readonly handle: ReviewProfileHandle;
  readonly sessionRoot: string;
}

/** fake 适配器组装结果：在通用形态上补回 fake 的观测面 */
export interface Mounted extends MountedWithAdapter {
  readonly adapter: FakeLlmAdapter;
}

/** 组装选项：review-policy 插件 config 转发（turnTimeoutMs 覆盖等） */
export interface MountOptions {
  readonly policy?: ReviewPolicyConfig;
}

const mounted: { handle: ReviewProfileHandle; sessionRoot: string }[] = [];

async function mountEntry(adapter: LlmAdapter, options: MountOptions = {}): Promise<MountedWithAdapter> {
  const ctx = new Context();
  const sessionRoot = await mkdtemp(join(tmpdir(), "review-dsh-"));
  try {
    const handle = await assembleReviewProfile(ctx, {
      sessionRoot,
      adapter,
      ...(options.policy !== undefined ? { policy: options.policy } : {}),
    });
    mounted.push({ handle, sessionRoot });
    return { ctx, handle, sessionRoot };
  } catch (error) {
    // 组装失败（如政策校验）：半挂树与临时目录就地清理，不留悬置句柄
    await ctx.fiber.dispose();
    await rm(sessionRoot, { recursive: true, force: true });
    throw error;
  }
}

/** 组装一棵真实树：独立 mkdtemp sessionRoot + FakeLlmAdapter；用例结束统一拆卸 */
export async function mount(
  script: readonly FakeLlmScriptStep[] = [],
  options: MountOptions = {},
): Promise<Mounted> {
  const adapter = new FakeLlmAdapter(script);
  const entry = await mountEntry(adapter, options);
  return { ...entry, adapter };
}

/** 组装一棵真实树，适配器由调用方注入（DeepSeek 适配器等生产件） */
export async function mountAdapter(
  adapter: LlmAdapter,
  options: MountOptions = {},
): Promise<MountedWithAdapter> {
  return mountEntry(adapter, options);
}

/**
 * 一次完整独立装配 + 检视会话（inline 拆卸）：与 afterEach 队列的 mount 不同，
 * 会话结束立即 dispose——同一 it 内多次运行互不渗透（稳定门「两次运行必须
 * 零共享状态」的前提），失败路径同样不留悬置树与临时目录。
 */
export async function runIsolated(
  script: readonly FakeLlmScriptStep[],
  options: MountOptions,
  input: MrInput,
): Promise<{ result: ReviewRunResult; zoneSnapshots: readonly string[] }> {
  const ctx = new Context();
  const sessionRoot = await mkdtemp(join(tmpdir(), "review-dsh-isolated-"));
  try {
    const handle = await assembleReviewProfile(ctx, {
      sessionRoot,
      adapter: new FakeLlmAdapter(script),
      ...(options.policy !== undefined ? { policy: options.policy } : {}),
    });
    try {
      const result = await ctx.reviewRuntime.run(input);
      return { result, zoneSnapshots: ctx.reviewCache.zoneSnapshots };
    } finally {
      await handle.dispose();
    }
  } finally {
    await rm(sessionRoot, { recursive: true, force: true });
  }
}

afterEach(async () => {
  while (mounted.length > 0) {
    const entry = mounted.pop();
    if (entry === undefined) break;
    await entry.handle.dispose();
    await rm(entry.sessionRoot, { recursive: true, force: true });
  }
});
