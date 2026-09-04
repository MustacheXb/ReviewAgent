import type { ConfigId } from "../../contracts/config.js";
import type { MRCase } from "../../contracts/mr-case.js";
import { type DefectRecord, validateDefectRecord } from "../defect-record.js";
import { convertDefectRecord } from "../inverse-patch.js";
import { type SourceSnapshot } from "../diff/apply-unified-diff.js";
import { type Result, DatasetError, err, ok } from "../diff/types.js";
import { parseUnifiedDiff } from "../diff/parse-unified-diff.js";
import { type RiskClass } from "../risk-class.js";
import { resolveCweNature } from "./cwe-nature-map.js";

/**
 * Vul4J 适配层（Ticket 08）：Vul4J 导出物 → DefectRecord → MRCase（逆补丁法）。
 *
 * 数据格式（2026-09-03 实测核验，github.com/tuhh-softsec/Vul4J master）：
 * - 数据集 CSV 不含 diff 正文，`human_patch` 列是修复 commit 的 GitHub URL
 *   （59 条 40 位 commit 直链 / 5 条短 SHA / 2 条 compare 区间，实测 66 条
 *   CWE 标注条目中 65 条可经 `<url>.diff` 取回 unified diff；1 条 404）；
 * - 修复 commit diff 同时含源码与测试（及个别二进制测试资源）改动；
 *   本适配层剥离测试/二进制文件节，仅以源码部分作最小修复补丁
 *   （与 Defects4J `.src.patch` 的源码/测试分离、MSB `fix_patch` 的
 *   「非测试代码修复 diff」口径对齐），剥离明细全量留痕；
 * - `repo_slug` 列与 human_patch 实际仓库存在 6 处不一致（如 apache/batik
 *   实为 apache/xmlgraphics-batik），repoSlug 仅作标签，仓库定位以
 *   fixCommitUrl 为准（T12 按 fixSha checkout 修复后版本）。
 *
 * 逆补丁口径（与 Defects4J 同路）：base（repoPath）= 修复 commit 版本，
 * MR diff = 源码修复补丁的逆 diff，真值 = 源码修复补丁的行位与性质；
 * CVE/CWE 经 cwe-nature-map 映射为 defectNatures（映射不到显式 OTHER +
 * matched=false 留痕）；riskClass 缺省 High（spec：驱动 C2/C3 深加载）。
 *
 * 纯函数：不下载、不落盘、不经过 LLM；diff 获取由清单生成脚本与 T12 负责。
 */

export const VUL4J_SOURCE = "vul4j";
export const VUL4J_DEFAULT_RISK_CLASS: RiskClass = "High";

const VUL_ID_RE = /^VUL4J-\d+(-S)?$/;
const COMMIT_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]+)$/;
const COMPARE_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/compare\/([0-9a-f]+)\.\.([0-9a-f]+)$/;

/** Vul4J 导出物输入（CSV 条目元数据 + T12/清单脚本取回的 commit diff 与源码快照） */
export interface Vul4jExportInput {
  /** 漏洞 ID（如 "VUL4J-1"），成为 recordId / caseId */
  readonly vulId: string;
  /** CVE 编号（"Not Mapping" 或缺省 = 无 CVE 标签） */
  readonly cveId?: string;
  /** CWE 编号（"Not Mapping"/空串/缺省 = 无 CWE 标签 → defectNature 显式 OTHER） */
  readonly cweId?: string;
  /** CWE 名称 */
  readonly cweName?: string;
  /** OWASP 标签（仅透传到 extensions） */
  readonly owaspId?: string;
  /** 仓库标签（CSV repo_slug 列；注意与实际仓库可能不一致，见文件头说明） */
  readonly repoSlug: string;
  /** 修复 commit/compare 的 GitHub URL（仓库定位的权威来源） */
  readonly fixCommitUrl: string;
  /** 修复 commit 的完整 diff 文本（`<url>.diff` 取回，源码+测试+二进制混杂） */
  readonly fixDiff: string;
  /** 修复后（fix commit）版本源码快照（至少覆盖源码补丁触碰的全部文件） */
  readonly fixedSources: SourceSnapshot;
  /** issue 描述覆盖（缺省由 CVE/CWE 元数据确定性拼装） */
  readonly issueDescription?: string;
  /** 测试路径前缀（仓库相对；缺省仅按路径段启发式判测试，见 isTestPath） */
  readonly testPathPrefixes?: readonly string[];
  /** PoV 失败测试签名（缺省描述拼装用） */
  readonly failingTests?: string;
  readonly riskClass?: RiskClass;
  readonly allowedConfigs?: readonly ConfigId[];
}

/** 测试/二进制剥离留痕（降级留痕：被剥离文件全量记录，不静默） */
export interface StripTrace {
  /** 被判为测试文件而剥离的路径 */
  readonly excludedTestFiles: readonly string[];
  /** 被判为二进制而剥离的路径（parseUnifiedDiff 不支持二进制节） */
  readonly excludedBinaryFiles: readonly string[];
}

export interface Vul4jRecordTrace {
  readonly record: DefectRecord;
  readonly strip: StripTrace;
  /** CVE/CWE → defectNature 映射结果（matched=false 即显式未知留痕） */
  readonly natureMatched: boolean;
  /** 映射到的缺陷性质（全文件一致：一条漏洞一个 CWE） */
  readonly nature: string;
}

/** Vul4J 导出物 → defectRecord（纯函数；剥离测试后仅源码部分作 fixPatch） */
export function vul4jToDefectRecord(input: Vul4jExportInput): Result<DefectRecord> {
  const built = buildVul4jRecord(input);
  if (!built.ok) {
    return built;
  }
  return ok(built.value.record);
}

/** Vul4J 导出物 → MRCase（vul4jToDefectRecord → convertDefectRecord + extensions 留痕） */
export function vul4jToMrCase(
  input: Vul4jExportInput,
  options: { readonly repoPath: string },
): Result<MRCase> {
  const built = buildVul4jRecord(input);
  if (!built.ok) {
    return built;
  }
  const converted = convertDefectRecord(built.value.record, { repoPath: options.repoPath });
  if (!converted.ok) {
    return converted;
  }
  return ok({
    ...converted.value,
    extensions: buildExtensions(input, built.value),
  });
}

/** 批量转换：逐条校验与转换，失败项显式收集（不静默跳过） */
export function vul4jToMrCases(
  inputs: readonly Vul4jExportInput[],
  repoPathOf: (vulId: string) => string,
): { readonly cases: readonly MRCase[]; readonly failures: readonly { readonly vulId: string; readonly code: string; readonly message: string }[] } {
  const cases: MRCase[] = [];
  const failures: { vulId: string; code: string; message: string }[] = [];
  for (const input of inputs) {
    const converted = vul4jToMrCase(input, { repoPath: repoPathOf(input.vulId) });
    if (converted.ok) {
      cases.push(converted.value);
    } else {
      failures.push({ vulId: input.vulId, code: converted.error.code, message: converted.error.message });
    }
  }
  return { cases, failures };
}

function buildVul4jRecord(input: Vul4jExportInput): Result<Vul4jRecordTrace> {
  const shapeError = validateInputShape(input);
  if (shapeError !== undefined) {
    return err(shapeError);
  }
  const stripped = stripTestSections(input.fixDiff, input.testPathPrefixes ?? []);
  if (!stripped.ok) {
    return stripped;
  }
  const parsed = parseUnifiedDiff(stripped.value.srcDiff);
  if (!parsed.ok) {
    return err(new DatasetError("INVALID_FIX_PATCH", `源码补丁解析失败: ${parsed.error.message}`));
  }
  const resolution = resolveCweNature(input.cweId ?? "");
  const defectNatures: Record<string, string> = {};
  for (const file of parsed.value) {
    defectNatures[file.newPath ?? file.oldPath!] = resolution.nature;
  }
  const record: DefectRecord = {
    recordId: input.vulId,
    fixedSources: input.fixedSources,
    fixPatch: stripped.value.srcDiff,
    issueDescription:
      input.issueDescription ?? composeIssueDescription(input),
    defectNatures,
    source: VUL4J_SOURCE,
    riskClass: input.riskClass ?? VUL4J_DEFAULT_RISK_CLASS,
    ...(input.allowedConfigs === undefined ? {} : { allowedConfigs: input.allowedConfigs }),
  };
  // fail fast：源码补丁与 fixedSources 快照失配（路径缺失/上下文漂移）在此显式报错，
  // 而非延迟到 convertDefectRecord（vul4jToDefectRecord 同样得到保证）
  const validated = validateDefectRecord(record);
  if (!validated.ok) {
    return validated;
  }
  return ok({
    record,
    strip: stripped.value.trace,
    natureMatched: resolution.matched,
    nature: resolution.nature,
  });
}

function validateInputShape(input: Vul4jExportInput): DatasetError | undefined {
  if (typeof input.vulId !== "string" || !VUL_ID_RE.test(input.vulId)) {
    return new DatasetError("INVALID_INPUT", `vulId 必须形如 VUL4J-N 或 VUL4J-N-S，得到: ${JSON.stringify(input.vulId)}`);
  }
  if (typeof input.repoSlug !== "string" || input.repoSlug.trim() === "") {
    return new DatasetError("INVALID_INPUT", "repoSlug 必须为非空字符串");
  }
  if (
    typeof input.fixCommitUrl !== "string" ||
    (!COMMIT_URL_RE.test(input.fixCommitUrl) && !COMPARE_URL_RE.test(input.fixCommitUrl))
  ) {
    return new DatasetError("INVALID_INPUT", `fixCommitUrl 必须为 GitHub commit/compare URL，得到: ${JSON.stringify(input.fixCommitUrl)}`);
  }
  if (typeof input.fixDiff !== "string" || input.fixDiff.trim() === "") {
    return new DatasetError("INVALID_INPUT", "fixDiff 必须为非空字符串");
  }
  if (input.fixedSources === undefined || input.fixedSources === null || Object.keys(input.fixedSources).length === 0) {
    return new DatasetError("INVALID_INPUT", "fixedSources 必须为非空快照");
  }
  if (input.issueDescription !== undefined && typeof input.issueDescription !== "string") {
    return new DatasetError("INVALID_INPUT", "issueDescription 必须为字符串（允许空串）");
  }
  if (input.testPathPrefixes !== undefined && (!Array.isArray(input.testPathPrefixes) || input.testPathPrefixes.some((p) => typeof p !== "string" || p.trim() === ""))) {
    return new DatasetError("INVALID_INPUT", "testPathPrefixes 必须为非空前缀字符串数组");
  }
  return undefined;
}

/** 缺省 issue 描述：由 CVE/CWE 元数据确定性拼装（Vul4J 不随数据集分发 issue 正文） */
function composeIssueDescription(input: Vul4jExportInput): string {
  const hasCve = /^CVE-/.test(input.cveId ?? "");
  const hasCwe = /^CWE-\d+$/.test(input.cweId ?? "");
  const label = hasCve && hasCwe
    ? `Vulnerability ${input.cveId} (${input.cweId}: ${input.cweName ?? "see CVE entry"}) in ${input.repoSlug}.`
    : hasCve
      ? `Vulnerability ${input.cveId} in ${input.repoSlug}.`
      : hasCwe
        ? `Vulnerability (${input.cweId}: ${input.cweName ?? "see CWE entry"}) in ${input.repoSlug}.`
        : `Security vulnerability in ${input.repoSlug}.`;
  const fixedBy = `Fixed by ${input.fixCommitUrl}.`;
  const pov = input.failingTests !== undefined && input.failingTests.trim() !== ""
    ? ` Proof-of-vulnerability test: ${input.failingTests}.`
    : "";
  return `${label} ${fixedBy}${pov}`;
}

function buildExtensions(input: Vul4jExportInput, trace: Vul4jRecordTrace): Readonly<Record<string, string>> {
  const extensions: Record<string, string> = {
    vulId: input.vulId,
    repoSlug: input.repoSlug,
    fixCommitUrl: input.fixCommitUrl,
    fixSha: extractFixSha(input.fixCommitUrl),
    nature: trace.nature,
    natureMatched: String(trace.natureMatched),
  };
  if ((input.cveId ?? "").trim() !== "") {
    extensions.cveId = input.cveId!;
  }
  if ((input.cweId ?? "").trim() !== "") {
    extensions.cweId = input.cweId!;
  }
  if ((input.cweName ?? "").trim() !== "") {
    extensions.cweName = input.cweName!;
  }
  if ((input.owaspId ?? "").trim() !== "") {
    extensions.owaspId = input.owaspId!;
  }
  if (trace.strip.excludedTestFiles.length > 0) {
    extensions.excludedTestFiles = trace.strip.excludedTestFiles.join(",");
  }
  if (trace.strip.excludedBinaryFiles.length > 0) {
    extensions.excludedBinaryFiles = trace.strip.excludedBinaryFiles.join(",");
  }
  return extensions;
}

/** 从 commit/compare URL 提取修复侧 SHA（compare 取 `..` 右侧 head） */
export function extractFixSha(url: string): string {
  const compare = COMPARE_URL_RE.exec(url);
  if (compare !== null) {
    return compare[4]!;
  }
  const commit = COMMIT_URL_RE.exec(url);
  return commit?.[3] ?? "";
}

/** 剥离结果：源码 diff + 留痕 */
export interface StrippedDiff {
  readonly srcDiff: string;
  readonly trace: StripTrace;
}

/**
 * 按 `diff --git` 节剥离修复 commit diff 中的测试与二进制文件（纯函数）。
 *
 * 判定规则（测试优先于二进制）：
 * - 测试：路径命中 testPathPrefixes 之一，或路径段（"/" 分隔）恰为 "test"/"tests"
 *   （Maven/Gradle 约定，覆盖 Vul4J 全部 9+ 仓库布局，实测核验）；
 * - 二进制：节内含 `Binary files`/`GIT binary patch` 行（parseUnifiedDiff
 *   不支持二进制，保留会显式报错，故剥离并留痕）。
 * 全部节被剥离时显式报错（NO_SOURCE_FILES），不产出空补丁。
 */
export function stripTestSections(
  diffText: string,
  testPathPrefixes: readonly string[],
): Result<StrippedDiff> {
  const sections = splitDiffSections(diffText);
  if (sections.length === 0) {
    return err(new DatasetError("INVALID_FIX_DIFF", "diff 不含任何 `diff --git` 文件节"));
  }
  const excludedTestFiles: string[] = [];
  const excludedBinaryFiles: string[] = [];
  const srcSections: string[] = [];
  for (const section of sections) {
    const path = sectionTargetPath(section.text);
    if (path !== null && isTestPath(path, testPathPrefixes)) {
      excludedTestFiles.push(path);
      continue;
    }
    if (/^(Binary files|GIT binary patch)/m.test(section.text)) {
      excludedBinaryFiles.push(path ?? "(unknown)");
      continue;
    }
    srcSections.push(section.text);
  }
  if (srcSections.length === 0) {
    return err(
      new DatasetError(
        "NO_SOURCE_FILES",
        `修复 commit diff 全部为测试/二进制文件，无源码变更（测试: ${excludedTestFiles.join(", ")}；二进制: ${excludedBinaryFiles.join(", ")}）`,
      ),
    );
  }
  return ok({
    srcDiff: srcSections.join(""),
    trace: { excludedTestFiles, excludedBinaryFiles },
  });
}

interface DiffSection {
  readonly text: string;
}

/** 按行首 `diff --git ` 切分文件节（保持原文逐字节；lookbehind 使每片以 \n 结尾） */
function splitDiffSections(diffText: string): DiffSection[] {
  const lines = diffText.split(/(?<=\n)/);
  const sections: DiffSection[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current !== null) {
        sections.push({ text: current.join("") });
      }
      current = [line];
      continue;
    }
    if (current !== null) {
      current.push(line);
    }
  }
  if (current !== null) {
    sections.push({ text: current.join("") });
  }
  return sections;
}

/** 取文件节的目标路径：优先 +++ 头（含空格路径也精确），退回 diff --git 头的 b/ 侧 */
function sectionTargetPath(sectionText: string): string | null {
  const lines = sectionText.split("\n");
  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4).split("\t")[0]!.trim();
      if (raw !== "/dev/null" && raw !== "") {
        return raw.startsWith("b/") ? raw.slice(2) : raw;
      }
      break;
    }
  }
  const header = lines.find((line) => line.startsWith("diff --git "));
  if (header === undefined) {
    return null;
  }
  const match = /^diff --git a\/.+ b\/(.+)$/.exec(header);
  return match === null ? null : match[1]!.trim();
}

/** 测试路径判定：显式前缀命中，或路径段恰为 test/tests（启发式，实测覆盖全部布局） */
export function isTestPath(path: string, testPathPrefixes: readonly string[]): boolean {
  if (testPathPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix.replace(/\/+$/, "")}/`))) {
    return true;
  }
  const segments = path.split("/");
  return segments.includes("test") || segments.includes("tests");
}
