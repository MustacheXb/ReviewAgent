import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { afterEach } from "vitest";

import { FakeLlmAdapter, type FakeLlmScriptStep } from "../../src/llm/fake-adapter.js";
import { assembleReviewProfile, type ReviewProfileHandle } from "../../src/profile/assemble.js";

/** 一棵已组装的真实 review profile 树（进程内，测试生命周期） */
export interface Mounted {
  readonly ctx: Context;
  readonly handle: ReviewProfileHandle;
  readonly adapter: FakeLlmAdapter;
  readonly sessionRoot: string;
}

const mounted: Mounted[] = [];

/** 组装一棵真实树：独立 mkdtemp sessionRoot + FakeLlmAdapter；用例结束统一拆卸 */
export async function mount(script: readonly FakeLlmScriptStep[] = []): Promise<Mounted> {
  const ctx = new Context();
  const sessionRoot = await mkdtemp(join(tmpdir(), "review-dsh-"));
  const adapter = new FakeLlmAdapter(script);
  const handle = await assembleReviewProfile(ctx, { sessionRoot, adapter });
  const entry: Mounted = { ctx, handle, adapter, sessionRoot };
  mounted.push(entry);
  return entry;
}

afterEach(async () => {
  while (mounted.length > 0) {
    const entry = mounted.pop();
    if (entry === undefined) break;
    await entry.handle.dispose();
    await rm(entry.sessionRoot, { recursive: true, force: true });
  }
});
