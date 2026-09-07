/**
 * 物化 Vul4J case：清单池条目 → MRCase[] JSON（Benchmark 试跑的数据管线出口）。
 *
 * 数据流（生成期工具，与 generate-vul4j-manifest.ts 同约定）：
 * 1. 读 data/vul4j/target-manifest.json，按 --vul-ids 选取 eligible 池条目；
 * 2. 修复 commit diff：--diffs-dir 本地缓存优先（generate-vul4j-manifest.ts 的
 *    下载物），缺失时经 `<fixCommitUrl>.diff` 下载并回填缓存；
 * 3. 修复版本（fix commit）仓库快照：api.github.com tarball
 *    （`repos/{owner}/{repo}/tarball/{fixSha}`；GITHUB_TOKEN/GH_TOKEN 可选注入，
 *    缺省匿名请求）→ tar --strip-components=1 解压（顶层 `<repo>-<shortsha>/` 展平）；
 * 4. 源码补丁触碰文件 → 从解压仓库读 fixedSources（逆补丁 base = 修复版本，
 *    与 adapter 契约一致；仓库定位以 fixCommitUrl 为准，repoSlug 仅作标签）；
 * 5. vul4jToMrCases 逐条转换（逆补丁 MR diff + 真值），失败显式收集不静默；
 * 6. 写 --out JSON：repoPath 为仓库根相对 posix 路径（pnpm experiment 以仓库根
 *    为 CWD，path.resolve 相对解析成立），tarball/解压仓库留在 .cache/（gitignore）。
 *
 * 用法（仓库内，无需额外依赖）：
 *   pnpm materialize:vul4j -- --vul-ids VUL4J-38,VUL4J-52,VUL4J-79 \
 *     [--diffs-dir <dir>] [--cache-dir <dir>] [--repos-dir <dir>] \
 *     [--manifest <path>] [--out <path>]
 * 缓存存在即复用（可离线重跑）；tarball 下载走 Node fetch（已实测 api.github.com 直连可达）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { MRCase } from "../src/contracts/mr-case.js";
import type { SourceSnapshot } from "../src/dataset/diff/apply-unified-diff.js";
import { parseUnifiedDiff } from "../src/dataset/diff/parse-unified-diff.js";
import { stripTestSections, vul4jToMrCases, type Vul4jExportInput } from "../src/dataset/vul4j/adapter.js";
import type { Vul4jPoolEntry } from "../src/dataset/vul4j/sampling.js";

/** tarball 下载超时：实测弱网 ~2MB/105s，留足余量；小文本（.diff）60s */
const TARBALL_TIMEOUT_MS = 600_000;
const TEXT_TIMEOUT_MS = 60_000;
const TAR_TIMEOUT_MS = 120_000;

interface CliArgs {
  readonly vulIds: readonly string[];
  readonly manifestPath: string;
  readonly diffsDir: string;
  readonly cacheDir: string;
  readonly reposDir: string;
  readonly outPath: string;
}

/** 表驱动解析：flag → 值键映射（未知 flag 显式报错，不静默忽略） */
const STRING_FLAGS = {
  "--manifest": "manifestPath",
  "--diffs-dir": "diffsDir",
  "--cache-dir": "cacheDir",
  "--repos-dir": "reposDir",
  "--out": "outPath",
} as const;

type StringFlag = keyof typeof STRING_FLAGS;
type ValueKey = (typeof STRING_FLAGS)[StringFlag];

const DEFAULT_VALUES: Record<ValueKey, string> = {
  manifestPath: "data/vul4j/target-manifest.json",
  diffsDir: ".cache/datasets/vul4j-diffs",
  cacheDir: ".cache/datasets",
  reposDir: ".cache/datasets/vul4j-repos",
  outPath: "data/vul4j/materialized-cases.json",
};

function parseArgs(argv: readonly string[]): CliArgs {
  const values: Record<ValueKey, string> = { ...DEFAULT_VALUES };
  const seenFlags = new Set<StringFlag>();
  let vulIds: readonly string[] | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    // 裸 --（end-of-options）跳过：pnpm run 把 `pnpm materialize:vul4j -- --vul-ids …`
    // 的 -- 原样透传（与 src/shared/cli-args.ts 约定一致）
    if (arg === "--") {
      continue;
    }
    if (arg === "--vul-ids") {
      const value = argv[i + 1];
      if (value === undefined || value.trim() === "") {
        throw new Error("--vul-ids 需要非空逗号列表（如 VUL4J-38,VUL4J-52,VUL4J-79）");
      }
      vulIds = value.split(",").map((id) => id.trim()).filter((id) => id !== "");
      i += 1;
      continue;
    }
    if (arg in STRING_FLAGS) {
      const flag = arg as StringFlag;
      const value = argv[i + 1];
      if (value === undefined || value.trim() === "") {
        throw new Error(`${flag} 需要非空参数`);
      }
      values[STRING_FLAGS[flag]] = value;
      seenFlags.add(flag);
      i += 1;
      continue;
    }
    throw new Error(`未知参数: ${arg}（支持 --vul-ids/--manifest/--diffs-dir/--cache-dir/--repos-dir/--out）`);
  }
  if (vulIds === null) {
    throw new Error("--vul-ids 必填（如 --vul-ids VUL4J-38,VUL4J-52,VUL4J-79）");
  }
  const invalid = vulIds.filter((id) => !/^VUL4J-\d+(-S)?$/.test(id));
  if (invalid.length > 0) {
    throw new Error(`vulId 格式非法: ${invalid.join(", ")}（须形如 VUL4J-N / VUL4J-N-S）`);
  }
  const duplicates = vulIds.filter((id, index) => vulIds.indexOf(id) !== index);
  if (duplicates.length > 0) {
    throw new Error(`vulId 重复: ${[...new Set(duplicates)].join(", ")}`);
  }
  // 缺省 --out 已存在且未显式指定 → 防误覆写（显式指定则视为覆盖意图）
  if (!seenFlags.has("--out") && existsSync(values.outPath)) {
    throw new Error(`输出 ${values.outPath} 已存在；如需覆盖请显式传 --out`);
  }
  return { vulIds, ...values };
}

interface Vul4jManifest {
  readonly pool: readonly Vul4jPoolEntry[];
}

function loadManifest(path: string): Vul4jManifest {
  const raw: unknown = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as Vul4jManifest).pool)) {
    throw new Error(`清单 ${path} 缺少 pool 数组`);
  }
  return raw as Vul4jManifest;
}

/** 选取池条目：缺失 / 非 eligible（含补丁不可达、解析失败）显式报错 */
function selectEntries(manifest: Vul4jManifest, vulIds: readonly string[]): readonly Vul4jPoolEntry[] {
  const byId = new Map(manifest.pool.map((entry) => [entry.vulId, entry]));
  return vulIds.map((vulId) => {
    const entry = byId.get(vulId);
    if (entry === undefined) {
      throw new Error(`${vulId} 不在清单池中`);
    }
    if (entry.status !== "eligible") {
      throw new Error(`${vulId} 状态 ${entry.status}（拒绝原因: ${entry.rejectReason ?? "未知"}），仅物化 eligible 条目`);
    }
    return entry;
  });
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return await response.text();
}

/** 修复 diff：本地缓存优先，缺失时下载回填（与 manifest 脚本同源 `<url>.diff`） */
async function loadFixDiff(entry: Vul4jPoolEntry, diffsDir: string): Promise<string> {
  const cached = resolve(diffsDir, `${entry.vulId}.diff`);
  if (existsSync(cached)) {
    return readFileSync(cached, "utf8");
  }
  console.log(`  ${entry.vulId}: 本地 diff 缺失，经 ${entry.fixCommitUrl}.diff 下载`);
  const text = await fetchText(`${entry.fixCommitUrl}.diff`, TEXT_TIMEOUT_MS);
  mkdirSync(diffsDir, { recursive: true });
  writeFileSync(cached, text, "utf8");
  return text;
}

const COMMIT_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]+)$/;

/** 解压后的仓库目录（绝对路径）；目录名带短 SHA，清单换锚自动失效旧缓存 */
function repoDirOf(entry: Vul4jPoolEntry, reposDir: string): string {
  return resolve(reposDir, `${entry.vulId}-${entry.fixSha.slice(0, 10)}`);
}

/**
 * tar 可执行文件：Windows 下显式用 System32 bsdtar —— Git Bash 的 GNU tar 会把
 * `D:/…` 盘符路径解释为远程主机（tar host:path 语法，报 "Cannot connect to D"）；
 * bsdtar（Windows 10 1803+ 自带）原生支持盘符路径。非 Windows 用 PATH 上的 tar。
 */
function tarCommand(): string {
  if (process.platform !== "win32") {
    return "tar";
  }
  const systemTar = resolve(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  if (!existsSync(systemTar)) {
    throw new Error(`未找到 System32 bsdtar（${systemTar}）；Windows 10 1803+ 系统自带，请确认环境`);
  }
  return systemTar;
}

/**
 * 物化修复版本仓库：tarball（api.github.com，token 可选）→ tar 解压展平。
 * 已物化（目录存在）即复用；解压先落临时目录再原子改名，中断残留不产生半成品缓存。
 */
async function materializeRepo(entry: Vul4jPoolEntry, cacheDir: string, repoDir: string): Promise<void> {
  if (existsSync(repoDir) && readdirSync(repoDir).length > 0) {
    console.log(`  ${entry.vulId}: 仓库快照已物化，复用 ${repoDir}`);
    return;
  }
  const urlMatch = COMMIT_URL_RE.exec(entry.fixCommitUrl);
  if (urlMatch === null) {
    throw new Error(`${entry.vulId}: fixCommitUrl 非 commit 直链（compare 区间暂不支持 tarball 物化）: ${entry.fixCommitUrl}`);
  }
  const [, owner, repo] = urlMatch;
  const tarPath = resolve(cacheDir, "vul4j-tarballs", `${entry.vulId}-${entry.fixSha.slice(0, 10)}.tar.gz`);
  if (!existsSync(tarPath)) {
    const url = `https://api.github.com/repos/${owner}/${repo}/tarball/${entry.fixSha}`;
    console.log(`  ${entry.vulId}: 下载 ${url}`);
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null;
    const headers: Record<string, string> = { "User-Agent": "review-agent-materialize-vul4j" };
    if (token !== null) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(TARBALL_TIMEOUT_MS) });
    if (!response.ok) {
      throw new Error(`${entry.vulId}: tarball 下载失败 HTTP ${response.status}（token 注入: ${token !== null}）`);
    }
    mkdirSync(resolve(tarPath, ".."), { recursive: true });
    const bytes = Buffer.from(await response.arrayBuffer());
    writeFileSync(tarPath, bytes);
    console.log(`  ${entry.vulId}: tarball ${bytes.length.toLocaleString()} 字节`);
  }
  const tmpDir = `${repoDir}.tmp`;
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  const tar = spawnSync(tarCommand(), ["-xzf", tarPath, "--strip-components=1", "-C", tmpDir], {
    stdio: ["ignore", "ignore", "pipe"],
    timeout: TAR_TIMEOUT_MS,
  });
  if (tar.status !== 0 || tar.error !== undefined) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`${entry.vulId}: tar 解压失败（status=${String(tar.status)}）: ${String(tar.error?.message ?? tar.stderr)}`);
  }
  if (readdirSync(tmpDir).length === 0) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`${entry.vulId}: tarball 解压后为空目录`);
  }
  renameSync(tmpDir, repoDir);
  console.log(`  ${entry.vulId}: 仓库快照解压至 ${repoDir}`);
}

/**
 * 读 fixedSources：剥离测试/二进制节 → 源码补丁 → 触碰文件（newPath）从
 * 修复版本仓库读取。删除的源文件（newPath=null）不在快照中，显式留痕跳过。
 */
function readFixedSources(entry: Vul4jPoolEntry, fixDiff: string, repoDir: string): SourceSnapshot {
  const stripped = stripTestSections(fixDiff, []);
  if (!stripped.ok) {
    throw new Error(`${entry.vulId}: 剥离测试/二进制节失败: ${stripped.error.message}`);
  }
  const parsed = parseUnifiedDiff(stripped.value.srcDiff);
  if (!parsed.ok) {
    throw new Error(`${entry.vulId}: 源码补丁解析失败: ${parsed.error.message}`);
  }
  const sources: Record<string, string> = {};
  for (const file of parsed.value) {
    if (file.newPath === null) {
      console.log(`  ${entry.vulId}: 源文件 ${file.oldPath} 被修复补丁删除，不进 fixedSources`);
      continue;
    }
    const absolute = resolve(repoDir, ...file.newPath.split("/"));
    if (!existsSync(absolute)) {
      throw new Error(`${entry.vulId}: 修复版本仓库缺少补丁触碰文件 ${file.newPath}（期望 ${absolute}）`);
    }
    sources[file.newPath] = readFileSync(absolute, "utf8");
  }
  if (Object.keys(sources).length === 0) {
    throw new Error(`${entry.vulId}: fixedSources 为空（源码补丁无保留文件）`);
  }
  return sources;
}

/** 绝对路径 → 仓库根相对 posix 路径（repoPath 消费方 path.resolve 相对 CWD 解析） */
function toRepoRootRelativePosix(absolutePath: string): string {
  const rel = relative(process.cwd(), absolutePath);
  // 跨盘/仓库外目录（Windows 跨盘符 relative 返回绝对路径）不可表达为仓库根相对路径
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`仓库目录 ${absolutePath} 不在当前工作目录之下（repoPath 须为仓库根相对路径）`);
  }
  return rel.split(sep).join("/");
}

/** 输出摘要：真值行位与 MR 边界一目了然（人工核对物化正确性） */
function summarize(mrCase: MRCase, repoPath: string): string {
  const truthFiles = new Set((mrCase.truth?.locations ?? []).map((location) => location.file));
  // MR diff 为逆补丁构造器的裸 `--- / +++` 格式（无 diff --git 头），文件数走统一解析器
  const parsed = parseUnifiedDiff(mrCase.diff);
  const diffFiles = parsed.ok ? parsed.value.length : "?";
  const diffLines = (mrCase.diff.match(/^[+-][^+-]/gm) ?? []).length;
  return `${mrCase.caseId}: 真值 ${truthFiles.size} 文件 ${(mrCase.truth?.locations ?? []).length} 行位 · MR diff ${diffFiles} 文件 ${diffLines} 行 · repoPath ${repoPath}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`物化 ${args.vulIds.length} 个 Vul4J case: ${args.vulIds.join(", ")}`);
  const entries = selectEntries(loadManifest(args.manifestPath), args.vulIds);
  mkdirSync(args.reposDir, { recursive: true });

  const inputs: Vul4jExportInput[] = [];
  const repoPathByVulId = new Map<string, string>();
  for (const entry of entries) {
    console.log(`- ${entry.vulId}（${entry.cveId} ${entry.cweId}，${entry.repoSlug}）`);
    const fixDiff = await loadFixDiff(entry, args.diffsDir);
    const repoDir = repoDirOf(entry, args.reposDir);
    await materializeRepo(entry, args.cacheDir, repoDir);
    const fixedSources = readFixedSources(entry, fixDiff, repoDir);
    inputs.push({
      vulId: entry.vulId,
      cveId: entry.cveId,
      cweId: entry.cweId,
      cweName: entry.cweName,
      owaspId: entry.owaspId,
      repoSlug: entry.repoSlug,
      fixCommitUrl: entry.fixCommitUrl,
      fixDiff,
      fixedSources,
    });
    repoPathByVulId.set(entry.vulId, repoDir);
  }

  const { cases, failures } = vul4jToMrCases(inputs, (vulId) => {
    const repoDir = repoPathByVulId.get(vulId);
    if (repoDir === undefined) {
      throw new Error(`${vulId}: 无物化仓库路径（内部状态不一致）`);
    }
    return repoDir;
  });
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`  转换失败 ${failure.vulId}: [${failure.code}] ${failure.message}`);
    }
    throw new Error(`${failures.length}/${inputs.length} 条转换失败（见上；不写出部分产物）`);
  }

  const materialized = cases.map((mrCase) => ({
    ...mrCase,
    repoPath: toRepoRootRelativePosix(
      mrCase.repoPath === ""
        ? resolve(process.cwd())
        : resolve(mrCase.repoPath),
    ),
  }));
  const outPath = resolve(args.outPath);
  mkdirSync(resolve(outPath, ".."), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(materialized, null, 2)}\n`, "utf8");
  console.log(`\n已物化 ${materialized.length} 条 → ${outPath}`);
  for (const mrCase of materialized) {
    console.log(`  ${summarize(mrCase, mrCase.repoPath)}`);
  }
}

await main();
