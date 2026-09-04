import type { LlmRequest, LlmResponse } from "../contracts/llm-client.js";

/**
 * 可编程 FakeLlmClient（主 seam 的测试替身）。
 * - 脚本化回复序列：按调用顺序消费 steps
 * - 捕获收到的每个 LlmRequest（结构化深拷贝，隔离被测代码的后续变更）
 * - 错误注入：fail（异常）/ delay（超时模拟）
 * - 脚本耗尽：抛 LlmScriptExhaustedError（显式失败，不静默回退）
 */

export type FakeLlmScriptStep =
  | { readonly kind: "reply"; readonly response: LlmResponse }
  | { readonly kind: "fail"; readonly error: Error }
  | { readonly kind: "delay"; readonly ms: number; readonly then: FakeLlmScriptStep };

export class LlmScriptExhaustedError extends Error {
  constructor(callIndex: number) {
    super(`fake LLM script exhausted after ${callIndex} call(s); script more steps or set a fallback`);
    this.name = "LlmScriptExhaustedError";
  }
}

export interface FakeLlmOptions {
  /** 脚本耗尽后的兜底步（如 "永不完成" 的回复），驱动上界截断测试 */
  readonly fallback?: FakeLlmScriptStep;
}

export class FakeLlmClient {
  private readonly steps: readonly FakeLlmScriptStep[];
  private readonly fallback: FakeLlmScriptStep | undefined;
  private readonly captured: LlmRequest[] = [];
  private nextIndex = 0;

  constructor(steps: readonly FakeLlmScriptStep[], options: FakeLlmOptions = {}) {
    this.steps = [...steps];
    this.fallback = options.fallback;
  }

  /** 便捷构造：纯回复序列 */
  static fromResponses(responses: readonly LlmResponse[], options: FakeLlmOptions = {}): FakeLlmClient {
    return new FakeLlmClient(responses.map((response) => ({ kind: "reply", response })), options);
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.captured.push(structuredClone(request));
    const index = this.nextIndex;
    this.nextIndex++;
    const step = index < this.steps.length ? this.steps[index] : this.fallback;
    if (step === undefined) {
      throw new LlmScriptExhaustedError(index);
    }
    return this.resolve(step);
  }

  /** 收到的每个请求（按序；每次返回防御性拷贝） */
  get capturedRequests(): readonly LlmRequest[] {
    return structuredClone(this.captured);
  }

  get callCount(): number {
    return this.captured.length;
  }

  private async resolve(step: FakeLlmScriptStep): Promise<LlmResponse> {
    if (step.kind === "reply") {
      return step.response;
    }
    if (step.kind === "fail") {
      throw step.error;
    }
    await sleep(step.ms);
    return this.resolve(step.then);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
