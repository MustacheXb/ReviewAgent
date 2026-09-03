import type { ConfigId } from "../../contracts/config.js";
import type { MRCase } from "../../contracts/mr-case.js";
import { ALL_CONFIGS } from "../inverse-patch.js";
import { DEFAULT_RISK_CLASS, type RiskClass } from "../risk-class.js";
import { type Result, DatasetError, err, ok } from "../diff/types.js";
import { parseUnifiedDiff } from "../diff/parse-unified-diff.js";

/**
 * clean MR → MRCase 构造器（Ticket 09）。
 *
 * 阴性对照口径（spec 用户故事 22 / 工单 #10 验收 2）：
 * - **truth = null**：clean MR 无缺陷真值；判定链（T10）据此进入阴性对照分支，
 *   该 case 上产出的**每条 Finding 计 1 个 False Positive**，无 Recall / Precision
 *   分母（真值位置集为空）——FP 数即全部质量信号；
 * - issueDescription = ""（契约规定 clean MR 为空串，检视无背景提示）；
 * - labels.source = "clean-mr"；allowedConfigs 缺省全部五配置
 *   （A vs C「主动检索是否推高无中生有率」对比 + B/D/E 复用同集）。
 *
 * MRCase.repoPath 由调用方（T12 实验运行器）解析为 PR base 的本地克隆，
 * 清单（manifest.ts）记录 baseSha / mergeCommitSha 供 checkout 复现。
 */

export const CLEAN_MR_SOURCE = "clean-mr";

/** clean MR 的 MRCase 输入（diff 为检视对象本体；来源信息经 manifest 流转） */
export interface CleanMrRecord {
  /** 形如 clean-<org>__<repo>-<number>（见 buildCleanMrCaseId） */
  readonly caseId: string;
  readonly diff: string;
  readonly riskClass?: RiskClass;
  readonly allowedConfigs?: readonly ConfigId[];
}

export interface CleanMrBuildOptions {
  /** PR base 的本地 git 仓库路径（由 T12 按 manifest.baseSha checkout） */
  readonly repoPath: string;
}

/** 构造 clean MR 的确定性 caseId：clean-<org>__<repo>-<number> */
export function buildCleanMrCaseId(org: string, repo: string, number: number): string {
  return `clean-${org}__${repo}-${number}`;
}

const CASE_ID_RE = /^clean-[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+-\d+$/;

/** 是否为合法 clean MR caseId（校验与解析用） */
export function isCleanMrCaseId(caseId: string): boolean {
  return CASE_ID_RE.test(caseId);
}

/**
 * 单条构造（纯函数）：校验 caseId 形制、diff 非空且可解析后产出 MRCase。
 * truth 显式为 null——阴性对照的唯一标记，判定链据 isNegativeControl 分流。
 */
export function buildCleanMrCase(
  record: CleanMrRecord,
  options: CleanMrBuildOptions,
): Result<MRCase> {
  if (typeof record.caseId !== "string" || !CASE_ID_RE.test(record.caseId)) {
    return err(
      new DatasetError(
        "INVALID_RECORD",
        `caseId 必须形如 clean-<org>__<repo>-<number>，得到: ${JSON.stringify(record.caseId)}`,
      ),
    );
  }
  if (typeof record.diff !== "string" || record.diff.trim() === "") {
    return err(new DatasetError("INVALID_RECORD", "diff 必须为非空字符串"));
  }
  const parsed = parseUnifiedDiff(record.diff);
  if (!parsed.ok) {
    return err(new DatasetError("INVALID_RECORD", `diff 无法解析: ${parsed.error.message}`));
  }
  if (typeof options.repoPath !== "string" || options.repoPath.trim() === "") {
    return err(new DatasetError("INVALID_OPTIONS", "repoPath 必须为非空字符串"));
  }
  return ok({
    caseId: record.caseId,
    repoPath: options.repoPath,
    diff: record.diff,
    issueDescription: "",
    truth: null,
    labels: {
      source: CLEAN_MR_SOURCE,
      riskClass: record.riskClass ?? DEFAULT_RISK_CLASS,
      allowedConfigs: record.allowedConfigs ?? ALL_CONFIGS,
    },
  });
}

export interface CleanMrBatchFailure {
  readonly caseId: string;
  readonly code: string;
  readonly message: string;
}

/** 批量构造：逐条校验，失败项显式收集（与 convertDefectRecords 同款接口形态） */
export function buildCleanMrCases(
  records: readonly CleanMrRecord[],
  repoPathOf: (record: CleanMrRecord) => string,
): { readonly cases: readonly MRCase[]; readonly failures: readonly CleanMrBatchFailure[] } {
  const cases: MRCase[] = [];
  const failures: CleanMrBatchFailure[] = [];
  for (const record of records) {
    const built = buildCleanMrCase(record, { repoPath: repoPathOf(record) });
    if (built.ok) {
      cases.push(built.value);
    } else {
      failures.push({ caseId: record.caseId, code: built.error.code, message: built.error.message });
    }
  }
  return { cases, failures };
}

/**
 * 阴性对照判定（FP 口径的分流谓词，供 T10 判定链 / T12 运行器消费）：
 * truth === null 的 MRCase 即阴性对照——其上每条 Finding 计 1 FP，
 * 不参与 Recall / Precision / RIE / S-A-B 判定（无真值锚点），单列 FP 报告。
 */
export function isNegativeControl(mrCase: MRCase): boolean {
  return mrCase.truth === null;
}
