import type { ConfigId } from "../../contracts/config.js";
import type { MRCase } from "../../contracts/mr-case.js";
import type { RiskClass } from "../risk-class.js";
import type { BoundaryMetrics } from "../mr-boundary-filter.js";
import { createHash } from "node:crypto";
import { type Result, DatasetError, err, ok } from "../diff/types.js";
import {
  buildCleanMrCase,
  buildCleanMrCaseId,
  isCleanMrCaseId,
} from "./builder.js";
import { MINING_RULES_DESCRIPTION } from "./mining-rules.js";
import type { RepoSelectionStats } from "./selection.js";

/**
 * clean MR 阴性对照清单（Ticket 09 交付物）。
 *
 * 清单即数据集：manifest.json（本模块的类型）+ data/clean-mr/diffs/*.diff。
 * 采集参数（仓库、配额、规则）全部显式落盘，规则文本可复现；
 * negativeControl 块声明 FP 口径与 A vs C 分组对比维度（工单验收 2/3）。
 */

export const CLEAN_MR_MANIFEST_SCHEMA_VERSION = 1;

/** FP 口径与 A vs C 对比的机器可读声明（判定链 T10 / 运行器 T12 消费） */
export interface CleanMrNegativeControlMeta {
  /** clean MR 无真值：MRCase.truth === null */
  readonly truthPolicy: "none";
  /** 阴性对照口径：该集上每条 Finding 计 1 FP；无 Recall/Precision（真值集为空） */
  readonly fpCriteria: "every-finding-counts-as-fp";
  /** A vs C 分组对比（spec 用户故事 22：主动检索是否推高无中生有率） */
  readonly comparison: {
    readonly dimension: "active-retrieval-vs-diff-only";
    readonly configA: "Diff-only（零工具，最低成本基线）";
    readonly configC: "Full Repo + 7 工具（质量主锚）";
    readonly metric: "false-positive findings per clean MR";
  };
}

export interface CleanMrManifestCase {
  readonly caseId: string;
  readonly org: string;
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  /** 正文预览（前 2000 字符，换行归一；完整正文以 html_url 回链为准） */
  readonly bodyPreview: string;
  readonly htmlUrl: string;
  readonly mergedAt: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly mergeCommitSha: string | null;
  /** diff 文件相对清单目录的路径（diffs/<caseId>.diff） */
  readonly diffFile: string;
  readonly diffSha256: string;
  readonly diffBytes: number;
  /** MR 边界指标（≤10 文件 / ≤2000 变更行的口径数值，入清单即已通过） */
  readonly metrics: BoundaryMetrics;
}

export interface CleanMrManifestRules {
  readonly merged: string;
  readonly issueLink: string;
  readonly revertPr: string;
  readonly revertedByLaterPr: string;
  readonly dependencyBump: string;
  readonly javaFile: string;
  readonly issueLinkPort: string;
}

export interface CleanMrManifest {
  readonly schemaVersion: number;
  readonly source: "clean-mr";
  /** 采集时间（UTC ISO）；重放以清单内容为准 */
  readonly generatedAt: string;
  readonly generator: string;
  readonly target: {
    readonly total: number;
    readonly perRepoQuota: number;
    /** 扫描方向与页参数（GitHub pulls 列表 API） */
    readonly scan: string;
  };
  readonly rules: CleanMrManifestRules;
  readonly negativeControl: CleanMrNegativeControlMeta;
  readonly repos: readonly (RepoSelectionStats & { readonly msbInstanceCount: number })[];
  readonly cases: readonly CleanMrManifestCase[];
  readonly total: number;
}

export interface ManifestCaseInput {
  readonly org: string;
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly htmlUrl: string;
  readonly mergedAt: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly mergeCommitSha: string | null;
  readonly diff: string;
  readonly diffSha256: string;
  readonly metrics: BoundaryMetrics;
}

export interface BuildManifestInput {
  readonly generatedAt: string;
  readonly generator: string;
  readonly targetTotal: number;
  readonly perRepoQuota: number;
  readonly scan: string;
  readonly repoStats: readonly (RepoSelectionStats & { readonly msbInstanceCount: number })[];
  readonly cases: readonly ManifestCaseInput[];
}

export const BODY_PREVIEW_MAX_CHARS = 2000;
export const DIFF_FILE_DIR = "diffs";

/** diff 文件名：diffs/<caseId>.diff */
export function diffFileName(caseId: string): string {
  return `${DIFF_FILE_DIR}/${caseId}.diff`;
}

/** 构造清单（纯函数）：汇总计数、正文截断、一致性校验（caseId 唯一、仓库归属、计数吻合） */
export function buildCleanMrManifest(input: BuildManifestInput): Result<CleanMrManifest> {
  if (!Array.isArray(input.cases) || !Array.isArray(input.repoStats)) {
    return err(new DatasetError("INVALID_MANIFEST", "cases 与 repoStats 必须为数组"));
  }
  const repoKeys = new Set(input.repoStats.map((r) => `${r.org}/${r.repo}`));
  const seenCaseIds = new Set<string>();
  const cases: CleanMrManifestCase[] = [];
  for (const c of input.cases) {
    const caseId = buildCleanMrCaseId(c.org, c.repo, c.number);
    if (!isCleanMrCaseId(caseId)) {
      return err(new DatasetError("INVALID_MANIFEST", `caseId 形制非法: ${caseId}`));
    }
    if (seenCaseIds.has(caseId)) {
      return err(new DatasetError("INVALID_MANIFEST", `caseId 重复: ${caseId}`));
    }
    seenCaseIds.add(caseId);
    if (!repoKeys.has(`${c.org}/${c.repo}`)) {
      return err(
        new DatasetError("INVALID_MANIFEST", `case ${caseId} 的仓库 ${c.org}/${c.repo} 不在 repos 清单内`),
      );
    }
    cases.push({
      caseId,
      org: c.org,
      repo: c.repo,
      number: c.number,
      title: c.title,
      bodyPreview: bodyPreview(c.body),
      htmlUrl: c.htmlUrl,
      mergedAt: c.mergedAt,
      baseRef: c.baseRef,
      baseSha: c.baseSha,
      mergeCommitSha: c.mergeCommitSha,
      diffFile: diffFileName(caseId),
      diffSha256: c.diffSha256,
      diffBytes: byteLength(c.diff),
      metrics: c.metrics,
    });
  }
  const total = cases.length;
  const selectedSum = input.repoStats.reduce((s, r) => s + r.selected, 0);
  if (selectedSum !== total) {
    return err(
      new DatasetError(
        "INVALID_MANIFEST",
        `repos.selected 合计 ${selectedSum} 与 cases 总数 ${total} 不一致`,
      ),
    );
  }
  return ok({
    schemaVersion: CLEAN_MR_MANIFEST_SCHEMA_VERSION,
    source: "clean-mr",
    generatedAt: input.generatedAt,
    generator: input.generator,
    target: {
      total: input.targetTotal,
      perRepoQuota: input.perRepoQuota,
      scan: input.scan,
    },
    rules: {
      ...MINING_RULES_DESCRIPTION,
      issueLinkPort:
        "issueLink 规则为 Multi-SWE-bench collect/filter_prs.py extract_resolved_issues 的逐字移植（JS 版），已知差异：Python \\w 含 Unicode 字母而 JS \\w 仅 ASCII，对本词表判定无影响",
    },
    negativeControl: {
      truthPolicy: "none",
      fpCriteria: "every-finding-counts-as-fp",
      comparison: {
        dimension: "active-retrieval-vs-diff-only",
        configA: "Diff-only（零工具，最低成本基线）",
        configC: "Full Repo + 7 工具（质量主锚）",
        metric: "false-positive findings per clean MR",
      },
    },
    repos: input.repoStats,
    cases,
    total,
  });
}

/** 校验已加载的清单 JSON（T12 消费前的边界校验：结构、计数、caseId、指标齐全） */
export function validateCleanMrManifest(raw: unknown): Result<CleanMrManifest> {
  if (typeof raw !== "object" || raw === null) {
    return err(new DatasetError("INVALID_MANIFEST", "清单必须为 JSON 对象"));
  }
  const m = raw as Record<string, unknown>;
  if (m.schemaVersion !== CLEAN_MR_MANIFEST_SCHEMA_VERSION) {
    return err(
      new DatasetError("INVALID_MANIFEST", `schemaVersion 必须为 ${CLEAN_MR_MANIFEST_SCHEMA_VERSION}`),
    );
  }
  if (m.source !== "clean-mr") {
    return err(new DatasetError("INVALID_MANIFEST", `source 必须为 "clean-mr"`));
  }
  if (!Array.isArray(m.cases) || !Array.isArray(m.repos)) {
    return err(new DatasetError("INVALID_MANIFEST", "cases 与 repos 必须为数组"));
  }
  if (m.negativeControl === undefined || typeof m.negativeControl !== "object") {
    return err(new DatasetError("INVALID_MANIFEST", "negativeControl 块缺失（FP 口径声明）"));
  }
  const nc = m.negativeControl as Record<string, unknown>;
  if (nc.truthPolicy !== "none" || nc.fpCriteria !== "every-finding-counts-as-fp") {
    return err(
      new DatasetError("INVALID_MANIFEST", "negativeControl.truthPolicy/fpCriteria 口径不符（预期无真值、每条 Finding 计 FP）"),
    );
  }
  const seen = new Set<string>();
  for (const item of m.cases) {
    if (typeof item !== "object" || item === null) {
      return err(new DatasetError("INVALID_MANIFEST", "cases 项必须为对象"));
    }
    const c = item as Record<string, unknown>;
    if (typeof c.caseId !== "string" || !isCleanMrCaseId(c.caseId)) {
      return err(new DatasetError("INVALID_MANIFEST", `caseId 非法: ${JSON.stringify(c.caseId)}`));
    }
    if (seen.has(c.caseId)) {
      return err(new DatasetError("INVALID_MANIFEST", `caseId 重复: ${c.caseId}`));
    }
    seen.add(c.caseId);
    for (const field of ["org", "repo", "title", "htmlUrl", "mergedAt", "baseRef", "baseSha", "diffFile", "diffSha256"] as const) {
      if (typeof c[field] !== "string" || (c[field] as string) === "") {
        return err(new DatasetError("INVALID_MANIFEST", `${c.caseId}.${field} 必须为非空字符串`));
      }
    }
    if (!Number.isInteger(c.number) || (c.number as number) < 1) {
      return err(new DatasetError("INVALID_MANIFEST", `${c.caseId}.number 必须为 ≥1 整数`));
    }
    if (typeof c.metrics !== "object" || c.metrics === null) {
      return err(new DatasetError("INVALID_MANIFEST", `${c.caseId}.metrics 缺失`));
    }
    if (typeof c.diffBytes !== "number" || !Number.isInteger(c.diffBytes) || c.diffBytes <= 0) {
      return err(new DatasetError("INVALID_MANIFEST", `${c.caseId}.diffBytes 必须为正整数`));
    }
  }
  if (m.total !== m.cases.length) {
    return err(new DatasetError("INVALID_MANIFEST", `total(${m.total}) 与 cases 数(${m.cases.length})不一致`));
  }
  return ok(raw as unknown as CleanMrManifest);
}

export interface CleanMrCaseLoadDeps {
  /** 读 diff 文本（T12 注入文件读取；返回空串视为读取失败由本函数报错） */
  readonly diffOf: (manifestCase: CleanMrManifestCase) => string;
  /** 每个案例的本地仓库路径（T12 按 baseSha checkout 的克隆） */
  readonly repoPathOf: (manifestCase: CleanMrManifestCase) => string;
  readonly riskClass?: RiskClass;
  readonly allowedConfigs?: readonly ConfigId[];
  /** 校验 diff 与清单 sha256 一致（默认开；数据文件损坏时显式失败而非静默错用） */
  readonly verifyDiffChecksum?: boolean;
}

/**
 * 清单 → MRCase 批（T12 消费入口，纯函数；IO 经 deps 注入）。
 * 校验清单结构、逐条构造（truth = null），失败项显式收集不静默跳过。
 */
export function cleanMrCasesFromManifest(
  manifest: CleanMrManifest,
  deps: CleanMrCaseLoadDeps,
): Result<{ readonly cases: readonly MRCase[]; readonly failures: readonly { readonly caseId: string; readonly message: string }[] }> {
  const validated = validateCleanMrManifest(manifest);
  if (!validated.ok) {
    return validated;
  }
  const cases: MRCase[] = [];
  const failures: { caseId: string; message: string }[] = [];
  const verifyChecksum = deps.verifyDiffChecksum !== false;
  for (const manifestCase of manifest.cases) {
    const diff = deps.diffOf(manifestCase);
    if (typeof diff !== "string" || diff.trim() === "") {
      failures.push({ caseId: manifestCase.caseId, message: `diff 读取为空: ${manifestCase.diffFile}` });
      continue;
    }
    if (verifyChecksum && sha256Hex(diff) !== manifestCase.diffSha256) {
      failures.push({
        caseId: manifestCase.caseId,
        message: `diff 与清单 sha256 不一致（数据文件损坏或被改动）: ${manifestCase.diffFile}`,
      });
      continue;
    }
    const built = buildCleanMrCase(
      {
        caseId: manifestCase.caseId,
        diff,
        ...(deps.riskClass === undefined ? {} : { riskClass: deps.riskClass }),
        ...(deps.allowedConfigs === undefined ? {} : { allowedConfigs: deps.allowedConfigs }),
      },
      { repoPath: deps.repoPathOf(manifestCase) },
    );
    if (built.ok) {
      cases.push(built.value);
    } else {
      failures.push({ caseId: manifestCase.caseId, message: built.error.message });
    }
  }
  return ok({ cases, failures });
}

function bodyPreview(body: string | null): string {
  if (body === null || body === "") {
    return "";
  }
  const normalized = body.replace(/\r\n/g, "\n");
  if (normalized.length <= BODY_PREVIEW_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, BODY_PREVIEW_MAX_CHARS)}…[truncated ${normalized.length - BODY_PREVIEW_MAX_CHARS} chars]`;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
