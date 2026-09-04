import type { MRCase } from "../contracts/mr-case.js";
import type { ConfigId } from "../contracts/config.js";
import { type DefectRecord, validateDefectRecord } from "./defect-record.js";
import { type Result, DatasetError, err, ok } from "./diff/types.js";
import { reverseUnifiedDiff } from "./diff/reverse-unified-diff.js";
import { buildTruthLocations } from "./truth.js";
import { DEFAULT_RISK_CLASS, type RiskClass } from "./risk-class.js";

export const ALL_CONFIGS: readonly ConfigId[] = ["A", "B", "C", "D", "E"];
const DEFAULT_SOURCE = "defects4j";

/** 转换选项：仓库路径必需（MRCase.repoPath 指向修复后版本的本地 git 仓库） */
export interface ConvertOptions {
  readonly repoPath: string;
  readonly source?: string;
  readonly riskClass?: RiskClass;
  readonly allowedConfigs?: readonly ConfigId[];
}

/**
 * 逆补丁法 MR 构造器（Ticket 02 核心纯函数）：
 * defectRecord → MRCase。
 *
 * - base（repoPath）= 修复后版本仓库；
 * - MR diff = 最小修复补丁的逆 diff（合入后即历史真实 buggy 版本，非合成篡改）；
 * - truth = 最小修复补丁的行位与性质（buggy 坐标系，见 truth.ts）+ issue 描述。
 *
 * 纯函数：不落盘、不联网、不经过 LLM；输入校验失败显式返回错误。
 */
export function convertDefectRecord(
  record: DefectRecord,
  options: ConvertOptions,
): Result<MRCase> {
  if (options === undefined || typeof options.repoPath !== "string" || options.repoPath.trim() === "") {
    return err(new DatasetError("INVALID_OPTIONS", "repoPath 必须为非空字符串"));
  }
  const validated = validateDefectRecord(record);
  if (!validated.ok) {
    return validated;
  }
  const reversed = reverseUnifiedDiff(record.fixPatch);
  if (!reversed.ok) {
    return err(new DatasetError("REVERSE_FAILED", `逆 diff 生成失败: ${reversed.error.message}`));
  }
  const truthLocations = buildTruthLocations(record.fixPatch, record.defectNatures);
  if (!truthLocations.ok) {
    return truthLocations;
  }
  return ok({
    caseId: record.recordId,
    repoPath: options.repoPath,
    diff: reversed.value,
    issueDescription: record.issueDescription ?? "",
    truth: {
      locations: truthLocations.value,
      fixPatch: record.fixPatch,
    },
    labels: {
      source: options.source ?? record.source ?? DEFAULT_SOURCE,
      riskClass: options.riskClass ?? record.riskClass ?? DEFAULT_RISK_CLASS,
      allowedConfigs: options.allowedConfigs ?? record.allowedConfigs ?? ALL_CONFIGS,
    },
  });
}

/** 批量转换：逐条校验与转换，失败项显式收集（不静默跳过） */
export function convertDefectRecords(
  records: readonly DefectRecord[],
  repoPathOf: (recordId: string) => string,
  labelOverrides: Omit<ConvertOptions, "repoPath"> = {},
): { readonly cases: readonly MRCase[]; readonly failures: readonly ConversionFailure[] } {
  const cases: MRCase[] = [];
  const failures: ConversionFailure[] = [];
  for (const record of records) {
    const converted = convertDefectRecord(record, { ...labelOverrides, repoPath: repoPathOf(record.recordId) });
    if (converted.ok) {
      cases.push(converted.value);
    } else {
      failures.push({ recordId: record.recordId, code: converted.error.code, message: converted.error.message });
    }
  }
  return { cases, failures };
}

export interface ConversionFailure {
  readonly recordId: string;
  readonly code: string;
  readonly message: string;
}
