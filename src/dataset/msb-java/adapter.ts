import type { ConfigId } from "../../contracts/config.js";
import type { MRCase, TruthLocation } from "../../contracts/mr-case.js";
import { type FileDiff, type Hunk, type Result, DatasetError, err, ok } from "../diff/types.js";
import { parseUnifiedDiff } from "../diff/parse-unified-diff.js";
import { DEFAULT_RISK_CLASS, type RiskClass } from "../risk-class.js";
import { DEFAULT_DEFECT_NATURE } from "../defect-nature.js";

/**
 * Multi-SWE-bench Java 适配层（Ticket 08）：HF `java/` JSONL 记录 → MRCase。
 *
 * 数据格式（2026-09-03 实测核验：HF ByteDance-Seed/Multi-SWE-bench `java/` 目录
 * 9 个 per-repo JSONL 全量下载逐条解析，128 实例；字段核验详见
 * D:\xubao\code\AI4SE\.spec-notes\multi-swe-bench.md）：
 * - `fix_patch` = 非测试代码修复 diff（git unified diff），**直接作检视 diff**——
 *   MSB 的角色是「真实 PR 形态」的外部效度检查（spec 用户故事 21），
 *   不走逆补丁反转：base（repoPath）= `base.sha`（PR 前版本），MR = 该修复 PR 本身；
 * - `title`/`body` 作 MR 描述、`resolved_issues`（非空，实测 128/128）作 issue
 *   背景，确定性拼装为 issueDescription（`body` 为 null 时降级空串，实测 23 条）；
 * - 测试改动在 `test_patch`（本适配层不消费，检视对象即非测试修复 diff）；
 * - 边界过滤复用 T02 的 filterMrCases（≤10 文件 / diff ≤2K 行），过滤率由
 *   清单（sampling.ts）留痕。
 *
 * 真值口径（真实 PR 形态，与逆补丁法对称）：
 * - truth.locations = fix_patch **新侧（MR 合入后坐标系）** 的连续变更行段
 *   ——与逆补丁法「真值 = 修复补丁的实质变更行、坐标 = MR 合入后」完全对称，
 *   供 T09 与 Finding.line（schema 明定为合入后行号）直接可比；
 * - truth.fixPatch = fix_patch 原文；MSB 无缺陷性质标签 → defectNature 缺省
 *   CORRECTNESS（与 Defects4J 缺省一致）；
 * - 元数据：labels.allowedConfigs = ["C","E"]（spec：MSB 只跑 C/E），
 *   base.sha 等留在 MRCase.extensions（T12 checkout 依据）。
 *
 * 纯函数：JSONL 下载由清单生成脚本与 T12 负责，本模块零网络零 IO。
 */

/** HF 数据集 java/ 目录直链基址（hf-mirror.com 镜像可达，见研究笔记） */
export const MSB_JAVA_DATASET_BASE_URL =
  "https://huggingface.co/datasets/ByteDance-Seed/Multi-SWE-bench/resolve/main/java";

export const MSB_JAVA_DATASET_MIRROR_BASE_URL =
  "https://hf-mirror.com/datasets/ByteDance-Seed/Multi-SWE-bench/resolve/main/java";

/** java/ 目录 9 个 per-repo 文件（2026-09-03 HF API 实测核验，合计 128 实例） */
export const MSB_JAVA_DATASET_FILES: readonly string[] = [
  "alibaba__fastjson2_dataset.jsonl",
  "apache__dubbo_dataset.jsonl",
  "elastic__logstash_dataset.jsonl",
  "fasterxml__jackson-core_dataset.jsonl",
  "fasterxml__jackson-databind_dataset.jsonl",
  "fasterxml__jackson-dataformat-xml_dataset.jsonl",
  "google__gson_dataset.jsonl",
  "googlecontainertools__jib_dataset.jsonl",
  "mockito__mockito_dataset.jsonl",
];

export const MSB_JAVA_SOURCE = "msb-java";
/** spec：MSB-Java 真实 PR 形态只跑配置 C/E */
export const MSB_JAVA_ALLOWED_CONFIGS: readonly ConfigId[] = ["C", "E"];

const SHA_RE = /^[0-9a-f]{40}$/;

/** 校验后的 MSB 记录（仅 POC1 消费的字段；其余 20 列中构建/测试结果列不透传） */
export interface MsbRecord {
  readonly instanceId: string;
  readonly org: string;
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  /** base.sha（40 位十六进制；T12 checkout 基线） */
  readonly baseSha: string;
  readonly fixPatch: string;
  readonly resolvedIssues: readonly {
    readonly number: number;
    readonly title: string;
    readonly body: string;
  }[];
}

export interface MsbCaseOptions {
  /** 本地 git 仓库路径（base = base.sha 检出的 PR 前版本） */
  readonly repoPath: string;
  readonly riskClass?: RiskClass;
  readonly allowedConfigs?: readonly ConfigId[];
}

/** JSONL 记录 → MRCase（纯函数；字段缺失/格式漂移显式报错不静默） */
export function msbRecordToMrCase(record: unknown, options: MsbCaseOptions): Result<MRCase> {
  if (typeof options.repoPath !== "string" || options.repoPath.trim() === "") {
    return err(new DatasetError("INVALID_OPTIONS", "repoPath 必须为非空字符串"));
  }
  const validated = validateMsbRecord(record);
  if (!validated.ok) {
    return validated;
  }
  const msb = validated.value;
  const truthLocations = buildNewSideTruthLocations(msb.fixPatch);
  if (!truthLocations.ok) {
    return truthLocations;
  }
  return ok({
    caseId: msb.instanceId,
    repoPath: options.repoPath,
    diff: msb.fixPatch,
    issueDescription: buildMsbIssueDescription(msb),
    truth: { locations: truthLocations.value, fixPatch: msb.fixPatch },
    labels: {
      source: MSB_JAVA_SOURCE,
      riskClass: options.riskClass ?? DEFAULT_RISK_CLASS,
      allowedConfigs: options.allowedConfigs ?? MSB_JAVA_ALLOWED_CONFIGS,
    },
    extensions: {
      instanceId: msb.instanceId,
      org: msb.org,
      repo: msb.repo,
      number: String(msb.number),
      baseSha: msb.baseSha,
      prUrl: `https://github.com/${msb.org}/${msb.repo}/pull/${msb.number}`,
    },
  });
}

/** 批量转换：逐条校验与转换，失败项显式收集（不静默跳过） */
export function msbRecordsToMrCases(
  records: readonly unknown[],
  repoPathOf: (record: unknown) => string,
): {
  readonly cases: readonly MRCase[];
  readonly failures: readonly { readonly instanceId: string; readonly code: string; readonly message: string }[];
} {
  const cases: MRCase[] = [];
  const failures: { instanceId: string; code: string; message: string }[] = [];
  for (const record of records) {
    const instanceId = readInstanceId(record);
    const converted = msbRecordToMrCase(record, { repoPath: repoPathOf(record) });
    if (converted.ok) {
      cases.push(converted.value);
    } else {
      failures.push({ instanceId, code: converted.error.code, message: converted.error.message });
    }
  }
  return { cases, failures };
}

/** 形状校验（不含 diff 解析；漂移显式报错） */
export function validateMsbRecord(record: unknown): Result<MsbRecord> {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return err(new DatasetError("INVALID_RECORD", "记录必须为 JSON 对象"));
  }
  const r = record as Record<string, unknown>;
  const instanceId = requireNonEmptyString(r.instance_id, "instance_id");
  if (instanceId !== null) {
    return err(instanceId);
  }
  const org = requireNonEmptyString(r.org, "org");
  if (org !== null) {
    return err(org);
  }
  const repo = requireNonEmptyString(r.repo, "repo");
  if (repo !== null) {
    return err(repo);
  }
  const number = requirePositiveInt(r.number, "number");
  if (number !== null) {
    return err(number);
  }
  const title = requireNonEmptyString(r.title, "title");
  if (title !== null) {
    return err(title);
  }
  if (typeof r.body !== "string" && r.body !== null && r.body !== undefined) {
    return err(new DatasetError("INVALID_RECORD", "body 必须为字符串或 null（实测存在 23 条 null，降级为空串）"));
  }
  const base = r.base;
  if (typeof base !== "object" || base === null || typeof (base as Record<string, unknown>).sha !== "string" || !SHA_RE.test((base as Record<string, unknown>).sha as string)) {
    return err(new DatasetError("INVALID_RECORD", "base.sha 必须为 40 位十六进制字符串（T12 checkout 基线）"));
  }
  const baseSha = (base as Record<string, unknown>).sha as string;
  if (typeof r.fix_patch !== "string" || r.fix_patch.trim() === "") {
    return err(new DatasetError("INVALID_RECORD", "fix_patch 必须为非空字符串（检视 diff 本体）"));
  }
  const resolvedIssues = validateResolvedIssues(r.resolved_issues);
  if (resolvedIssues !== null) {
    return err(resolvedIssues);
  }
  // resolved_issues[].body 可为 null（与 PR body 同口径）→ 统一降级空串
  const issues = (r.resolved_issues as readonly {
    number: number;
    title: string;
    body: string | null;
  }[]).map((issue) => ({ ...issue, body: issue.body ?? "" }));
  return ok({
    instanceId: r.instance_id as string,
    org: r.org as string,
    repo: r.repo as string,
    number: r.number as number,
    title: r.title as string,
    body: (r.body as string | null) ?? "",
    baseSha,
    fixPatch: r.fix_patch as string,
    resolvedIssues: issues,
  });
}

function validateResolvedIssues(value: unknown): DatasetError | null {
  if (!Array.isArray(value) || value.length === 0) {
    return new DatasetError("INVALID_RECORD", "resolved_issues 必须为非空数组（MSB 真值背景的载体；实测 128/128 非空，空数组视为数据漂移）");
  }
  for (const issue of value) {
    if (typeof issue !== "object" || issue === null) {
      return new DatasetError("INVALID_RECORD", "resolved_issues 项必须为对象");
    }
    const iss = issue as Record<string, unknown>;
    const numberError = requirePositiveInt(iss.number, "resolved_issues[].number");
    if (numberError !== null) {
      return numberError;
    }
    const titleError = requireNonEmptyString(iss.title, "resolved_issues[].title");
    if (titleError !== null) {
      return titleError;
    }
    if (typeof iss.body !== "string" && iss.body !== null && iss.body !== undefined) {
      return new DatasetError("INVALID_RECORD", "resolved_issues[].body 必须为字符串或 null");
    }
  }
  return null;
}

function requireNonEmptyString(value: unknown, field: string): DatasetError | null {
  if (typeof value !== "string" || value.trim() === "") {
    return new DatasetError("INVALID_RECORD", `${field} 必须为非空字符串`);
  }
  return null;
}

function requirePositiveInt(value: unknown, field: string): DatasetError | null {
  if (!Number.isInteger(value) || (value as number) < 1) {
    return new DatasetError("INVALID_RECORD", `${field} 必须为 ≥1 的整数`);
  }
  return null;
}

function readInstanceId(record: unknown): string {
  if (typeof record === "object" && record !== null && !Array.isArray(record)) {
    const id = (record as Record<string, unknown>).instance_id;
    if (typeof id === "string" && id.trim() !== "") {
      return id;
    }
  }
  return "(unknown)";
}

/**
 * MR 背景描述（确定性拼装）：PR 标题/正文 + 关联 issue 标题/正文。
 * 全英文结构标签（PR/Linked issue），正文原样保留（trim 首尾空白）。
 */
export function buildMsbIssueDescription(msb: MsbRecord): string {
  const parts: string[] = [`PR #${msb.number}: ${msb.title}`];
  if (msb.body.trim() !== "") {
    parts.push(msb.body.trim());
  }
  for (const issue of msb.resolvedIssues) {
    const section = [`Linked issue #${issue.number}: ${issue.title}`];
    if (issue.body.trim() !== "") {
      section.push(issue.body.trim());
    }
    parts.push(section.join("\n\n"));
  }
  return parts.join("\n\n");
}

/**
 * 真值位置：fix_patch 新侧（MR 合入后坐标系）的连续变更行段。
 *
 * 锚定规则（与 T02 truth.ts 的旧侧规则镜像对称）：
 * - 含 add 行的段：lineStart..lineEnd = 段内 add 行新侧行号的最小/最大值；
 * - 纯删除段（修复删除 buggy 行、未新增）：锚定删除点后第一条现存新侧行
 *   （段在 hunk 末尾时锚定其前最后一行）；
 * - 删除整个文件（newPath = /dev/null）：合入后文件不存在，无新侧行位——跳过
 *   （该文件不产生真值位置）；全部文件均被删除时显式报错（真值不可构造）。
 */
export function buildNewSideTruthLocations(
  fixPatch: string,
  defectNature: string = DEFAULT_DEFECT_NATURE,
): Result<readonly TruthLocation[]> {
  const parsed = parseUnifiedDiff(fixPatch);
  if (!parsed.ok) {
    return err(new DatasetError("MALFORMED_FIX_PATCH", `fix_patch 解析失败: ${parsed.error.message}`));
  }
  const locations: TruthLocation[] = [];
  for (const file of parsed.value) {
    if (file.newPath === null) {
      continue;
    }
    locations.push(...fileLocations(file, defectNature));
  }
  if (locations.length === 0) {
    return err(
      new DatasetError(
        "EMPTY_TRUTH",
        "fix_patch 仅删除文件（或无新侧变更行），真实 PR 形态真值不可构造",
      ),
    );
  }
  return ok(locations);
}

function fileLocations(file: FileDiff, nature: string): TruthLocation[] {
  return file.hunks.flatMap((hunk) => hunkLocations(hunk, file.newPath!, nature));
}

/** 单遍游走 hunk 行，切分连续变更段并按新侧坐标定位（镜像 T02 旧侧规则） */
function hunkLocations(hunk: Hunk, filePath: string, nature: string): TruthLocation[] {
  // newCount === 0（纯删除 hunk）时 newStart 指删除点之前的行，游标从 newStart+1 起
  let cursor = hunk.newCount === 0 ? hunk.newStart + 1 : hunk.newStart;
  let run: { added: number[]; start: number } | null = null;
  const out: TruthLocation[] = [];
  const closeRun = (atHunkEnd: boolean): void => {
    if (run === null) {
      return;
    }
    out.push(runLocation(run, atHunkEnd, filePath, nature));
    run = null;
  };
  for (const line of hunk.lines) {
    if (line.type === "context") {
      closeRun(false);
      cursor += 1;
      continue;
    }
    if (run === null) {
      run = { added: [], start: cursor };
    }
    if (line.type === "add") {
      run = { ...run, added: [...run.added, cursor] };
      cursor += 1;
    }
    // remove 行不消耗新侧行号：变更段继续，游标不动（与 T02 旧侧镜像）
  }
  closeRun(true);
  return out;
}

function runLocation(
  run: { readonly added: readonly number[]; readonly start: number },
  atHunkEnd: boolean,
  filePath: string,
  nature: string,
): TruthLocation {
  if (run.added.length > 0) {
    return {
      file: filePath,
      lineStart: Math.min(...run.added),
      lineEnd: Math.max(...run.added),
      defectNature: nature,
    };
  }
  const anchor = atHunkEnd ? Math.max(run.start - 1, 0) : run.start;
  return { file: filePath, lineStart: anchor, lineEnd: anchor, defectNature: nature };
}
