/**
 * 生成 data/vul4j/target-manifest.json（Ticket 08 的 ~30 条目标清单）。
 *
 * 数据流（生成期工具，非 harness 运行时职责）：
 * 1. 下载 Vul4J 数据集 CSV（github.com/tuhh-softsec/Vul4J master，实测 129 条）；
 * 2. 取 CWE 标注条目（实测 66 条，全部带 CVE）；
 * 3. 逐条经 `<human_patch>.diff` 取回修复 commit diff（实测 65 条可达，1 条 404）；
 * 4. 剥离测试/二进制文件节 → 源码补丁 → parseUnifiedDiff 校验 → 边界指标；
 * 5. buildVul4jTargetManifest 确定性抽样（CWE 分层）→ 写入清单 JSON。
 *
 * 用法（仓库内，无需额外依赖，与 generate-d4j-manifest.ts 同约定）：
 *   pnpm exec tsc --module NodeNext --moduleResolution NodeNext --target ES2023 \
 *     --strict --skipLibCheck --outDir .tmp-gen scripts/generate-vul4j-manifest.ts
 *   node .tmp-gen/scripts/generate-vul4j-manifest.js && rm -rf .tmp-gen
 * 缓存目录（--cache-dir，默认 .cache/datasets/，已 gitignore）存在即跳过下载，可离线重跑。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseVul4jDatasetCsv,
  VUL4J_DATASET_CSV_URL,
  type Vul4jCsvEntry,
} from "../src/dataset/vul4j/csv.js";
import {
  extractFixSha,
  stripTestSections,
} from "../src/dataset/vul4j/adapter.js";
import { resolveCweNature } from "../src/dataset/vul4j/cwe-nature-map.js";
import {
  buildVul4jTargetManifest,
  type Vul4jPoolEntry,
} from "../src/dataset/vul4j/sampling.js";
import { measureDiffBoundary } from "../src/dataset/mr-boundary-filter.js";

const CACHE_DIR = resolveCacheDir();
const DIFF_CACHE_DIR = `${CACHE_DIR}/vul4j-diffs`;

function resolveCacheDir(): string {
  const flagIndex = process.argv.indexOf("--cache-dir");
  if (flagIndex !== -1 && typeof process.argv[flagIndex + 1] === "string") {
    return resolve(process.argv[flagIndex + 1]!);
  }
  return resolve(".cache/datasets");
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return await response.text();
}

async function fetchWithCache(url: string, cachedPath: string): Promise<string> {
  if (existsSync(cachedPath)) {
    return readFileSync(cachedPath, "utf8");
  }
  const text = await fetchText(url);
  writeFileSync(cachedPath, text);
  return text;
}

interface PoolOutcome {
  readonly entry: Vul4jPoolEntry;
}

/** 单条目处理：取回 diff → 剥离 → 解析 → 边界指标 → 池条目（拒绝原因留痕） */
function toPoolEntry(csv: Vul4jCsvEntry, diff: string | null): PoolOutcome {
  const nature = resolveCweNature(csv.cweId);
  const base = {
    vulId: csv.vulId,
    cveId: csv.cveId,
    cweId: csv.cweId,
    cweName: csv.cweName,
    owaspId: csv.owaspId,
    repoSlug: csv.repoSlug,
    fixCommitUrl: csv.humanPatch,
    fixSha: extractFixSha(csv.humanPatch),
    nature: nature.nature,
    natureMatched: nature.matched,
  };
  if (diff === null) {
    return {
      entry: {
        ...base,
        fetchStatus: "unreachable",
        parseStatus: "failed",
        excludedTestFiles: [],
        excludedBinaryFiles: [],
        files: null,
        changedLines: null,
        status: "rejected",
        rejectReason: "patch-unreachable",
      },
    };
  }
  const stripped = stripTestSections(diff, []);
  if (!stripped.ok) {
    return {
      entry: {
        ...base,
        fetchStatus: "ok",
        parseStatus: "failed",
        excludedTestFiles: [],
        excludedBinaryFiles: [],
        files: null,
        changedLines: null,
        status: "rejected",
        rejectReason: stripped.error.code === "NO_SOURCE_FILES" ? "no-source-files" : "strip-failed",
      },
    };
  }
  const metrics = measureDiffBoundary(stripped.value.srcDiff);
  if (!metrics.ok) {
    return {
      entry: {
        ...base,
        fetchStatus: "ok",
        parseStatus: "failed",
        excludedTestFiles: stripped.value.trace.excludedTestFiles,
        excludedBinaryFiles: stripped.value.trace.excludedBinaryFiles,
        files: null,
        changedLines: null,
        status: "rejected",
        rejectReason: "patch-unparseable",
      },
    };
  }
  const { files, changedLines } = metrics.value;
  const boundaryReject =
    files > 10 ? "too-many-files" : changedLines > 2000 ? "diff-too-large" : null;
  return {
    entry: {
      ...base,
      fetchStatus: "ok",
      parseStatus: "ok",
      excludedTestFiles: stripped.value.trace.excludedTestFiles,
      excludedBinaryFiles: stripped.value.trace.excludedBinaryFiles,
      files,
      changedLines,
      status: boundaryReject === null ? "eligible" : "rejected",
      rejectReason: boundaryReject,
    },
  };
}

async function main(): Promise<void> {
  mkdirSync(DIFF_CACHE_DIR, { recursive: true });
  const csvText = await fetchWithCache(VUL4J_DATASET_CSV_URL, `${CACHE_DIR}/vul4j_dataset.csv`);
  const parsedCsv = parseVul4jDatasetCsv(csvText);
  if (!parsedCsv.ok) {
    throw new Error(`CSV 解析失败: ${parsedCsv.error.message}`);
  }
  const cweLabeled = parsedCsv.value.filter((entry) => /^CWE-\d+$/.test(entry.cweId));
  console.log(`Vul4J CSV: ${parsedCsv.value.length} 条，CWE 标注 ${cweLabeled.length} 条`);

  const pool: Vul4jPoolEntry[] = [];
  for (const csv of cweLabeled) {
    const cached = `${DIFF_CACHE_DIR}/${csv.vulId}.diff`;
    let diff: string | null = null;
    try {
      diff = await fetchWithCache(`${csv.humanPatch}.diff`, cached);
    } catch (error) {
      console.warn(`  ${csv.vulId}: diff 获取失败（标记 patch-unreachable）: ${(error as Error).message}`);
    }
    pool.push(toPoolEntry(csv, diff).entry);
  }

  const manifest = buildVul4jTargetManifest(pool);
  if (!manifest.ok) {
    throw new Error(`清单构造失败: ${manifest.error.message}`);
  }
  const outPath = resolve("data/vul4j/target-manifest.json");
  writeFileSync(outPath, `${JSON.stringify(manifest.value, null, 2)}\n`);
  console.log(
    `清单已写入 ${outPath}: 池 ${manifest.value.poolTotal}（合格 ${manifest.value.eligibleCount} / 拒绝 ${manifest.value.rejectedCount}），抽样 ${manifest.value.total} 条`,
  );
}

await main();
