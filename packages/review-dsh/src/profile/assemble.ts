/**
 * review profile 组装：宿主侧供 cmdline 服务 → 按 REVIEW_PROFILE_ROWS 顺序挂载
 * DSH npm 行与核内插件 → 在 ctx.llm seam 注册适配器。
 *
 * 进程内组装先例 = dsh-agent-loop-testkit mountAgentLoopTestDependencies
 * （ctx.plugin 直挂，调用方持有 context 与拆卸）；cmdline 行以 provideCmdline
 * 落位（0.1.2-rc.1 的 dsh-cmdline 是宿主侧库函数，运行期不触碰 loader）。
 */

import type { Context } from "@deepseek-ai/cordis";
import { provideCmdline } from "@deepseek-ai/dsh-cmdline";
import type { LlmAdapter } from "@deepseek-ai/dsh-llm";
import { LlmRuntime } from "@deepseek-ai/dsh-llm";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import SessionStore from "@deepseek-ai/dsh-session";
import JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SystemPrompt, { TOOL_ORDER_REST } from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";

import { REVIEW_TOOL_ORDER } from "../../../../src/tools/registry.js";
import type { ConfigId } from "../../../../src/contracts/config.js";
import { reviewCache } from "../plugins/review-cache.js";
import { reviewContext } from "../plugins/review-context.js";
import { reviewEvidence } from "../plugins/review-evidence.js";
import { reviewPolicy, REAL_LLM_TURN_TIMEOUT_MS, type ReviewPolicyConfig } from "../plugins/review-policy.js";
import { reviewRuntime } from "../plugins/review-runtime.js";
import { DeepSeekLlmAdapter } from "../llm/deepseek-adapter.js";
import { REVIEW_PRESETS } from "../presets/review-presets.js";

/**
 * 生产/冒烟组装的政策面：preset 语义 + 真实 API 级 turn 预算（kernel-host 与
 * CLI wrapper 共用——两处都承载真实适配器，thinking 单 turn 分钟级，缺省 10s
 * 只对进程内 fake 成立；#29 冒烟回归）。
 */
export function realApiReviewPolicy(configId: ConfigId): ReviewPolicyConfig {
  return { ...REVIEW_PRESETS[configId], turnTimeoutMs: REAL_LLM_TURN_TIMEOUT_MS };
}

export interface AssembleReviewProfileOptions {
  /** jsonl 会话持久化根目录（调用方持有目录生命周期） */
  readonly sessionRoot: string;
  /** 注册于 ctx.llm seam 的适配器（测试为 FakeLlmAdapter；生产为 DeepSeek LlmAdapter） */
  readonly adapter: LlmAdapter;
  /** 适配器承接的 provider 路由（默认 ["deepseek"]，config A 模型路由） */
  readonly providers?: readonly string[];
  /** cmdline 行的内层 argv（进程内默认空） */
  readonly args?: readonly string[];
  /** review-policy 插件 config 转发（政策可调面，如 turnTimeoutMs；缺省全默认） */
  readonly policy?: ReviewPolicyConfig;
}

/** 组装句柄：拆卸 + 宿主侧观测 */
export interface ReviewProfileHandle {
  /** 组装所用的 context（服务已全部挂载） */
  readonly ctx: Context;
  /** 拆除整棵树（根 fiber dispose；幂等性由调用方保证——只调一次） */
  readonly dispose: () => Promise<void>;
  /** appExit 是否被请求过（进程内应为 null；cmdline 面落地时由 CLI wrapper 消费） */
  readonly requestedExitCode: () => number | null;
}

/**
 * 组装 review profile 显式最小树。
 * 行集与顺序的声明记录见 rows.ts（REVIEW_PROFILE_ROWS）；此处是可执行挂载
 * （各行带自身 config，cmdline 行走 provideCmdline 而非 ctx.plugin）——两处需人工保持一致。
 */
export async function assembleReviewProfile(
  ctx: Context,
  options: AssembleReviewProfileOptions,
): Promise<ReviewProfileHandle> {
  // cmdline 行：宿主在树挂载前供 cmdlineArgs / appExit（provideCmdline 契约）
  let exitCode: number | null = null;
  provideCmdline(ctx, {
    args: [...(options.args ?? [])],
    exit: (code) => {
      exitCode = code;
    },
  });

  // DSH npm 行（依赖序）
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(JsonlSessionPersistence, { root: options.sessionRoot, compression: "none" });
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SystemPrompt, {
    // Zone A 字节纪律：complete section 即全部 prompt，无 harness 身份与运行时上下文
    includeHarnessIdentity: false,
    includeRuntimeContext: false,
    // 工具顺序 = POC1 REVIEW_TOOL_ORDER（get_symbol 先于 get_file，非字典序）；
    // 名单校验依赖 review-context 的 knownNames 声明（config A 零注册不 fail）
    toolOrder: [...REVIEW_TOOL_ORDER, TOOL_ORDER_REST],
  });
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(AgentLoop, { agents: [] });

  // 核内插件胚胎（review-policy 收政策覆盖；review-cache 挂上 DeepSeek 适配器的
  // wire 字节日志——序列化点捕获的请求原文按调用序并入审计 requests；fake 缺席）
  await ctx.plugin(reviewPolicy, options.policy ?? {});
  await ctx.plugin(reviewContext);
  await ctx.plugin(reviewCache, {
    ...(options.adapter instanceof DeepSeekLlmAdapter ? { wireLog: options.adapter.wireLog } : {}),
  });
  await ctx.plugin(reviewEvidence);
  await ctx.plugin(reviewRuntime);

  // ctx.llm seam：适配器注册（deepseek 路由）
  ctx.llm.registerAdapter([...(options.providers ?? ["deepseek"])], options.adapter);

  return {
    ctx,
    dispose: () => ctx.fiber.dispose(),
    requestedExitCode: () => exitCode,
  };
}
