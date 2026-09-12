import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LlmResponse } from "../../src/contracts/llm-client.js";
import type { MRCase } from "../../src/contracts/mr-case.js";
import type { RunResult } from "../../src/contracts/run.js";
import type { JudgeAdjudication } from "../../src/judge/contracts.js";
import { FakeLlmClient } from "../../src/fake/fake-llm-client.js";
import type { ExperimentPlan, VerifierMode } from "../../src/experiment/plan.js";
import { RunStore, toRunSnapshot } from "../../src/experiment/run-store.js";
import type { RunRecord } from "../../src/experiment/run-store.js";
import { makeFinding } from "../metrics/helpers.js";
import { HAPPY_PATH_RESPONSES } from "../helpers/happy-path-script.js";
import { reply, usage } from "../helpers/llm-script.js";
import { SAMPLE_MR_CASE } from "../fixtures/sample-mr-case.js";

/**
 * 实验模块测试夹具：MRCase 工厂（labels.source 取实验词表）、
 * 脚本化 LLM（六阶段 × units，含 Verifier 追加调用）、judge 裁定、计划工厂、
 * 对齐门 run 目录工厂（RunRecord + RunStore round-trip）。
 * 零网络零真实 LLM：全部经 FakeLlmClient / FakeJudgeClient。
 */

/** 主集 case（truth ≠ null；源默认 defects4j，可覆盖 labels） */
export function experimentMainCase(
  caseId = "exp-main-001",
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
export function experimentCleanCase(
  caseId = "exp-clean-001",
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

/** Verifier 追加回复（每次复核一条 Finding：pass 可控） */
export function verifierReply(pass = true): LlmResponse {
  return reply(
    JSON.stringify({
      verdicts: [
        {
          id: "F001",
          pass,
          reason: pass ? "The diff excerpt directly supports the finding." : "No concrete support in the diff.",
        },
      ],
      complete: true,
    }),
    usage(50, 5),
  );
}

/**
 * 脚本化 LLM 客户端：六阶段快乐路径 × units 次；
 * verifier = "on" 时每单元追加一次 Verifier 调用回复（pass 可控）。
 */
export function scriptedLlmClient(
  units: number,
  verifier: VerifierMode = "off",
  options: { readonly verifierPass?: boolean } = {},
): FakeLlmClient {
  const perUnit: LlmResponse[] =
    verifier === "on"
      ? [...HAPPY_PATH_RESPONSES, verifierReply(options.verifierPass ?? true)]
      : [...HAPPY_PATH_RESPONSES];
  const responses = Array.from({ length: units }, () => perUnit).flat();
  return FakeLlmClient.fromResponses(responses);
}

/** judge 裁定：第 1 条 Finding 命中第 1 条真值（high 置信） */
export function judgeAdjudication(): JudgeAdjudication {
  return {
    matches: [
      {
        findingIndex: 0,
        truthIndex: 0,
        matchConfidence: "high",
        matchReason: "Both describe the same off-by-one loop bound defect.",
      },
    ],
    summary: "1 match, 0 unmatched truths",
  };
}

/** 缺省计划（子集/限量/消融字段全覆盖缺省；overrides 局部替换） */
export function experimentPlan(overrides: Partial<ExperimentPlan> = {}): ExperimentPlan {
  return {
    experimentId: "test-experiment",
    sources: ["defects4j", "vul4j", "msb-java", "clean-mr"],
    configs: ["A"],
    reps: 1,
    verifier: "off",
    model: "deepseek-v4-flash",
    highRiskOnly: false,
    perSourceLimit: null,
    caseFilter: [],
    judge: false,
    judgeModel: null,
    humanReviewRate: 0.1,
    humanReviewSeed: "test-seed-2026",
    ...overrides,
  };
}

/** 对齐门测试用 RunResult（单 finding 命中真值；usage/审计零事件；可整体覆盖） */
export function gateRunResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    caseId: "c1",
    configId: "C",
    findings: [makeFinding()],
    usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500 },
    rounds: 1,
    toolCalls: 0,
    audit: {
      requests: [],
      toolCallLog: [],
      phaseLog: [],
      rejections: [],
      cacheBreaks: [],
      truncated: false,
      truncationReasons: [],
    },
    ...overrides,
  };
}

/** 对齐门测试用 RunRecord（baseline = gateRunResult 快照；effective/rep 等可覆盖） */
export function gateRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    source: "vul4j",
    caseId: "c1",
    configId: "C",
    rep: 1,
    model: "deepseek-v4-flash",
    verifier: "off",
    completedAt: "2026-09-08T22:11:00.000Z",
    baseline: toRunSnapshot(gateRunResult()),
    effective: null,
    verifierPass: null,
    ...overrides,
  };
}

/** 造一个对齐门侧 run 目录：cases.json + runs/ 记录树（记录经 RunStore.save 落盘） */
export async function makeGateRunDir(
  workDir: string,
  name: string,
  cases: readonly MRCase[],
  records: readonly RunRecord[],
): Promise<string> {
  const runDir = path.join(workDir, name);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "cases.json"), JSON.stringify(cases), "utf8");
  const store = new RunStore(path.join(runDir, "runs"));
  for (const entry of records) {
    await store.save(entry);
  }
  return runDir;
}
