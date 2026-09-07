import type { ConfigId } from "../contracts/config.js";
import type { RiskClass } from "./risk-class.js";
import { type SourceSnapshot } from "./diff/apply-unified-diff.js";
import { type Result, DatasetError, err, ok } from "./diff/types.js";
import { parseUnifiedDiff } from "./diff/parse-unified-diff.js";
import { isDefectNature } from "./defect-nature.js";

/**
 * defectRecord 输入 schema（Ticket 02 的输入契约）。
 *
 * 逆补丁法的最小输入三件套：修复后源码快照 + 最小修复补丁 + issue 描述。
 * - fixedSources：修复后（fixed）版本的仓库相对路径 → 文件内容
 *   （Defects4J 场景：对裸仓库 `git archive <revision.id.fixed>` 的导出物）；
 * - fixPatch：buggy → fixed 的 unified diff（路径与 fixedSources 键一致；
 *   Defects4J 场景：`framework/projects/<PID>/patches/<bid>.src.patch` 本身是
 *   fixed→buggy 方向，适配层先求反——见 defects4j/adapter.ts）；
 * - issueDescription：issue/bug 报告描述。Defects4J 不随仓库分发 issue 正文
 *   （active-bugs.csv 仅含 report.id / report.url），故允许为空串或占位，
 *   由数据集构造方按降级预案填充（如 trigger 失败堆栈 / patch 上下文）。
 */
export interface DefectRecord {
  /** 记录 ID（如 "Lang-1"），成为 MRCase.caseId */
  readonly recordId: string;
  /** 修复后版本源码快照（至少覆盖 fixPatch 触碰的全部文件） */
  readonly fixedSources: SourceSnapshot;
  /** 最小修复补丁：buggy → fixed 的 unified diff */
  readonly fixPatch: string;
  /** issue / bug 报告描述（可为空串；见文件头说明） */
  readonly issueDescription?: string;
  /** 缺陷报告链接（如 Defects4J active-bugs.csv 的 report.url；供数据集构造方后续抓取） */
  readonly reportUrl?: string;
  /** 文件 → 缺陷性质（词表见 defect-nature.ts）；缺省 CORRECTNESS */
  readonly defectNatures?: Readonly<Record<string, string>>;
  /** buggy 版本源码快照（可选；提供时用于逆补丁语义的直接断言） */
  readonly buggySources?: SourceSnapshot;
  /** 数据来源标签（MRCase.labels.source 的缺省） */
  readonly source?: string;
  /** 风险分级缺省（MRCase.labels.riskClass 的缺省） */
  readonly riskClass?: RiskClass;
  /** 允许跑的配置缺省（MRCase.labels.allowedConfigs 的缺省） */
  readonly allowedConfigs?: readonly ConfigId[];
}

const PATH_FORBIDDEN = [/^\//, /\\/, /(^|\/)\.\.(\/|$)/, /(^|\/)\.(\/|$)/];

/**
 * 校验 defectRecord 输入（边界校验：ID、路径合法性、patch 可解析且与快照一致、词表合法）。
 * 纯函数；不修改输入。
 */
export function validateDefectRecord(record: DefectRecord): Result<DefectRecord> {
  if (typeof record.recordId !== "string" || record.recordId.trim() === "") {
    return err(new DatasetError("INVALID_RECORD", "recordId 必须为非空字符串"));
  }
  const sourcesError = validateSnapshot(record.fixedSources, "fixedSources");
  if (sourcesError !== undefined) {
    return err(sourcesError);
  }
  if (record.buggySources !== undefined) {
    const buggyError = validateSnapshot(record.buggySources, "buggySources");
    if (buggyError !== undefined) {
      return err(buggyError);
    }
  }
  if (record.issueDescription !== undefined && typeof record.issueDescription !== "string") {
    return err(new DatasetError("INVALID_RECORD", "issueDescription 必须为字符串（允许空串，见 schema 说明）"));
  }
  if (record.reportUrl !== undefined && typeof record.reportUrl !== "string") {
    return err(new DatasetError("INVALID_RECORD", "reportUrl 必须为字符串"));
  }
  const patchCheck = validatePatchAgainstSources(record);
  if (!patchCheck.ok) {
    return patchCheck;
  }
  const naturesError = validateNatures(record.defectNatures);
  if (naturesError !== undefined) {
    return err(naturesError);
  }
  return ok(record);
}

function validateSnapshot(
  snapshot: SourceSnapshot,
  label: string,
): DatasetError | undefined {
  if (snapshot === undefined || snapshot === null || typeof snapshot !== "object") {
    return new DatasetError("INVALID_RECORD", `${label} 必须为路径到内容的对象`);
  }
  const entries = Object.entries(snapshot);
  if (entries.length === 0) {
    return new DatasetError("INVALID_RECORD", `${label} 不能为空`);
  }
  for (const [path, content] of entries) {
    if (path.trim() === "" || PATH_FORBIDDEN.some((re) => re.test(path))) {
      return new DatasetError("INVALID_RECORD", `${label} 含非法路径: ${path}`);
    }
    if (typeof content !== "string") {
      return new DatasetError("INVALID_RECORD", `${label}[${path}] 内容必须为字符串`);
    }
  }
  return undefined;
}

/**
 * 校验 fixPatch：可解析、无重命名、修改/创建文件的目标路径存在于 fixedSources
 * （删除文件按定义不在修复后快照中）。
 */
function validatePatchAgainstSources(record: DefectRecord): Result<true> {
  const parsed = parseUnifiedDiff(record.fixPatch);
  if (!parsed.ok) {
    return err(new DatasetError("INVALID_FIX_PATCH", `fixPatch 解析失败: ${parsed.error.message}`));
  }
  for (const file of parsed.value) {
    if (file.oldPath !== null && file.newPath !== null && file.oldPath !== file.newPath) {
      return err(
        new DatasetError("INVALID_FIX_PATCH", `fixPatch 含重命名（${file.oldPath} → ${file.newPath}），逆补丁法不支持`),
      );
    }
    const target = file.newPath;
    if (target !== null && record.fixedSources[target] === undefined) {
      return err(
        new DatasetError("INVALID_FIX_PATCH", `fixPatch 触碰的文件 ${target} 不在 fixedSources 中`),
      );
    }
  }
  return ok(true);
}

function validateNatures(
  natures: Readonly<Record<string, string>> | undefined,
): DatasetError | undefined {
  if (natures === undefined) {
    return undefined;
  }
  for (const [file, nature] of Object.entries(natures)) {
    if (!isDefectNature(nature)) {
      return new DatasetError("INVALID_NATURE", `文件 ${file} 的缺陷性质 ${JSON.stringify(nature)} 不在词表内`);
    }
  }
  return undefined;
}
