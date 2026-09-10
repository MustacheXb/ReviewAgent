/**
 * FakeLlmAdapter：注册于 ctx.llm 同一 seam 的可脚本化 fake（POC1 FakeLlmClient 的 DSH 形态）。
 *
 * 语义 1:1 对齐薄 harness：脚本步按序消耗、请求深拷贝捕获、耗尽显式报错、
 * fail 步以 error finish 收尾；回复按 DSH StreamChunk 块协议产出
 * （block-start → delta → block-end → [usage] → finish，finish 后不再发块）。
 */

import {
  LlmAdapter,
  ReasoningEffortId,
  ToolCallId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
  type TokenUsage,
} from "@deepseek-ai/dsh-llm";

/** 一次脚本化回复：文本、工具调用与 usage 计量 */
export interface FakeReply {
  readonly kind: "reply";
  readonly content: string;
  readonly toolCalls?: readonly { readonly id: string; readonly name: string; readonly arguments: string }[];
  readonly usage?: TokenUsage;
}

/** fail 步：以 error finish 结束本次调用 */
export interface FakeFailStep {
  readonly kind: "fail";
  readonly message: string;
}

export type FakeLlmScriptStep = FakeReply | FakeFailStep;

export class LlmScriptExhaustedError extends Error {
  constructor(callCount: number) {
    super(`fake LLM script exhausted after ${callCount} call(s); provide a fallback step or extend the script`);
    this.name = "LlmScriptExhaustedError";
  }
}

/** 请求捕获（主 seam 的观测对象）：深冻结请求的 detached 快照 */
export type CapturedRequest = Readonly<GenerateOptions>;

export interface FakeLlmOptions {
  /** 脚本耗尽后的兜底步（如"永不完成"的回复），驱动上界截断测试 */
  readonly fallback?: FakeLlmScriptStep;
}

export class FakeLlmAdapter extends LlmAdapter {
  private readonly script: readonly FakeLlmScriptStep[];
  private readonly options: FakeLlmOptions;
  private readonly captured: GenerateOptions[] = [];
  private nextStep = 0;

  constructor(script: readonly FakeLlmScriptStep[], options: FakeLlmOptions = {}) {
    super();
    this.script = script;
    this.options = options;
  }

  /** 已发生的模型调用次数（= 已捕获请求数） */
  get callCount(): number {
    return this.captured.length;
  }

  /** 捕获的请求快照（防御性深拷贝，每次读取返回新副本） */
  get capturedRequests(): readonly CapturedRequest[] {
    return this.captured.map((request) => structuredClone(request));
  }

  override providerInfo(provider: string) {
    return { id: provider, name: `Fake (${provider})` };
  }

  /** fake 路由能力面：受理任何模型，声明 default effort（prepareCall 的 effort 校验依据） */
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
    this.captured.push(structuredClone(options));
    const step = this.consumeStep();
    yield* emitReplyChunks(step);
  }

  private consumeStep(): FakeLlmScriptStep {
    const step = this.script[this.nextStep];
    if (step !== undefined) {
      this.nextStep += 1;
      return step;
    }
    if (this.options.fallback !== undefined) {
      return this.options.fallback;
    }
    throw new LlmScriptExhaustedError(this.captured.length);
  }
}

/** 单个脚本步 → StreamChunk 块流 */
export function* emitReplyChunks(step: FakeLlmScriptStep): Generator<StreamChunk> {
  if (step.kind === "fail") {
    yield {
      type: "finish",
      reason: { kind: "error", failure: { message: step.message, code: "FAKE_LLM_SCRIPT" } },
    };
    return;
  }
  const reply = step;
  let index = 0;
  if (reply.content.length > 0) {
    const block = { type: "text" as const, text: reply.content };
    yield { type: "block-start", index, blockType: "text" };
    yield { type: "text-delta", index, text: reply.content };
    yield { type: "block-end", index, block };
    index += 1;
  }
  for (const call of reply.toolCalls ?? []) {
    const id = ToolCallId(call.id);
    yield { type: "block-start", index, blockType: "tool-call" };
    yield { type: "tool-call-delta", index, id, name: call.name, argumentsDelta: call.arguments };
    yield { type: "block-end", index, block: { type: "tool-call", id, name: call.name, arguments: call.arguments } };
    index += 1;
  }
  const hasToolCalls = (reply.toolCalls ?? []).length > 0;
  if (reply.usage !== undefined) {
    yield { type: "usage", usage: reply.usage };
  }
  yield { type: "finish", reason: hasToolCalls ? { kind: "tool-calls" } : { kind: "stop" } };
}
