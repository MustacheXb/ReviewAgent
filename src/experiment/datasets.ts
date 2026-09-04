import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MRCase } from "../contracts/mr-case.js";
import { filterMrCases } from "../dataset/mr-boundary-filter.js";
import { cleanMrCasesFromManifest, validateCleanMrManifest } from "../dataset/clean-mr/manifest.js";

/**
 * 实验数据集装载（Ticket 12）：把仓库内/物化的数据源汇成 MRCase 批。
 *
 * 数据源两路：
 * - cases 文件（--cases-file）：物化的 MRCase[] JSON——d4j（按采样清单物化
 *   srcPatch + fixedFiles 导出物）、vul4j（按 extensions.fixSha checkout 修复
 *   commit 作 base）、msb-java（按 extensions.baseSha checkout）适配层的产物；
 *   本模块只做形状校验与边界过滤；
 * - clean MR 阴性对照（--clean-mr）：仓库自带 data/clean-mr 清单 + diff 交付物，
 *   truth = null，FP 口径见清单 negativeControl 块（spec 用户故事 22）。
 *
 * 纪律：单 case 装载失败显式留痕（failures）继续，不静默跳过；
 * MR 边界过滤（≤10 文件 / ≤2K 行，spec 用户故事 23）作为最终防线统一应用。
 */

/** 装载选项 */
export interface DatasetLoadOptions {
  /** 物化数据集文件（MRCase[] JSON；d4j/vul4j/msb 导出产物） */
  readonly casesFile?: string;
  /** 装载仓库自带 clean MR 阴性对照（data/clean-mr） */
  readonly cleanMr?: boolean;
  /** clean MR case 的 repoPath：A/B 零工具配置不读取；C/D/E 需本地克隆 */
  readonly cleanMrRepoPath?: string;
  /** 数据集根目录（缺省 <repo>/data；测试可注入临时目录） */
  readonly dataRoot?: string;
}

/** 单条装载失败的留痕 */
export interface DatasetLoadFailure {
  readonly source: string;
  readonly message: string;
}

export interface DatasetLoadResult {
  readonly cases: readonly MRCase[];
  readonly failures: readonly DatasetLoadFailure[];
}

/** 装载全部请求的数据源（顺序：cases 文件 → clean MR；失败留痕不中断） */
export async function loadExperimentCases(
  options: DatasetLoadOptions,
): Promise<DatasetLoadResult> {
  const cases: MRCase[] = [];
  const failures: DatasetLoadFailure[] = [];
  if (options.casesFile !== undefined) {
    const loaded = await loadCasesFile(options.casesFile);
    cases.push(...loaded.cases);
    failures.push(...loaded.failures);
  }
  if (options.cleanMr === true) {
    const loaded = await loadCleanMrCases({
      dataRoot: options.dataRoot ?? defaultDataRoot(),
      repoPath: options.cleanMrRepoPath ?? "",
    });
    cases.push(...loaded.cases);
    failures.push(...loaded.failures);
  }
  const boundaryFiltered = applyBoundaryFilter(cases);
  return {
    cases: boundaryFiltered.cases,
    failures: [...failures, ...boundaryFiltered.failures],
  };
}

/** 仓库 data/ 目录（本文件位于 src/experiment/ → 仓库根是上两级目录的上一级） */
export function defaultDataRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
}

/** 物化 cases 文件装载：整体结构错误显式抛（配置错误 fail fast），逐 case 失败留痕 */
async function loadCasesFile(casesFile: string): Promise<DatasetLoadResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(casesFile, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to read cases file ${casesFile}: ${message}`, { cause: error });
  }
  if (!Array.isArray(raw)) {
    throw new Error(`cases file ${casesFile} must contain a JSON array of MRCase`);
  }
  const cases: MRCase[] = [];
  const failures: DatasetLoadFailure[] = [];
  for (const [index, entry] of raw.entries()) {
    const invalid = mrCaseShapeError(entry);
    if (invalid !== null) {
      failures.push({
        source: typeof (entry as { labels?: { source?: unknown } })?.labels?.source === "string"
          ? ((entry as { labels: { source: string } }).labels.source)
          : "unknown",
        message: `cases file entry [${index}]: ${invalid}`,
      });
      continue;
    }
    cases.push(entry as MRCase);
  }
  return { cases, failures };
}

/** clean MR 阴性对照装载：清单 + diff 交付物（checksum 校验；逐 case 失败留痕） */
async function loadCleanMrCases(options: {
  readonly dataRoot: string;
  readonly repoPath: string;
}): Promise<DatasetLoadResult> {
  const manifestPath = path.join(options.dataRoot, "clean-mr", "manifest.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to read clean MR manifest ${manifestPath}: ${message}`, { cause: error });
  }
  const validated = validateCleanMrManifest(raw);
  if (!validated.ok) {
    throw new Error(`clean MR manifest ${manifestPath} is invalid: ${validated.error.message}`);
  }
  const diffDir = path.join(options.dataRoot, "clean-mr");
  const loaded = cleanMrCasesFromManifest(validated.value, {
    // diffOf 为同步契约（cleanMrCasesFromManifest 的注入接口）；单文件 ≤2K 行，同步读足够
    diffOf: (manifestCase) => {
      try {
        return readFileSync(path.join(diffDir, manifestCase.diffFile), "utf8");
      } catch {
        return "";
      }
    },
    repoPathOf: () => options.repoPath,
  });
  if (!loaded.ok) {
    throw new Error(`clean MR manifest ${manifestPath} failed to load: ${loaded.error.message}`);
  }
  return {
    cases: loaded.value.cases,
    failures: loaded.value.failures.map((failure) => ({
      source: "clean-mr",
      message: `${failure.caseId}: ${failure.message}`,
    })),
  };
}

/** MR 边界过滤（最终防线；拒绝项留痕，reason 来自 T02 filterMrCases 的口径） */
function applyBoundaryFilter(cases: readonly MRCase[]): DatasetLoadResult {
  if (cases.length === 0) {
    return { cases, failures: [] };
  }
  const filtered = filterMrCases(cases);
  return {
    cases: filtered.accepted,
    failures: filtered.report.rejected.map((rejected) => ({
      source: rejected.source,
      message: `MR boundary filter rejected (${rejected.reason}): ${rejected.message}`,
    })),
  };
}

/** MRCase 形状快校验（完整校验由 runReview 的 validateRunInputs 在单元级执行） */
function mrCaseShapeError(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null) {
    return "entry must be an MRCase object";
  }
  const record = entry as Partial<MRCase>;
  if (typeof record.caseId !== "string" || record.caseId.length === 0) {
    return "caseId must be a non-empty string";
  }
  if (typeof record.repoPath !== "string" || record.repoPath.length === 0) {
    return "repoPath must be a non-empty string";
  }
  if (typeof record.diff !== "string" || record.diff.trim().length === 0) {
    return "diff must be a non-empty string";
  }
  if (typeof record.issueDescription !== "string") {
    return "issueDescription must be a string";
  }
  const labels = record.labels as Partial<MRCase["labels"]> | undefined;
  if (typeof labels !== "object" || labels === null) {
    return "labels must be a CaseLabels object";
  }
  if (typeof labels.source !== "string" || labels.source.length === 0) {
    return "labels.source must be a non-empty string";
  }
  if (labels.riskClass !== "Low" && labels.riskClass !== "Medium" && labels.riskClass !== "High") {
    return `labels.riskClass must be "Low", "Medium" or "High" (got ${JSON.stringify(labels.riskClass)})`;
  }
  if (!Array.isArray(labels.allowedConfigs) || labels.allowedConfigs.length === 0) {
    return "labels.allowedConfigs must be a non-empty array";
  }
  return null;
}
