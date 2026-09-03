/**
 * 可编程 FakeJudgeClient（judge client 边界的测试替身，镜像 src/fake/fake-llm-client.ts 模式）。
 * - 脚本化裁定序列：按调用顺序消费 steps；
 * - 捕获收到的每个 JudgeRequest（结构化深拷贝，隔离被测代码的后续变更）；
 * - 错误注入：fail（异常，驱动 judge 链的有界失败分支）；
 * - 脚本耗尽：抛 JudgeScriptExhaustedError（显式失败，不静默回退）。
 */

import type { JudgeAdjudication, JudgeRequest } from "./contracts.js";

export type FakeJudgeScriptStep =
  | { readonly kind: "reply"; readonly adjudication: JudgeAdjudication }
  | { readonly kind: "fail"; readonly error: Error };

export class JudgeScriptExhaustedError extends Error {
  constructor(callIndex: number) {
    super(`fake judge script exhausted after ${callIndex} call(s); script more steps`);
    this.name = "JudgeScriptExhaustedError";
  }
}

export class FakeJudgeClient {
  private readonly steps: readonly FakeJudgeScriptStep[];
  private readonly captured: JudgeRequest[] = [];
  private nextIndex = 0;

  constructor(steps: readonly FakeJudgeScriptStep[]) {
    this.steps = [...steps];
  }

  /** 便捷构造：纯裁定序列 */
  static fromAdjudications(adjudications: readonly JudgeAdjudication[]): FakeJudgeClient {
    return new FakeJudgeClient(adjudications.map((adjudication) => ({ kind: "reply", adjudication })));
  }

  async adjudicate(request: JudgeRequest): Promise<JudgeAdjudication> {
    this.captured.push(structuredClone(request));
    const index = this.nextIndex;
    this.nextIndex++;
    const step = this.steps[index];
    if (step === undefined) {
      throw new JudgeScriptExhaustedError(index);
    }
    if (step.kind === "fail") {
      throw step.error;
    }
    return structuredClone(step.adjudication);
  }

  /** 收到的每个请求（按序；每次返回防御性拷贝） */
  get capturedRequests(): readonly JudgeRequest[] {
    return structuredClone(this.captured);
  }

  get callCount(): number {
    return this.captured.length;
  }
}
