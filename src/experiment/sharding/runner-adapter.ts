import { join } from "node:path";

import type { ConfigId } from "../../contracts/config.js";
import type { RunResult } from "../../contracts/run.js";
import type { SingleMrRun, SingleMrRunner } from "../../sharding/orchestrate-review.js";

/**
 * 实验侧运行器适配（spec #48 实现决策 12，ticket #57）：把实验单元执行面
 * （DshKernelDriver.runUnit 与 POC1 runReview 的公共形状）适配为编排层的
 * SingleMrRunner——验证 harness 与生产 CLI 走同一编排函数（用户故事 18），
 * 验证结论直接对生产形态生效。
 *
 * 适配器只做形状转换，不增删检视语义：
 * - 请求面：configId / model / issueDescription / diff / repoPath 直传；
 *   auditDir 按（编排内唯一的）单元 caseId 派生——分片单元的 caseId 即
 *   分片 id（`<compositeId>#shard-NNN`），直通单元为合成 caseId，天然互异；
 * - 产出面：findings / usage 零拷贝透传。runId 取单元 caseId——实验侧单元
 *   无内核 runId（POC1 RunAudit 不携带），caseId 是该单元在编排与落盘记录
 *   间的唯一关联键。
 */

/** 实验侧单元执行请求（与 DshKernelUnitRequest 同面的最小形状） */
export interface ExperimentUnitRequest {
  readonly configId: ConfigId;
  readonly caseId: string;
  readonly issueDescription: string;
  readonly diff: string;
  readonly repoPath?: string;
  readonly auditDir: string;
  readonly model: string;
}

/** 实验侧单元执行面：DSH 内核驱动 / POC1 runReview 由调用方注入（测试用 fake） */
export type ExperimentUnitExecutor = (request: ExperimentUnitRequest) => Promise<RunResult>;

/** 实验侧单元产出：编排层最小产出面 + 运行计数与审计路径（报告分列用） */
export interface ExperimentMrRun extends SingleMrRun {
  readonly rounds: number;
  readonly toolCalls: number;
  readonly auditPath: string;
}

/** 实验侧运行器适配（决策 12）：单元执行面 → SingleMrRunner */
export function experimentSingleMrRunner(params: {
  readonly configId: ConfigId;
  readonly model: string;
  /** 该臂的审计根目录（每单元目录 = auditRoot / sanitize(caseId)） */
  readonly auditRoot: string;
  readonly executeUnit: ExperimentUnitExecutor;
}): SingleMrRunner<ExperimentMrRun> {
  return {
    run: async (mrCase) => {
      const result = await params.executeUnit({
        configId: params.configId,
        caseId: mrCase.caseId,
        issueDescription: mrCase.issueDescription,
        diff: mrCase.diff,
        ...(mrCase.repoPath !== undefined ? { repoPath: mrCase.repoPath } : {}),
        auditDir: join(params.auditRoot, sanitize(mrCase.caseId)),
        model: params.model,
      });
      return {
        findings: result.findings,
        usage: result.usage,
        runId: result.caseId,
        rounds: result.rounds,
        toolCalls: result.toolCalls,
        auditPath: result.auditPath ?? "",
      };
    },
  };
}

/** caseId → 目录段（与实验 runner 落盘路径同款纪律：非安全字符替换为 _） */
function sanitize(caseId: string): string {
  return caseId.replace(/[^A-Za-z0-9_.-]/g, "_");
}
