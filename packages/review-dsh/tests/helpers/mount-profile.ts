import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { LlmAdapter } from "@deepseek-ai/dsh-llm";
import { afterEach } from "vitest";

import { FakeLlmAdapter, type FakeLlmScriptStep } from "../../src/llm/fake-adapter.js";
import { assembleReviewProfile, type ReviewProfileHandle } from "../../src/profile/assemble.js";
import type { ReviewPolicyConfig } from "../../src/plugins/review-policy.js";

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

afterEach(async () => {
  while (mounted.length > 0) {
    const entry = mounted.pop();
    if (entry === undefined) break;
    await entry.handle.dispose();
    await rm(entry.sessionRoot, { recursive: true, force: true });
  }
});
