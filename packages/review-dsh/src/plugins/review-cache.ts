/**
 * review-cache：核内缓存纪律插件——模型请求的 kernel 侧观测。
 *
 * 经 llm/stream waterfall 快照每次模型调用的完整请求（model、effort、
 * system 前缀、messages、tools），供审计 requests 序列化与「同单元两次
 * 运行前缀逐字节相等」断言消费（cache-break 观测随缓存纪律票扩展）。
 */

import type { Context, Plugin } from "@deepseek-ai/cordis";
import type { GenerateOptions, Message, StreamChunk, ToolSchema } from "@deepseek-ai/dsh-llm";

/** 一次模型调用的 kernel 侧快照（防御性深拷贝，detached） */
export interface CapturedKernelRequest {
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly system?: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolSchema[];
}

/** reviewCache 服务：缓存纪律观测面 */
export interface ReviewCacheService {
  /** 按调用序捕获的完整请求快照（每次读取返回新副本） */
  readonly requests: readonly CapturedKernelRequest[];
  /** 每次调用的 Zone A 前缀快照（= requests[i].system ?? ""） */
  readonly zoneSnapshots: readonly string[];
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    reviewCache: ReviewCacheService;
  }
}

/** review-cache 插件：llm/stream 观测 + 请求快照服务 */
export const reviewCache: Plugin.Object = {
  name: "review-cache",
  inject: ["llm"],
  apply(ctx: Context) {
    const captured: CapturedKernelRequest[] = [];
    ctx.on("llm/stream", (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
      captured.push({
        model: options.model,
        ...("reasoningEffort" in options && options.reasoningEffort !== undefined
          ? { reasoningEffort: options.reasoningEffort }
          : {}),
        ...(options.system !== undefined ? { system: options.system } : {}),
        messages: structuredClone(options.messages),
        tools: structuredClone(options.tools ?? []),
      });
      return next();
    });

    const service: ReviewCacheService = {
      get requests(): readonly CapturedKernelRequest[] {
        return captured.map((request) => structuredClone(request));
      },
      get zoneSnapshots(): readonly string[] {
        return captured.map((request) => request.system ?? "");
      },
    };
    return ctx.provide("reviewCache", service);
  },
};
