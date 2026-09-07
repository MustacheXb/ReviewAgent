import type { ConfigId } from "../../contracts/config.js";
import { type DefectRecord } from "../defect-record.js";
import { type SourceSnapshot, applyUnifiedDiff } from "../diff/apply-unified-diff.js";
import { type Result, DatasetError, err, ok } from "../diff/types.js";
import { parseUnifiedDiff } from "../diff/parse-unified-diff.js";
import { serializeUnifiedDiff } from "../diff/serialize-unified-diff.js";
import { reverseUnifiedDiff } from "../diff/reverse-unified-diff.js";
import { type RiskClass } from "../risk-class.js";

/**
 * Defects4J 适配层（Ticket 02）：从 Defects4J 导出物构造 defectRecord。
 *
 * 零 CLI 工作流（源码级核实，见 D:\xubao\code\AI4SE\.spec-notes\defects4j-export.md）：
 * - srcPatch = `framework/projects/<PID>/patches/<bid>.src.patch`，本身是**人工最小化的
 *   fixed→buggy 逆补丁**（应用于 fixed 版本即得 buggy）——恰为逆补丁法的「MR diff」方向；
 *   本适配层将其求反为 defectRecord.fixPatch（buggy→fixed），真值即由 fixPatch 机械导出；
 * - fixedFiles = 对官方裸仓库包（defects4j-repos-v3.zip）按 active-bugs.csv 的
 *   `revision.id.fixed` 执行 `git archive` 的导出物中、补丁触碰文件的快照；
 * - buggyFiles 可省略：buggy 快照 = fixed 快照 + srcPatch（语义上不能用未最小化的
 *   `revision.id.buggy` 父提交冒充，适配层按此定义自动求出）；
 * - issueDescription 可为空：d4j 不随仓库分发 issue 正文（仅 report.url），
 *   由数据集构造方按降级预案填充；reportUrl 原样透传到 defectRecord。
 *
 * 不需要 checkout、不需要编译、不需要 Java/Perl；文件读取由 Ticket 12 的导出脚本负责，
 * 本模块纯函数。
 */
export interface Defects4jExportInput {
  /** Defects4J 项目 key（如 "Lang"） */
  readonly project: string;
  /** bug ID（≥ 1） */
  readonly bugId: number;
  /** `<bid>.src.patch` 文本：fixed→buggy 的人工最小化逆补丁（Defects4J 原生方向） */
  readonly srcPatch: string;
  /** 修复后版本源码快照（仓库相对路径 → 内容；git archive revision.id.fixed 的导出物） */
  readonly fixedFiles: SourceSnapshot;
  /** buggy 版本源码快照（可选；省略时由 fixedFiles + srcPatch 自动求出） */
  readonly buggyFiles?: SourceSnapshot;
  /** bug / issue 报告描述（可为空串或占位；d4j 仅有 report.url） */
  readonly issueDescription?: string;
  /** active-bugs.csv 的 report.url（可选；供后续抓取 issue 正文） */
  readonly reportUrl?: string;
  /** 文件 → 缺陷性质（键为补丁路径，与 srcPatch 的路径约定一致；适配层自动加仓库前缀）；缺省 CORRECTNESS */
  readonly defectNatures?: Readonly<Record<string, string>>;
  /** 补丁路径 → 仓库路径 的前缀（缺省为空：补丁路径即仓库相对路径） */
  readonly patchPathPrefix?: string;
  readonly riskClass?: RiskClass;
  readonly allowedConfigs?: readonly ConfigId[];
}

export const DEFECTS4J_SOURCE = "defects4j";

const PROJECT_KEY_RE = /^[A-Z][A-Za-z0-9]*$/;

/** Defects4J 导出物 → defectRecord（纯函数；recordId = "<project>-<bugId>"） */
export function defects4jToDefectRecord(input: Defects4jExportInput): Result<DefectRecord> {
  const baseError = validateInputShape(input);
  if (baseError !== undefined) {
    return err(baseError);
  }
  const prefix = normalizePrefix(input.patchPathPrefix);
  const remapped = remapPatchPaths(input.srcPatch, prefix);
  if (!remapped.ok) {
    return remapped;
  }
  const fixPatch = reverseUnifiedDiff(remapped.value);
  if (!fixPatch.ok) {
    return err(new DatasetError("INVALID_FIX_PATCH", `srcPatch 求反失败: ${fixPatch.error.message}`));
  }
  const buggySources = resolveBuggySources(input, remapped.value);
  if (!buggySources.ok) {
    return buggySources;
  }
  return ok({
    recordId: `${input.project}-${input.bugId}`,
    fixedSources: input.fixedFiles,
    fixPatch: fixPatch.value,
    ...(input.issueDescription === undefined ? {} : { issueDescription: input.issueDescription }),
    ...(input.reportUrl === undefined ? {} : { reportUrl: input.reportUrl }),
    ...(input.defectNatures === undefined ? {} : { defectNatures: remapNatureKeys(input.defectNatures, prefix) }),
    ...(buggySources.value === undefined ? {} : { buggySources: buggySources.value }),
    source: DEFECTS4J_SOURCE,
    ...(input.riskClass === undefined ? {} : { riskClass: input.riskClass }),
    ...(input.allowedConfigs === undefined ? {} : { allowedConfigs: input.allowedConfigs }),
  });
}

function validateInputShape(input: Defects4jExportInput): DatasetError | undefined {
  if (typeof input.project !== "string" || !PROJECT_KEY_RE.test(input.project)) {
    return new DatasetError("INVALID_INPUT", `project 必须形如 Defects4J 项目 key（大写开头），得到: ${JSON.stringify(input.project)}`);
  }
  if (!Number.isInteger(input.bugId) || input.bugId < 1) {
    return new DatasetError("INVALID_INPUT", `bugId 必须为 ≥1 的整数，得到: ${JSON.stringify(input.bugId)}`);
  }
  if (typeof input.srcPatch !== "string" || input.srcPatch.trim() === "") {
    return new DatasetError("INVALID_INPUT", "srcPatch 必须为非空字符串");
  }
  if (input.fixedFiles === undefined || input.fixedFiles === null || Object.keys(input.fixedFiles).length === 0) {
    return new DatasetError("INVALID_INPUT", "fixedFiles 必须为非空快照");
  }
  if (input.issueDescription !== undefined && typeof input.issueDescription !== "string") {
    return new DatasetError("INVALID_INPUT", "issueDescription 必须为字符串（允许空串）");
  }
  return undefined;
}

function normalizePrefix(prefix: string | undefined): string {
  if (prefix === undefined || prefix === "") {
    return "";
  }
  const trimmed = prefix.replace(/\/+$/, "");
  return trimmed === "" ? "" : `${trimmed}/`;
}

/** 重写补丁文件路径（加前缀）并重新序列化；同时校验补丁本身可解析 */
function remapPatchPaths(patchText: string, prefix: string): Result<string> {
  const parsed = parseUnifiedDiff(patchText);
  if (!parsed.ok) {
    return err(new DatasetError("INVALID_FIX_PATCH", `srcPatch 解析失败: ${parsed.error.message}`));
  }
  const remapped = parsed.value.map((file) => ({
    ...file,
    oldPath: file.oldPath === null ? null : prefix + file.oldPath,
    newPath: file.newPath === null ? null : prefix + file.newPath,
  }));
  const serialized = serializeUnifiedDiff(remapped);
  if (!serialized.ok) {
    return err(new DatasetError("INVALID_FIX_PATCH", `srcPatch 重序列化失败: ${serialized.error.message}`));
  }
  return serialized;
}

/**
 * buggy 快照解析：优先用调用方提供的 buggyFiles；否则按定义
 * buggy = fixed + srcPatch（fixed→buggy）自动求出（严格应用，无模糊匹配）。
 */
function resolveBuggySources(
  input: Defects4jExportInput,
  remappedSrcPatch: string,
): Result<SourceSnapshot | undefined> {
  if (input.buggyFiles !== undefined) {
    return ok(input.buggyFiles);
  }
  const applied = applyUnifiedDiff(input.fixedFiles, remappedSrcPatch);
  if (!applied.ok) {
    return err(
      new DatasetError("SRC_PATCH_NOT_APPLICABLE", `srcPatch 无法应用于 fixed 快照（检查 base 是否为 revision.id.fixed 的导出物）: ${applied.error.message}`),
    );
  }
  const merged: Record<string, string> = { ...input.fixedFiles, ...applied.value.sources };
  for (const path of applied.value.deletedPaths) {
    delete merged[path];
  }
  return ok(merged);
}

function remapNatureKeys(
  natures: Readonly<Record<string, string>>,
  prefix: string,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [path, nature] of Object.entries(natures)) {
    out[prefix + path] = nature;
  }
  return out;
}
