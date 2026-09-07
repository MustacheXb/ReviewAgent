/**
 * clean MR 阴性对照集采集管线（Ticket 09 / issue #10）。
 *
 * 从 Multi-SWE-bench 同 9 个 Java 仓库采集：merged ∧ 无 issue 关联（MSB 口径）∧
 * 非 revert（含被更晚 revert 引用）∧ 非依赖 bump ∧ 含 Java 文件 ∧ MR 边界
 * （≤10 文件 / ≤2000 变更行），每仓配额选取，产出：
 *   data/clean-mr/manifest.json   —— 目标清单（规则显式、FP 口径、A vs C 对比元数据）
 *   data/clean-mr/diffs/*.diff    —— 每 case 的 PR diff
 *   data/clean-mr/.cache/         —— API 快照缓存（gitignore；断点续采 = 重跑即续）
 *
 * 运行（与 T02 脚本同一编译模式，需 gh CLI 已认证；测试不经过本脚本，零网络）：
 *   pnpm exec tsc --module NodeNext --moduleResolution NodeNext --target ES2023 \
 *     --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --skipLibCheck \
 *     --outDir .tmp-gen scripts/collect-clean-mrs.ts
 *   node .tmp-gen/scripts/collect-clean-mrs.js && rm -rf .tmp-gen
 *
 * 参数（下方常量，全部显式）：
 *   - 仓库清单 = src/dataset/clean-mr/repos.ts（MSB Java 子集同 9 仓）
 *   - PER_REPO_QUOTA / TARGET_TOTAL：每仓配额与全局目标（~50）
 *   - MATERIALIZE_MARGIN：每仓超额抓取余量（吸收全量评估淘汰）
 *   - MAX_PAGES_PER_REPO / MAX_TOTAL_API_CALLS：有界 API 调用
 * 断点续采：已抓取的页/commits/diff 落缓存，重跑只补缺口；缓存为首次抓取的
 * 快照（分页内容不随重跑漂移），删除 .cache 可重新快照。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MSB_JAVA_REPOS, repoSlug } from "../src/dataset/clean-mr/repos.js";
import {
  parseCommitMessages,
  parsePullRequestList,
  type GithubPullRequest,
} from "../src/dataset/clean-mr/pr-records.js";
import {
  extractResolvedIssues,
  collectRevertedPrNumbers,
  isRevertPr,
  issueLinkInputOf,
} from "../src/dataset/clean-mr/mining-rules.js";
import {
  DEFAULT_CLEAN_MR_RULES,
  evaluateCleanMrCandidate,
  selectCleanMrCases,
  type CleanMrCandidate,
  type RepoCandidateScan,
} from "../src/dataset/clean-mr/selection.js";
import { DEFAULT_MR_BOUNDARY } from "../src/dataset/mr-boundary-filter.js";
import {
  buildCleanMrManifest,
  type ManifestCaseInput,
} from "../src/dataset/clean-mr/manifest.js";
import { buildCleanMrCaseId } from "../src/dataset/clean-mr/builder.js";

const TARGET_TOTAL = 50;
const PER_REPO_QUOTA = 6;
const SPILL_PER_REPO = 4;
/**
 * 每仓全量抓取的通过数停止点（配额 + 补位余量）与硬上限：
 * 通过数达到 quota+spill 即停（节省 API）；不足则抓到 MAX_MATERIALIZE 硬上限。
 * 实测淘汰率（issue 关联/依赖 bump/无 Java/超边界）最高 100%（logstash 现役
 * PR 以 JRuby 为主、jib 以 dependabot 为主），硬上限取 ~4 倍停止点兜底。
 */
const MATERIALIZE_STOP_AT_ACCEPTED = PER_REPO_QUOTA + SPILL_PER_REPO;
const MAX_MATERIALIZE_PER_REPO = 80;
const MAX_PAGES_PER_REPO = 10;
const MAX_TOTAL_API_CALLS = 1500;
const DATA_DIR = resolve("data/clean-mr");
const CACHE_DIR = resolve(DATA_DIR, ".cache");
const SCAN_DESC = "GET /repos/{org}/{repo}/pulls?state=closed&sort=created&direction=desc&per_page=100 (newest first)";

let apiCalls = 0;

function ghApi(endpoint: string, accept?: string): string {
  if (apiCalls >= MAX_TOTAL_API_CALLS) {
    throw new Error(`API 调用预算耗尽（${MAX_TOTAL_API_CALLS}）：缓存已保留，直接重跑续采`);
  }
  const args = ["api", endpoint, ...(accept === undefined ? [] : ["-H", `Accept: ${accept}`])];
  const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined) {
    throw new Error(`gh CLI 调用失败（${endpoint}）: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`gh api 失败（${result.status}，${endpoint}）: ${trim(result.stderr)}`);
  }
  apiCalls += 1;
  return result.stdout;
}

function trim(text: string): string {
  return text.trim().split("\n").slice(-3).join(" | ");
}

/** 有缓存的 API GET（缓存命中不耗预算；返回 null 表示缓存未命中） */
function cachedFetch(cacheFile: string, fetcher: () => string): string {
  if (existsSync(cacheFile)) {
    return readFileSync(cacheFile, "utf8");
  }
  const body = fetcher();
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, body, "utf8");
  return body;
}

interface RepoScanOutcome {
  readonly org: string;
  readonly repo: string;
  readonly scannedPrs: readonly GithubPullRequest[];
  readonly candidates: readonly CleanMrCandidate[];
  /** diff 超大（gh 拒发，>300 文件）被跳过的 PR 数——事实性归入 too-many-files */
  readonly skippedHugeDiff: number;
}

function collectRepo(org: string, repo: string): RepoScanOutcome {
  const cacheDir = resolve(CACHE_DIR, `${org}__${repo}`);
  const scanned: GithubPullRequest[] = [];
  const seenNumbers = new Set<number>();
  const candidates: CleanMrCandidate[] = [];
  const revertedSoFar = new Set<number>();
  let acceptedSoFar = 0;
  let skippedHugeDiff = 0;

  for (let page = 1; page <= MAX_PAGES_PER_REPO; page += 1) {
    const rawPage = cachedFetch(resolve(cacheDir, `page-${page}.json`), () =>
      ghApi(`repos/${org}/${repo}/pulls?state=closed&sort=created&direction=desc&per_page=100&page=${page}`),
    );
    const parsed = parsePullRequestList(JSON.parse(rawPage));
    if (!parsed.ok) {
      throw new Error(`${org}/${repo} 第 ${page} 页解析失败: ${parsed.error.message}`);
    }
    const prs = parsed.value;
    if (prs.length === 0) {
      break;
    }
    const pageNumbers = new Set<number>();
    for (const pr of prs) {
      if (seenNumbers.has(pr.number)) {
        continue;
      }
      seenNumbers.add(pr.number);
      pageNumbers.add(pr.number);
      scanned.push(pr);
      for (const referenced of collectRevertedPrNumbers([pr])) {
        revertedSoFar.add(referenced);
      }
    }
    console.log(`  page ${page}: ${pageNumbers.size} 个新 closed PR（累计 ${scanned.length}）`);

    for (const pr of prs) {
      if (acceptedSoFar >= MATERIALIZE_STOP_AT_ACCEPTED || candidates.length >= MAX_MATERIALIZE_PER_REPO) {
        break;
      }
      if (!pageNumbers.has(pr.number) || !passesCheapCheck(pr)) {
        continue;
      }
      const commitMessages = fetchCommitMessages(cacheDir, org, repo, pr.number);
      let diff: string;
      try {
        diff = fetchDiff(cacheDir, org, repo, pr.number);
      } catch (error) {
        if (isHugeDiffError(error)) {
          // diff >300 文件：gh 拒发（HTTP 406）。该 PR 事实性超出 MR 边界
          // （≤10 文件），跳过并入 too-many-files 统计（不落缓存，重跑重判）。
          skippedHugeDiff += 1;
          continue;
        }
        throw error;
      }
      const candidate: CleanMrCandidate = { pr, commitMessages, diff };
      candidates.push(candidate);
      const evaluation = evaluateCleanMrCandidate(
        candidate,
        revertedSoFar,
        DEFAULT_CLEAN_MR_RULES,
        DEFAULT_MR_BOUNDARY,
      );
      if (evaluation.accepted) {
        acceptedSoFar += 1;
      }
    }
    if (acceptedSoFar >= MATERIALIZE_STOP_AT_ACCEPTED) {
      console.log(`  通过规则链 ${acceptedSoFar} 条 ≥ 停止点 ${MATERIALIZE_STOP_AT_ACCEPTED}，停止翻页`);
      break;
    }
    if (candidates.length >= MAX_MATERIALIZE_PER_REPO) {
      console.log(`  全量材料达上限 ${MAX_MATERIALIZE_PER_REPO} 条（通过 ${acceptedSoFar}），停止翻页`);
      break;
    }
    if (prs.length < 100) {
      break;
    }
  }
  return { org, repo, scannedPrs: scanned, candidates, skippedHugeDiff };
}

function isHugeDiffError(error: unknown): boolean {
  return error instanceof Error && /exceeded the maximum number of files|\(HTTP 406\)/.test(error.message);
}

/** 廉价预筛（避免无谓 API）：merged ∧ 标题/正文无 issue 关联 ∧ 标题/正文非 revert */
function passesCheapCheck(pr: GithubPullRequest): boolean {
  if (pr.mergedAt === null) {
    return false;
  }
  const linkInput = issueLinkInputOf(pr, []);
  if (extractResolvedIssues(linkInput).length > 0) {
    return false;
  }
  return !isRevertPr(linkInput);
}

function fetchCommitMessages(cacheDir: string, org: string, repo: string, number: number): readonly string[] {
  const raw = cachedFetch(resolve(cacheDir, `pr-${number}-commits.json`), () =>
    ghApi(`repos/${org}/${repo}/pulls/${number}/commits`),
  );
  const parsed = parseCommitMessages(JSON.parse(raw));
  if (!parsed.ok) {
    throw new Error(`${org}/${repo}#${number} commits 解析失败: ${parsed.error.message}`);
  }
  return parsed.value;
}

function fetchDiff(cacheDir: string, org: string, repo: string, number: number): string {
  return cachedFetch(resolve(cacheDir, `pr-${number}.diff`), () =>
    ghApi(`repos/${org}/${repo}/pulls/${number}`, "application/vnd.github.diff"),
  );
}

function main(): void {
  console.log(`clean MR 采集：${MSB_JAVA_REPOS.length} 仓 × 配额 ${PER_REPO_QUOTA}（目标 ~${TARGET_TOTAL}）`);
  const only = process.argv[2];
  const scans: RepoCandidateScan[] = [];
  const outcomes: RepoScanOutcome[] = [];
  for (const repoInfo of MSB_JAVA_REPOS) {
    if (only !== undefined && repoSlug(repoInfo.org, repoInfo.repo) !== only) {
      continue;
    }
    console.log(`[${repoSlug(repoInfo.org, repoInfo.repo)}]`);
    const outcome = collectRepo(repoInfo.org, repoInfo.repo);
    const reverted = collectRevertedPrNumbers(outcome.scannedPrs);
    const acceptedCount = outcome.candidates.filter(
      (c) => evaluateCleanMrCandidate(c, reverted, DEFAULT_CLEAN_MR_RULES, DEFAULT_MR_BOUNDARY).accepted,
    ).length;
    console.log(
      `  全量材料 ${outcome.candidates.length} 条，其中通过规则链 ${acceptedCount} 条` +
        (outcome.skippedHugeDiff === 0 ? "" : `（另 ${outcome.skippedHugeDiff} 条超大 diff 跳过）`) +
        `；API 调用累计 ${apiCalls}`,
    );
    scans.push(outcome);
    outcomes.push(outcome);
  }
  if (scans.length === 0) {
    throw new Error(`未匹配任何仓库（filter=${JSON.stringify(only)}）`);
  }

  const selection = selectCleanMrCases(scans, {
    perRepoQuota: PER_REPO_QUOTA,
    targetTotal: TARGET_TOTAL,
    spillPerRepo: SPILL_PER_REPO,
    rules: DEFAULT_CLEAN_MR_RULES,
    boundary: DEFAULT_MR_BOUNDARY,
  });
  console.log(`\n选取完成：${selection.total} 条（目标 ~${TARGET_TOTAL}）`);

  // 候选 → 所属仓库的定位（同一候选对象在 selection 中按引用传递）
  const candidateOrigin = new Map<CleanMrCandidate, { readonly org: string; readonly repo: string }>();
  for (const scan of scans) {
    for (const candidate of scan.candidates) {
      candidateOrigin.set(candidate, { org: scan.org, repo: scan.repo });
    }
  }

  const diffsDir = resolve(DATA_DIR, "diffs");
  // 输出目录重建：清掉上次运行可能残留的 stale diff（缓存目录不受影响）
  rmSync(diffsDir, { recursive: true, force: true });
  mkdirSync(diffsDir, { recursive: true });
  const cases: ManifestCaseInput[] = selection.selected.map(({ candidate, metrics }) => {
    const origin = candidateOrigin.get(candidate);
    if (origin === undefined) {
      throw new Error("内部错误：选中候选未登记来源仓库");
    }
    const { pr, diff } = candidate;
    const caseId = buildCleanMrCaseId(origin.org, origin.repo, pr.number);
    writeFileSync(resolve(diffsDir, `${caseId}.diff`), diff, "utf8");
    return {
      org: origin.org,
      repo: origin.repo,
      number: pr.number,
      title: pr.title,
      body: pr.body,
      htmlUrl: pr.htmlUrl,
      mergedAt: pr.mergedAt as string,
      baseRef: pr.baseRef,
      baseSha: pr.baseSha,
      mergeCommitSha: pr.mergeCommitSha,
      diff,
      diffSha256: createHash("sha256").update(diff, "utf8").digest("hex"),
      metrics,
    };
  });

  const manifest = buildCleanMrManifest({
    generatedAt: new Date().toISOString(),
    generator: `scripts/collect-clean-mrs.ts (quota=${PER_REPO_QUOTA}, materialize<=${MAX_MATERIALIZE_PER_REPO}, pages<=${MAX_PAGES_PER_REPO}, api<=${MAX_TOTAL_API_CALLS})`,
    targetTotal: TARGET_TOTAL,
    perRepoQuota: PER_REPO_QUOTA,
    scan: SCAN_DESC,
    repoStats: selection.repos.map((stats) => {
      const skipped = outcomes.find((o) => o.org === stats.org && o.repo === stats.repo)?.skippedHugeDiff ?? 0;
      return {
        ...stats,
        // gh 拒发超大 diff（>300 文件）的 PR 事实性超出 ≤10 文件边界，并入同因统计
        rejectedByReason: {
          ...stats.rejectedByReason,
          "too-many-files": stats.rejectedByReason["too-many-files"] + skipped,
        },
        msbInstanceCount: MSB_JAVA_REPOS.find((r) => r.org === stats.org && r.repo === stats.repo)?.msbInstanceCount ?? 0,
      };
    }),
    cases,
  });
  if (!manifest.ok) {
    throw new Error(`清单构造失败: ${manifest.error.message}`);
  }

  const manifestPath = resolve(DATA_DIR, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest.value, null, 2)}\n`, "utf8");
  console.log(`written: ${manifestPath}`);
  for (const stats of manifest.value.repos) {
    const rejected = Object.entries(stats.rejectedByReason)
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(", ");
    console.log(
      `  ${repoSlug(stats.org, stats.repo)}: 选取 ${stats.selected}/${stats.quota}（扫描 ${stats.scannedPrs}，评估 ${stats.evaluated}${rejected === "" ? "" : `，拒绝: ${rejected}`}）`,
    );
  }
  console.log(`API 调用总数：${apiCalls}（预算 ${MAX_TOTAL_API_CALLS}）`);
}

main();
