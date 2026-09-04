import type { MRCase } from "../../src/contracts/mr-case.js";
import type { ClaudeCodeRunInput, ClaudeCodeRunOutput, ClaudeCodeClient } from "../../src/reference/contracts.js";
import type { ClaudeCodeReferencePlan } from "../../src/reference/plan.js";
import { CLAUDE_CODE_PROMPT_TEMPLATE_VERSION } from "../../src/reference/prompt.js";
import { SAMPLE_MR_CASE } from "../fixtures/sample-mr-case.js";

/**
 * 外部参照模块测试夹具（Ticket 13 / issue #14）：
 * MRCase 工厂（labels.source 取参照词表）、脚本化 ClaudeCodeClient、
 * CLI stdout 工厂、计划工厂。零网络零真实 claude 调用。
 */

/** 主集 case（truth ≠ null；源默认 defects4j，可覆盖 labels） */
export function referenceMainCase(
  caseId = "ref-main-001",
  overrides: { readonly labels?: Partial<MRCase["labels"]> } = {},
): MRCase {
  return {
    ...SAMPLE_MR_CASE,
    caseId,
    labels: {
      source: "defects4j",
      riskClass: "Medium",
      allowedConfigs: ["A", "B", "C", "D", "E"],
      ...overrides.labels,
    },
  };
}

/** clean MR 阴性对照 case（truth = null；issueDescription 为空串） */
export function referenceCleanCase(
  caseId = "ref-clean-001",
  overrides: { readonly labels?: Partial<MRCase["labels"]> } = {},
): MRCase {
  return {
    ...SAMPLE_MR_CASE,
    caseId,
    issueDescription: "",
    truth: null,
    labels: {
      source: "clean-mr",
      riskClass: "Low",
      allowedConfigs: ["A", "B", "C", "D", "E"],
      ...overrides.labels,
    },
  };
}

/** 缺省参照计划（overrides 局部替换；promptTemplateVersion 恒为当前模板） */
export function referencePlan(overrides: Partial<ClaudeCodeReferencePlan> = {}): ClaudeCodeReferencePlan {
  return {
    referenceId: "test-reference",
    sources: ["defects4j", "vul4j", "msb-java", "clean-mr"],
    reps: 1,
    model: "sonnet",
    maxTurns: 5,
    promptTemplateVersion: CLAUDE_CODE_PROMPT_TEMPLATE_VERSION,
    perSourceLimit: null,
    caseFilter: [],
    ...overrides,
  };
}

/** 合法 Finding 候选（纯 JSON 对象；overrides 局部替换） */
export function findingJson(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    severity: "P1",
    category: "CORRECTNESS",
    file: "src/main/java/com/example/math/MathUtils.java",
    line: 20,
    title: "Off-by-one loop bound reads values[count]",
    description: "The loop condition 'i <= count' reads values[count], which is out of bounds when count equals values.length.",
    evidence: ["for (int i = 0; i <= count; i++)", "values[i]"],
    rule: "CORRECTNESS-001",
    confidence: 0.9,
    ...overrides,
  };
}

/** claude CLI stdout（--output-format json 的形状；本机 2.1.241 实测契约） */
export function claudeStdout(options: {
  readonly result?: string;
  readonly findings?: readonly Record<string, unknown>[];
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly numTurns?: number;
  readonly totalCostUsd?: number;
  readonly modelUsage?: Record<string, unknown>;
  readonly permissionDenials?: number;
  readonly isError?: boolean;
}): string {
  const result =
    options.result ??
    JSON.stringify({ findings: options.findings === undefined ? [] : [...options.findings] });
  const usage: Record<string, number> = {
    input_tokens: options.inputTokens ?? 1000,
    output_tokens: options.outputTokens ?? 200,
  };
  if (options.cacheReadTokens !== undefined) {
    usage.cache_read_input_tokens = options.cacheReadTokens;
  }
  if (options.cacheWriteTokens !== undefined) {
    usage.cache_creation_input_tokens = options.cacheWriteTokens;
  }
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: options.isError ?? false,
    result,
    num_turns: options.numTurns ?? 3,
    total_cost_usd: options.totalCostUsd ?? 0.05,
    usage,
    modelUsage: options.modelUsage ?? { "claude-sonnet-4-5": { costUSD: 0.05 } },
    permission_denials: options.permissionDenials ?? 0,
  });
}

/** 一次成功 CLI 调用的原始产物 */
export function okRunOutput(stdout: string): ClaudeCodeRunOutput {
  return { stdout, stderr: "", exitCode: 0, timedOut: false };
}

/** 一次失败 CLI 调用的原始产物（退出码非零） */
export function failedRunOutput(
  stderr = "boom",
  exitCode = 1,
): ClaudeCodeRunOutput {
  return { stdout: "", stderr, exitCode, timedOut: false };
}

/** 脚本条目：正常产物，或 run 时抛错（超时/无法启动等 client 层失败） */
export type FakeScriptEntry = ClaudeCodeRunOutput | { readonly failsWith: string };

function isFailureEntry(entry: FakeScriptEntry): entry is { readonly failsWith: string } {
  return typeof entry === "object" && entry !== null && "failsWith" in entry;
}

/**
 * 脚本化 Claude Code 客户端：按调用次序回放脚本（零网络）。
 * 记录全部 run 输入（prompt / cwd / model / maxTurns）供断言；
 * 脚本耗尽即抛错（测试脚本与单元数不匹配时显式失败，不静默通过）。
 */
export class FakeClaudeCodeClient implements ClaudeCodeClient {
  readonly runInputs: ClaudeCodeRunInput[] = [];
  private versionCallsCount = 0;
  private nextIndex = 0;

  get versionCalls(): number {
    return this.versionCallsCount;
  }

  constructor(
    private readonly script: readonly FakeScriptEntry[],
    private readonly versionText = "2.1.241 (fake)",
  ) {}

  static fromOutputs(
    script: readonly FakeScriptEntry[],
    versionText?: string,
  ): FakeClaudeCodeClient {
    return new FakeClaudeCodeClient(script, versionText);
  }

  async run(input: ClaudeCodeRunInput): Promise<ClaudeCodeRunOutput> {
    this.runInputs.push(input);
    const entry = this.script[this.nextIndex];
    this.nextIndex += 1;
    if (entry === undefined) {
      throw new Error(
        `fake claude script exhausted after ${this.runInputs.length} call(s); test script too short`,
      );
    }
    if (isFailureEntry(entry)) {
      throw new Error(entry.failsWith);
    }
    return entry;
  }

  async version(): Promise<string> {
    this.versionCallsCount += 1;
    return this.versionText;
  }
}
