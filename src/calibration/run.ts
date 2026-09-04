/**
 * 校准运行器：样本 × JudgeClient → 与官方判定的一致性报告。
 *
 * 有界失败纪律：
 * - 单样本 judge 失败不中断整体——记入 errors（默认截留前 20 条明细），
 *   该样本按官方脚本的错误兜底口径计 tp=0 / fp=全部模型缺陷 / fn=全部真值，
 *   但【不参与】一致性混淆矩阵与 kappa（无我方判定，无从比较）；
 * - 逐样本顺序执行（与官方脚本一致，天然限速、确定性顺序）。
 *
 * 阈值默认 "none"：复现官方 llm_evaluator.py 的宽松计分口径
 * （凡 truth 索引非 null 即命中），保证对照可比；可显式收紧。
 */

import type { JudgeClient, MatchConfidenceThreshold } from "../judge/contracts.js";
import { resolveAdjudication } from "../judge/resolve.js";
import type { CalibrationSample } from "./mcr-bench.js";
import {
  addConfusion,
  agreementMetrics,
  EMPTY_PAIR_CONFUSION,
  judgeMatchedPairs,
  officialMatchedPairs,
  pairConfusionForSample,
  pairsExactlyMatch,
  type PairConfusion,
} from "./agreement.js";

/** 单样本校准结果 */
export interface CalibrationSampleResult {
  readonly taskId: string;
  readonly modelName: string;
  readonly status: "compared" | "error";
  /** 我方占用解析后的 tp/fp/fn（error 样本 = 官方兜底口径 0/全部/全部） */
  readonly judgeTp: number;
  readonly judgeFp: number;
  readonly judgeFn: number;
  /** 官方判定计数（官方文件缺失字段时为 null） */
  readonly officialTp: number | null;
  readonly officialFp: number | null;
  readonly officialFn: number | null;
  /** 命中对集合完全一致（最严口径；error 样本为 false） */
  readonly exactPairMatch: boolean;
  /** 候选对混淆（error 样本为全零） */
  readonly confusion: PairConfusion;
  /** 占用解析留下的有界失败痕迹 */
  readonly anomalies: readonly string[];
  /** status = "error" 时的失败摘要（不含 API key 等敏感信息） */
  readonly errorMessage: string | null;
}

/** 分模型聚合 */
export interface CalibrationModelReport {
  readonly modelName: string;
  readonly sampleCount: number;
  readonly errorCount: number;
  readonly confusion: PairConfusion;
  readonly agreementRate: number | null;
  readonly kappa: number | null;
  readonly exactPairMatchCount: number;
}

export interface CalibrationReport {
  readonly sampleCount: number;
  readonly comparedCount: number;
  readonly errorCount: number;
  readonly confusion: PairConfusion;
  readonly agreementRate: number | null;
  readonly kappa: number | null;
  readonly exactPairMatchCount: number;
  readonly perModel: readonly CalibrationModelReport[];
  readonly perSample: readonly CalibrationSampleResult[];
  /** 有界截留的错误明细（超出 cap 的只计数不留痕） */
  readonly errors: readonly { readonly taskId: string; readonly modelName: string; readonly message: string }[];
}

export interface CalibrationRunOptions {
  /** 置信度门槛；缺省 "none" = 官方宽松口径（凡 truth 索引非 null 即命中），保证对照可比 */
  readonly matchConfidenceThreshold?: MatchConfidenceThreshold;
  /** 错误明细截留上限（默认 20；错误总数仍在 errorCount） */
  readonly maxErrorEntries?: number;
}

const DEFAULT_MAX_ERROR_ENTRIES = 20;
const CALIBRATION_DEFAULT_THRESHOLD: MatchConfidenceThreshold = "none";

export async function runCalibration(
  samples: readonly CalibrationSample[],
  judgeClient: JudgeClient,
  options: CalibrationRunOptions = {},
): Promise<CalibrationReport> {
  validateSamples(samples);
  const maxErrorEntries = options.maxErrorEntries ?? DEFAULT_MAX_ERROR_ENTRIES;
  const threshold = options.matchConfidenceThreshold ?? CALIBRATION_DEFAULT_THRESHOLD;
  const perSample: CalibrationSampleResult[] = [];
  const errors: { taskId: string; modelName: string; message: string }[] = [];
  for (const sample of samples) {
    const result = await calibrateSample(sample, judgeClient, threshold);
    perSample.push(result);
    if (result.status === "error" && errors.length < maxErrorEntries) {
      errors.push({
        taskId: sample.taskId,
        modelName: sample.modelName,
        message: result.errorMessage ?? "unknown error",
      });
    }
  }
  return buildReport(samples.length, perSample, errors);
}

async function calibrateSample(
  sample: CalibrationSample,
  judgeClient: JudgeClient,
  threshold: MatchConfidenceThreshold,
): Promise<CalibrationSampleResult> {
  const officialTp = sample.official.tp;
  const officialFp = sample.official.fp;
  const officialFn = sample.official.fn;
  const base = {
    taskId: sample.taskId,
    modelName: sample.modelName,
    officialTp,
    officialFp,
    officialFn,
  };
  try {
    const adjudication = await judgeClient.adjudicate(sample.request);
    const resolved = resolveAdjudication(
      adjudication,
      sample.request.findings.length,
      sample.request.truths.length,
      threshold,
    );
    const officialPairs = officialMatchedPairs(
      sample.request.findings.length,
      sample.request.truths.length,
      sample.official.matches,
    );
    const judgePairs = judgeMatchedPairs(resolved.matches);
    const tp = resolved.matches.length;
    return {
      ...base,
      status: "compared",
      judgeTp: tp,
      judgeFp: sample.request.findings.length - tp,
      judgeFn: sample.request.truths.length - tp,
      exactPairMatch: pairsExactlyMatch(officialPairs, judgePairs),
      confusion: pairConfusionForSample({
        findingCount: sample.request.findings.length,
        truthCount: sample.request.truths.length,
        officialPairs,
        judgePairs,
      }),
      anomalies: [...resolved.anomalies],
      errorMessage: null,
    };
  } catch (error) {
    // 有界失败：官方脚本错误兜底口径 tp=0 / fp=全部 / fn=全部；不参与一致性统计
    return {
      ...base,
      status: "error",
      judgeTp: 0,
      judgeFp: sample.request.findings.length,
      judgeFn: sample.request.truths.length,
      exactPairMatch: false,
      confusion: EMPTY_PAIR_CONFUSION,
      anomalies: [],
      errorMessage: errorMessage(error),
    };
  }
}

function buildReport(
  sampleCount: number,
  perSample: readonly CalibrationSampleResult[],
  errors: CalibrationReport["errors"],
): CalibrationReport {
  const compared = perSample.filter((result) => result.status === "compared");
  const confusion = compared.reduce<PairConfusion>(
    (acc, result) => addConfusion(acc, result.confusion),
    EMPTY_PAIR_CONFUSION,
  );
  const metrics = agreementMetrics(confusion);
  return {
    sampleCount,
    comparedCount: compared.length,
    errorCount: sampleCount - compared.length,
    confusion,
    agreementRate: metrics.agreementRate,
    kappa: metrics.kappa,
    exactPairMatchCount: compared.filter((result) => result.exactPairMatch).length,
    perModel: perModelReports(perSample),
    perSample,
    errors,
  };
}

function perModelReports(
  perSample: readonly CalibrationSampleResult[],
): readonly CalibrationModelReport[] {
  const byModel = new Map<string, CalibrationSampleResult[]>();
  for (const result of perSample) {
    const bucket = byModel.get(result.modelName) ?? [];
    bucket.push(result);
    byModel.set(result.modelName, bucket);
  }
  return [...byModel.entries()].map(([modelName, results]) =>
    modelReport(modelName, results),
  );
}

function modelReport(
  modelName: string,
  results: readonly CalibrationSampleResult[],
): CalibrationModelReport {
  const compared = results.filter((result) => result.status === "compared");
  const confusion = compared.reduce<PairConfusion>(
    (acc, result) => addConfusion(acc, result.confusion),
    EMPTY_PAIR_CONFUSION,
  );
  const metrics = agreementMetrics(confusion);
  return {
    modelName,
    sampleCount: results.length,
    errorCount: results.length - compared.length,
    confusion,
    agreementRate: metrics.agreementRate,
    kappa: metrics.kappa,
    exactPairMatchCount: compared.filter((result) => result.exactPairMatch).length,
  };
}

function validateSamples(samples: readonly CalibrationSample[]): void {
  if (!Array.isArray(samples)) {
    throw new Error("samples must be an array of CalibrationSample");
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
