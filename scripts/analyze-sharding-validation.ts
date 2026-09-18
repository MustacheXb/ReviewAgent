/**
 * #59 切分 v2 验证跑 σ 带判定入口（实验设计 §2.4）——IO 壳：
 * 报告扫描（断点产物）+ 基线装载（LOO 底原料）→ buildSigmaBandAnalysis
 * （纯函数层 src/experiment/sharding/sigma-bands.ts）→ 落盘 + 中文摘要。
 *
 * 运行（与 experiment 同款单文件编译）：
 *   pnpm sharding-analysis -- [--reports runs/sharding-validation/reports]
 *                             [--baseline-root runs/phase2-dsh/runs]
 *                             [--cases-file data/vul4j/target-cases.json]
 *                             [--out runs/sharding-validation/sigma-bands.json]
 *
 * 判定协议（两组对比 + 计数守卫 + 锚点键校准）见模块头注释与实验设计 §2.4；
 * pilot 阶段 n < 3 → 不判定属预期（预算 / 片数 / 弃案读数照常产出）。
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { MRCase } from "../src/contracts/mr-case.js";
import type { Finding } from "../src/contracts/finding.js";
import type { GroupValidationReport } from "../src/experiment/sharding/harness.js";
import { RunStore } from "../src/experiment/run-store.js";
import {
  buildSigmaBandAnalysis,
  type LoadedShardingReport,
} from "../src/experiment/sharding/sigma-bands.js";

/** 预期组与 rep（与驱动入口同面；缺报告 = 弃组 / 未跑，如实列明） */
const EXPECTED_GROUPS = ["struts", "spring-sec", "cxf", "uaa"] as const;
const BASELINE_REPS = [1, 2, 3] as const;
/** LOO 底只认与臂侧同 model 的直跑记录（口径诚实——异 model 记录不进底） */
const BASELINE_MODEL = "deepseek-v4-flash";

interface CliOptions {
  readonly reportsRoot: string;
  readonly baselineRoot: string;
  readonly casesFile: string;
  readonly outPath: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let options: CliOptions = {
    reportsRoot: path.join("runs", "sharding-validation", "reports"),
    baselineRoot: path.join("runs", "phase2-dsh", "runs"),
    casesFile: path.join("data", "vul4j", "target-cases.json"),
    outPath: path.join("runs", "sharding-validation", "sigma-bands.json"),
  };
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    const value = args[i + 1];
    if (value === undefined) {
      throw new Error(`missing value for ${flag}`);
    }
    if (flag === "--reports") {
      options = { ...options, reportsRoot: value };
    } else if (flag === "--baseline-root") {
      options = { ...options, baselineRoot: value };
    } else if (flag === "--cases-file") {
      options = { ...options, casesFile: value };
    } else if (flag === "--out") {
      options = { ...options, outPath: value };
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
    i++;
  }
  return options;
}

/** 扫描断点产物：<reportsRoot>/<groupId>/rep-<N>/report.json */
async function loadReports(
  reportsRoot: string,
): Promise<readonly LoadedShardingReport[]> {
  const groupDirs = await readdir(reportsRoot, { withFileTypes: true })
    .then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
    .catch(() => {
      throw new Error(`reports root not found or unreadable: ${reportsRoot}`);
    });
  const reports: LoadedShardingReport[] = [];
  for (const groupId of EXPECTED_GROUPS) {
    if (!groupDirs.includes(groupId)) {
      continue;
    }
    const groupDir = path.join(reportsRoot, groupId);
    const repDirs = (await readdir(groupDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^rep-\d+$/.test(entry.name))
      .map((entry) => entry.name);
    for (const repDir of repDirs) {
      const reportPath = path.join(groupDir, repDir, "report.json");
      const outcome = JSON.parse(await readFile(reportPath, "utf8")) as {
        readonly groups: readonly GroupValidationReport[];
      };
      if (outcome.groups.length !== 1 || outcome.groups[0]!.groupId !== groupId) {
        throw new Error(`unexpected report shape at ${reportPath} (expected exactly one group ${groupId})`);
      }
      reports.push({ group: groupId, rep: Number.parseInt(repDir.slice("rep-".length), 10), report: outcome.groups[0]! });
    }
  }
  return reports;
}

/** LOO 底原料装载：caseId → rep → 直跑 findings（同 model 过滤；缺失/损坏跳过） */
async function loadBaselineFindings(
  baselineRoot: string,
  cases: readonly MRCase[],
): Promise<ReadonlyMap<string, ReadonlyMap<number, readonly Finding[]>>> {
  const store = new RunStore(baselineRoot);
  const byCase = new Map<string, ReadonlyMap<number, readonly Finding[]>>();
  for (const mrCase of cases) {
    const byRep = new Map<number, readonly Finding[]>();
    for (const rep of BASELINE_REPS) {
      const record = await store.read({ source: "vul4j", caseId: mrCase.caseId, configId: "B", rep });
      if (record !== null && record.model === BASELINE_MODEL) {
        byRep.set(rep, record.baseline.findings);
      }
    }
    byCase.set(mrCase.caseId, byRep);
  }
  return byCase;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const cases = JSON.parse(await readFile(options.casesFile, "utf8")) as MRCase[];
  const caseById = new Map(cases.map((mrCase) => [mrCase.caseId, mrCase]));

  const reports = await loadReports(options.reportsRoot);
  if (reports.length === 0) {
    throw new Error(`no reports found under ${options.reportsRoot} — run pnpm sharding-validation first`);
  }
  const baselineFindings = await loadBaselineFindings(options.baselineRoot, cases);

  const analysis = buildSigmaBandAnalysis({
    reports,
    expectedGroups: EXPECTED_GROUPS,
    expectedReps: BASELINE_REPS,
    baselineFindings,
    caseById,
  });

  await mkdir(path.dirname(options.outPath), { recursive: true });
  await writeFile(options.outPath, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");

  console.log(`#59 σ 带判定（${reports.length} 份报告，缺失 ${analysis.completeness.missing.length}，空基线 ${analysis.completeness.emptyBaselineSamples.length}）：`);
  console.log(`  对比 A（处理 vs 控制）：${analysis.comparisonA.verdict} — ${analysis.comparisonA.note}`);
  console.log(`  对比 B（控制 vs LOO 自漂移底）：${analysis.comparisonB.verdict} — ${analysis.comparisonB.note}`);
  console.log(`  归因：${analysis.attribution}`);
  console.log(`  计数守卫：不重 ${analysis.guards.noDuplicate.total} 对 / 不误并 ${analysis.guards.noWrongMerge.total} 条`);
  for (const window of analysis.anchorKeyCalibration) {
    console.log(`  锚点键 ±${window.lineWindow}：合并后 ${window.mergedCount} 条 / 误并 ${window.wrongMergeEntries} 条`);
  }
  console.log(`written: ${options.outPath}`);
}

await main();
