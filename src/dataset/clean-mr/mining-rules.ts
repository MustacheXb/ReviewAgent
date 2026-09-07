import type { GithubPullRequest } from "./pr-records.js";

/**
 * clean MR 挖掘规则（Ticket 09，纯函数、零网络）。
 *
 * 核心三规则（工单验收口径）：merged ∧ 无 issue 关联 ∧ 未被 revert。
 * 其中「无 issue 关联」的判定逐字复刻 Multi-SWE-bench 官方 collect 管线
 * `filter_prs.py` 的 `extract_resolved_issues`（见文件内注释），保证与
 * MSB 正例同口径：正例 = 该规则判定为关联的 PR，阴性对照 = 该规则判定为
 * 不关联的 merged PR——两侧互补、同分布。
 *
 * 附加显式规则（默认开启，均可配置关闭）：
 * - revert 双向排除：PR 本身是 revert（标题/正文/提交消息含 revert 词），以及
 *   PR 被更晚的 revert PR 引用（`Reverts org/repo#N` 等）；
 * - 依赖 bump 排除：diff 触碰的全部文件都是依赖清单（纯机械变更，工单标注可选）；
 * - Java 文件要求：diff 至少触碰一个 *.java（spec「检视对象：Java 单语言」）。
 */

/** issue 关联判定的输入（与 MSB filter_prs.py 扫描的字段一致） */
export interface IssueLinkInput {
  readonly title: string;
  readonly body: string | null;
  readonly commitMessages: readonly string[];
}

/**
 * MSB filter_prs.py 原文正则与词表（逐字对齐）：
 * - `issues_pat = re.compile(r"(\w+)\s+\#(\d+)")`
 * - keywords = close/closes/closed/fix/fixes/fixed/resolve/resolves/resolved
 * - 先剥 HTML 注释 `(?s)<!--.*?-->`，再扫 title + body + commit messages 拼接文本
 * 已知口径差异（记录于 manifest rules 块）：Python `\w` 含 Unicode 字母，
 * JS `\w` 仅 ASCII；对本词表判定结果无影响（关键词均为 ASCII）。
 */
const ISSUE_REF_RE = /(\w+)\s+#(\d+)/g;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const ISSUE_LINK_KEYWORDS: ReadonlySet<string> = new Set([
  "close",
  "closes",
  "closed",
  "fix",
  "fixes",
  "fixed",
  "resolve",
  "resolves",
  "resolved",
]);

const REVERT_WORD_RE = /\brevert(?:s|ed|ing)?\b/i;
/**
 * revert 引用提取：revert 词后 40 个非换行字符内的 `#N`
 * （覆盖 `Reverts org/repo#N` 自动正文、`revert #45`、`Revert PR #123` 等形态；
 * 宁可多排除（保守），见文件头注释——被排除的 PR 不进入阴性对照集）
 */
const REVERTS_REF_RE = /\brevert(?:s|ed|ing)?\b[^\n]{0,40}?#(\d+)/gi;

/** 依赖清单文件基名（Maven/Gradle/npm/Go 等主流生态；本仓库群为 Maven/Gradle） */
const DEPENDENCY_MANIFEST_BASENAMES: ReadonlySet<string> = new Set([
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.properties",
  "gradle-wrapper.properties",
  "libs.versions.toml",
  "versions.toml",
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "go.mod",
  "go.sum",
  "maven-wrapper.properties",
]);

const JAVA_FILE_RE = /\.java$/i;

/** merged 判定：merged_at 非 null（GitHub REST API 语义，与官方 get_all_prs.py 一致） */
export function isMergedPr(pr: Pick<GithubPullRequest, "mergedAt">): boolean {
  return pr.mergedAt !== null;
}

/**
 * 提取 PR 关联的 issue 号（MSB filter_prs.py `extract_resolved_issues` 的忠实移植）。
 *
 * 口径细节（与原实现逐条对齐）：
 * - 扫描文本 = title + "\n" + body(空则 "") + "\n" + commit messages 逐条 "\n" 拼接；
 * - 先剥 HTML 注释再匹配（`<!-- fixes #1 -->` 不算关联）；
 * - 同一关键词多次出现只保留最后一次的编号（Python `dict(findall)` 语义）；
 * - 编号 0 被剔除（`fix #0` 视为无关联，原实现同款行为）。
 * 返回升序去重编号列表（原实现返回集合，仅成员资格参与本管线判定）。
 */
export function extractResolvedIssues(input: IssueLinkInput): readonly number[] {
  const parts: string[] = [input.title, input.body ?? "", ...input.commitMessages];
  const text = parts.join("\n").replace(HTML_COMMENT_RE, "");
  // Python dict(findall)：同词后写覆盖前写，且保留首次插入位置
  const references = new Map<string, string>();
  for (const match of text.matchAll(ISSUE_REF_RE)) {
    references.set(match[1]!, match[2]!);
  }
  const resolved = new Set<number>();
  for (const [word, issueNum] of references) {
    if (ISSUE_LINK_KEYWORDS.has(word.toLowerCase())) {
      resolved.add(Number(issueNum));
    }
  }
  resolved.delete(0);
  return [...resolved].sort((a, b) => a - b);
}

/** 是否被判定为 issue 关联 PR（MSB 正例的入选条件；阴性对照要求为 false） */
export function hasIssueLink(input: IssueLinkInput): boolean {
  return extractResolvedIssues(input).length > 0;
}

/** 是否为 issue 关联输入的便捷构造 */
export function issueLinkInputOf(
  pr: Pick<GithubPullRequest, "title" | "body">,
  commitMessages: readonly string[],
): IssueLinkInput {
  return { title: pr.title, body: pr.body, commitMessages };
}

/** PR 本身是否为 revert（标题/正文/任一提交消息含 revert 词；保守排除口径） */
export function isRevertPr(input: IssueLinkInput): boolean {
  const texts = [input.title, input.body ?? "", ...input.commitMessages];
  return texts.some((text) => REVERT_WORD_RE.test(text));
}

/**
 * 从一批已列举的 PR（标题+正文）提取「被 revert 引用的 PR 号」集合。
 * 依据：GitHub 自动 revert PR 正文含 `Reverts org/repo#N`；人工 revert 常见
 * `Revert #N` / `Revert PR #N` 形态。命中即视为该 PR 曾被撤销 → 排除出阴性对照
 * （被撤销的 clean MR 社区已判定有问题，混入会低估 FP）。
 * 已知限制（写入 manifest rules 块）：仅覆盖已列举页范围内的 revert PR；
 * 仍处于 open 状态的 revert PR 不在 `state=closed` 列表内，会漏检（罕见）。
 */
export function collectRevertedPrNumbers(
  prs: readonly Pick<GithubPullRequest, "title" | "body">[],
): ReadonlySet<number> {
  const reverted = new Set<number>();
  for (const pr of prs) {
    const text = `${pr.title}\n${pr.body ?? ""}`;
    for (const match of text.matchAll(REVERTS_REF_RE)) {
      const referenced = Number(match[1]);
      if (Number.isInteger(referenced) && referenced > 0) {
        reverted.add(referenced);
      }
    }
  }
  return reverted;
}

/** diff 触碰的文件路径列表是否全部为依赖清单（依赖 bump = 纯机械变更） */
export function isDependencyOnlyPaths(paths: readonly string[]): boolean {
  if (paths.length === 0) {
    return false;
  }
  return paths.every((path) => DEPENDENCY_MANIFEST_BASENAMES.has(basename(path)));
}

/** 路径列表中是否至少含一个 Java 源文件（spec：检视对象为 Java 单语言） */
export function containsJavaFile(paths: readonly string[]): boolean {
  return paths.some((path) => JAVA_FILE_RE.test(path));
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

/** 供 manifest / 文档引用的规则描述（机器可读的显式化；键与 CleanMrManifestRules 对齐） */
export const MINING_RULES_DESCRIPTION = Object.freeze({
  merged: "merged_at != null (GitHub REST semantics)",
  issueLink:
    "ported verbatim from Multi-SWE-bench collect/filter_prs.py extract_resolved_issues: strip <!--...--> comments, scan title + body + commit messages for /(\\w+)\\s+#(\\d+)/, keyword in {close(s|d), fix(es|ed), resolve(s|d)} (case-insensitive), same-word later reference wins, issue 0 dropped",
  revertPr: "title, body or any commit message matches /\\brevert(s|ed|ing)?\\b/i",
  revertedByLaterPr:
    "PR number referenced by a revert mention (revert word within 40 chars before #N) in any scanned closed PR's title/body; conservative over-exclusion",
  dependencyBump: "every touched file is a dependency manifest (pom.xml, build.gradle, gradle.properties, package.json, ...)",
  javaFile: "at least one touched file ends with .java (spec: Java single language)",
});
