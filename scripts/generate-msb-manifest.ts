/**
 * 生成 data/msb-java/sampling-manifest.json（Ticket 08 的 ~30 条抽样清单）。
 *
 * 数据流（生成期工具，非 harness 运行时职责）：
 * 1. 下载 HF ByteDance-Seed/Multi-SWE-bench `java/` 目录 9 个 per-repo JSONL
 *    （直链失败自动走 hf-mirror.com 镜像，见研究笔记 multi-swe-bench.md）；
 * 2. 逐行 JSON.parse → validateMsbRecord 形状校验（漂移显式抛错）；
 * 3. measureDiffBoundary(fix_patch) 边界指标（≤10 文件 / ≤2K 变更行）；
 * 4. buildMsbSamplingManifest 确定性抽样（仓库分层）→ 写入清单 JSON。
 *
 * 用法（仓库内，无需额外依赖，与 generate-d4j-manifest.ts 同约定）：
 *   pnpm exec tsc --module NodeNext --moduleResolution NodeNext --target ES2023 \
 *     --strict --skipLibCheck --outDir .tmp-gen scripts/generate-msb-manifest.ts
 *   node .tmp-gen/scripts/generate-msb-manifest.js && rm -rf .tmp-gen
 * 缓存目录（--cache-dir，默认 .cache/datasets/，已 gitignore）存在即跳过下载，可离线重跑。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  MSB_JAVA_DATASET_BASE_URL,
  MSB_JAVA_DATASET_FILES,
  MSB_JAVA_DATASET_MIRROR_BASE_URL,
  validateMsbRecord,
} from "../src/dataset/msb-java/adapter.js";
import {
  buildMsbSamplingManifest,
  type MsbPoolEntry,
} from "../src/dataset/msb-java/sampling.js";
import { measureDiffBoundary } from "../src/dataset/mr-boundary-filter.js";

const CACHE_DIR = resolveCacheDir();
const JSONL_CACHE_DIR = `${CACHE_DIR}/msb-java`;

function resolveCacheDir(): string {
  const flagIndex = process.argv.indexOf("--cache-dir");
  if (flagIndex !== -1 && typeof process.argv[flagIndex + 1] === "string") {
    return resolve(process.argv[flagIndex + 1]!);
  }
  return resolve(".cache/datasets");
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return await response.text();
}

/** 直链 → hf-mirror 镜像的降级链（研究笔记：中国大陆经镜像可达） */
async function fetchWithFallback(urls: readonly string[]): Promise<string> {
  const failures: string[] = [];
  for (const url of urls) {
    try {
      return await fetchText(url);
    } catch (error) {
      failures.push(`${url}: ${(error as Error).message}`);
    }
  }
  throw new Error(`全部来源失败:\n${failures.join("\n")}`);
}

async function downloadJsonl(file: string): Promise<string> {
  const cached = `${JSONL_CACHE_DIR}/${file}`;
  if (existsSync(cached)) {
    return readFileSync(cached, "utf8");
  }
  const text = await fetchWithFallback([
    `${MSB_JAVA_DATASET_BASE_URL}/${file}`,
    `${MSB_JAVA_DATASET_MIRROR_BASE_URL}/${file}`,
  ]);
  writeFileSync(cached, text);
  return text;
}

/** 单记录 → 池条目（形状漂移直接抛错；边界拒绝原因留痕） */
function toPoolEntry(record: unknown): MsbPoolEntry {
  const validated = validateMsbRecord(record);
  if (!validated.ok) {
    throw new Error(`记录形状漂移（数据集更新需人工确认）: ${validated.error.message}`);
  }
  const msb = validated.value;
  const base = {
    instanceId: msb.instanceId,
    org: msb.org,
    repo: msb.repo,
    number: msb.number,
  };
  const metrics = measureDiffBoundary(msb.fixPatch);
  if (!metrics.ok) {
    return {
      ...base,
      status: "rejected",
      files: null,
      changedLines: null,
      rejectReason: "fix-patch-unparseable",
    };
  }
  const { files, changedLines } = metrics.value;
  const boundaryReject =
    files > 10 ? "too-many-files" : changedLines > 2000 ? "diff-too-large" : null;
  return {
    ...base,
    status: boundaryReject === null ? "eligible" : "rejected",
    files,
    changedLines,
    rejectReason: boundaryReject,
  };
}

async function main(): Promise<void> {
  mkdirSync(JSONL_CACHE_DIR, { recursive: true });
  // 缓存目录兼容：历史缓存若直接落在 cache 根目录（msb-java 建目录前），一并读取
  const pool: MsbPoolEntry[] = [];
  for (const file of MSB_JAVA_DATASET_FILES) {
    const text = await downloadJsonl(file);
    const lines = text.trim().split("\n");
    const entries = lines.map((line) => toPoolEntry(JSON.parse(line)));
    pool.push(...entries);
    console.log(`  ${file}: ${entries.length} 实例`);
  }
  const cacheLeftovers = readdirSync(CACHE_DIR).filter((f) => f.endsWith(".jsonl"));
  if (cacheLeftovers.length > 0) {
    console.warn(`注意: 缓存根目录存在散落 JSONL（${cacheLeftovers.join(", ")}），已忽略`);
  }

  const manifest = buildMsbSamplingManifest(pool);
  if (!manifest.ok) {
    throw new Error(`清单构造失败: ${manifest.error.message}`);
  }
  const outPath = resolve("data/msb-java/sampling-manifest.json");
  writeFileSync(outPath, `${JSON.stringify(manifest.value, null, 2)}\n`);
  console.log(
    `清单已写入 ${outPath}: 池 ${manifest.value.poolTotal}（合格 ${manifest.value.eligibleCount} / 拒绝 ${manifest.value.rejectedCount}），抽样 ${manifest.value.total} 条`,
  );
}

await main();
