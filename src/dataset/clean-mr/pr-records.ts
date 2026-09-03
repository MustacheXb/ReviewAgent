import { type Result, DatasetError, err, ok } from "../diff/types.js";

/**
 * GitHub PR 数据模型（Ticket 09 采集管线的输入端）。
 *
 * 字段与 Multi-SWE-bench 官方 collect 管线 `get_all_prs.py` 采集的字段对齐
 * （number / state / title / body / created_at / merged_at / merge_commit_sha /
 * labels / draft / html_url / base），仅收敛为本管线消费的子集。
 * 解析自 GitHub REST API `GET /repos/{org}/{repo}/pulls` 列表响应条目。
 */
export interface GithubPullRequest {
  readonly number: number;
  readonly title: string;
  /** PR 正文（可为 null：无正文的 PR） */
  readonly body: string | null;
  /** "open" | "closed" */
  readonly state: string;
  readonly draft: boolean;
  readonly createdAt: string;
  /** merged 判定的唯一口径：非 null 即 merged（官方 get_all_prs.py 同款字段） */
  readonly mergedAt: string | null;
  readonly mergeCommitSha: string | null;
  readonly htmlUrl: string;
  /** PR 目标分支（base.ref，如 "main"） */
  readonly baseRef: string;
  /** PR 列表响应中的 base.sha（合并时基线分支的提交） */
  readonly baseSha: string;
  /** PR 标签名列表 */
  readonly labels: readonly string[];
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
/** sha1（40 位）或 sha256（64 位）提交号 */
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** 从 GitHub pulls 列表响应条目解析（纯函数；畸形条目显式报错，不静默跳过） */
export function parsePullRequestItem(raw: unknown, index: number): Result<GithubPullRequest> {
  const where = `pulls[${index}]`;
  if (typeof raw !== "object" || raw === null) {
    return err(new DatasetError("INVALID_INPUT", `${where} 必须为对象`));
  }
  const item = raw as Record<string, unknown>;
  const numberOk = requirePositiveInt(item.number, `${where}.number`);
  if (numberOk !== undefined) {
    return err(numberOk);
  }
  const titleOk = requireString(item.title, `${where}.title`, false);
  if (titleOk !== undefined) {
    return err(titleOk);
  }
  if (item.body !== null && typeof item.body !== "string") {
    return err(new DatasetError("INVALID_INPUT", `${where}.body 必须为字符串或 null`));
  }
  const stateOk = requireString(item.state, `${where}.state`, false);
  if (stateOk !== undefined) {
    return err(stateOk);
  }
  if (typeof item.draft !== "boolean") {
    return err(new DatasetError("INVALID_INPUT", `${where}.draft 必须为布尔值`));
  }
  const mergedAt = parseNullableIsoDate(item.merged_at, `${where}.merged_at`);
  if (mergedAt instanceof DatasetError) {
    return err(mergedAt);
  }
  const createdAt = parseIsoDate(item.created_at, `${where}.created_at`);
  if (createdAt instanceof DatasetError) {
    return err(createdAt);
  }
  const mergeCommitSha = parseNullableSha(item.merge_commit_sha, `${where}.merge_commit_sha`);
  if (mergeCommitSha instanceof DatasetError) {
    return err(mergeCommitSha);
  }
  const htmlUrlOk = requireString(item.html_url, `${where}.html_url`, false);
  if (htmlUrlOk !== undefined) {
    return err(htmlUrlOk);
  }
  const base = item.base;
  if (typeof base !== "object" || base === null) {
    return err(new DatasetError("INVALID_INPUT", `${where}.base 必须为对象`));
  }
  const baseObj = base as Record<string, unknown>;
  const baseRefOk = requireString(baseObj.ref, `${where}.base.ref`, false);
  if (baseRefOk !== undefined) {
    return err(baseRefOk);
  }
  const baseSha = parseSha(baseObj.sha, `${where}.base.sha`);
  if (baseSha instanceof DatasetError) {
    return err(baseSha);
  }
  const labels = parseLabelNames(item.labels, `${where}.labels`);
  if (labels instanceof DatasetError) {
    return err(labels);
  }
  return ok({
    number: item.number as number,
    title: item.title as string,
    body: (item.body as string | null) ?? null,
    state: item.state as string,
    draft: item.draft as boolean,
    createdAt,
    mergedAt,
    mergeCommitSha,
    htmlUrl: item.html_url as string,
    baseRef: baseObj.ref as string,
    baseSha,
    labels,
  });
}

/** 解析整页列表响应（保持顺序；逐条校验） */
export function parsePullRequestList(raw: unknown): Result<readonly GithubPullRequest[]> {
  if (!Array.isArray(raw)) {
    return err(new DatasetError("INVALID_INPUT", "pulls 列表响应必须为数组"));
  }
  const out: GithubPullRequest[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const parsed = parsePullRequestItem(raw[i], i);
    if (!parsed.ok) {
      return parsed;
    }
    out.push(parsed.value);
  }
  return ok(out);
}

/**
 * 从 GitHub `GET /repos/{org}/{repo}/pulls/{n}/commits` 响应提取提交消息列表。
 * 与 MSB filter_prs.py 一致：commit message 参与 issue 关联与 revert 判定。
 */
export function parseCommitMessages(raw: unknown): Result<readonly string[]> {
  if (!Array.isArray(raw)) {
    return err(new DatasetError("INVALID_INPUT", "commits 响应必须为数组"));
  }
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (typeof item !== "object" || item === null) {
      return err(new DatasetError("INVALID_INPUT", `commits[${i}] 必须为对象`));
    }
    const commit = (item as Record<string, unknown>).commit;
    if (typeof commit !== "object" || commit === null) {
      return err(new DatasetError("INVALID_INPUT", `commits[${i}].commit 必须为对象`));
    }
    const message = (commit as Record<string, unknown>).message;
    if (typeof message !== "string") {
      return err(new DatasetError("INVALID_INPUT", `commits[${i}].commit.message 必须为字符串`));
    }
    out.push(message);
  }
  return ok(out);
}

function requireString(value: unknown, field: string, allowEmpty: boolean): DatasetError | undefined {
  if (typeof value !== "string" || (!allowEmpty && value === "")) {
    return new DatasetError("INVALID_INPUT", `${field} 必须为非空字符串`);
  }
  return undefined;
}

function requirePositiveInt(value: unknown, field: string): DatasetError | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return new DatasetError("INVALID_INPUT", `${field} 必须为 ≥1 的整数`);
  }
  return undefined;
}

function parseIsoDate(value: unknown, field: string): string | DatasetError {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) {
    return new DatasetError("INVALID_INPUT", `${field} 必须为 ISO 8601 UTC 时间戳`);
  }
  return value;
}

function parseNullableIsoDate(value: unknown, field: string): string | null | DatasetError {
  if (value === null) {
    return null;
  }
  return parseIsoDate(value, field);
}

function parseSha(value: unknown, field: string): string | DatasetError {
  if (typeof value !== "string" || !SHA_RE.test(value)) {
    return new DatasetError("INVALID_INPUT", `${field} 必须为 40 位十六进制 commit sha`);
  }
  return value;
}

function parseNullableSha(value: unknown, field: string): string | null | DatasetError {
  if (value === null) {
    return null;
  }
  return parseSha(value, field);
}

function parseLabelNames(value: unknown, field: string): readonly string[] | DatasetError {
  if (!Array.isArray(value)) {
    return new DatasetError("INVALID_INPUT", `${field} 必须为数组`);
  }
  const names: string[] = [];
  for (const label of value) {
    if (typeof label !== "object" || label === null || typeof (label as Record<string, unknown>).name !== "string") {
      return new DatasetError("INVALID_INPUT", `${field} 的标签项必须含字符串 name`);
    }
    names.push((label as Record<string, unknown>).name as string);
  }
  return names;
}
