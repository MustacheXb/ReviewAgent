import type { Finding } from "../contracts/finding.js";
import type { LlmUsage } from "../contracts/llm-client.js";

/**
 * 外部参照契约（Ticket 13 / issue #14）：Claude Code 跨模型外部参照的 seam 与留痕类型。
 *
 * 定位（spec #1 user story 30）：同仓、同 diff、同目标在 Claude Code 上跑检视，
 * 模型不可同源（Claude Code 锁定 Claude 系），单列报告、不进 S/A/B 主判定；
 * 归一化后的 Finding 经 REFERENCE_CONFIG_ID 走同一 metrics 管线评分。
 *
 * seam 纪律（测试零网络零真实 claude 调用）：「调 claude CLI」全部收敛到
 * ClaudeCodeClient 接口——单元测试注入 fake（脚本化返回合法/非法/失败输出），
 * 真实实现（ClaudeCodeCliClient）仅在 e2e 冒烟（环境变量门控）中触达。
 */

/** 一次无头检视调用（prompt 经 stdin 注入；cwd = 被检仓库 = 同仓） */
export interface ClaudeCodeRunInput {
  /** 完整提示词（buildClaudeCodePrompt 的产物；diff + issue 描述 + 输出格式要求） */
  readonly prompt: string;
  /** 子进程工作目录 = 被检视仓库（同仓约束） */
  readonly cwd: string;
  /** 请求的 Claude 系模型 id（锁定并留档；实际模型以 CLI 回报为准） */
  readonly model: string;
  /** 轮数上界（--max-turns；成本有界纪律） */
  readonly maxTurns: number;
}

/** 一次调用的原始产物（stdout 原文 = --output-format json 的 JSON；解析归 normalize.ts） */
export interface ClaudeCodeRunOutput {
  readonly stdout: string;
  readonly stderr: string;
  /** 退出码；null = 进程被杀死（超时/信号），视同失败 */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

/** 外部参照 seam：唯一允许触达 claude CLI 的入口 */
export interface ClaudeCodeClient {
  run(input: ClaudeCodeRunInput): Promise<ClaudeCodeRunOutput>;
  /** `claude --version` 采集（进程内缓存一次；随运行留档，支撑可复现性） */
  version(): Promise<string>;
}

/**
 * 归一化拦截阶段（RejectionStage 风格：有界失败留痕，不整单报废）。
 * 拦截的是候选 Finding / 原始输出中的非法部分；合法部分照常进入指标管线。
 */
export type ReferenceRejectionStage =
  /** stdout 非法 JSON / 无 result 文本（含 max-turns 截断导致空回复）：usage 仍留痕 */
  | "CLI_OUTPUT_UNPARSABLE"
  /** result 文本中找不到合法的 findings 载荷（{"findings": [...]} 或裸数组） */
  | "FINDINGS_FIELD_INVALID"
  /** 单条候选 Finding 形状非法（validateFinding 报错）→ 丢弃该条留痕 */
  | "ENTRY_SCHEMA_INVALID"
  /** id 与更早条目重复 → 丢弃该条留痕（与主 harness DUPLICATE_ID 同口径） */
  | "DUPLICATE_ID";

/** 一条归一化拦截的留痕 */
export interface ReferenceRejection {
  /** 候选条目下标（CLI_OUTPUT_UNPARSABLE / FINDINGS_FIELD_INVALID 为 null） */
  readonly candidateIndex: number | null;
  readonly stage: ReferenceRejectionStage;
  readonly reason: string;
}

/** 归一化结果：合法 Finding + 拦截留痕（二者可同时非空 = 部分非法） */
export interface NormalizedFindings {
  readonly findings: readonly Finding[];
  readonly rejections: readonly ReferenceRejection[];
}
