/**
 * #59 切分 v2 验证跑入口（实验设计 §2）——四组同仓合成 MR × 双臂 × 3 rep。
 *
 * 运行（与 experiment 同款单文件编译；产物落 runs/sharding-validation/，gitignore）：
 *   pnpm sharding-validation -- [--group struts] [--reps 1] [--root runs/sharding-validation]
 *
 * - 组合清单 / 档位 / 控制臂配置 = 实验设计 §2.1–2.2（struts / spring-sec / cxf / uaa，
 *   控制臂统一 9 文件 / 1500 行跨组可比）；锚定（fix commit 最新者）与 repoPath /
 *   snapshot 统一到锚 clone 由驱动层完成（validation-driver.ts）。
 * - 基线 = runs/phase2-dsh/runs/vul4j/<案>/B/rep-{1,2,3}.json（30 案 × 3 rep，
 *   verifier off）；同 model 口径匹配在 harness 阶段 2 拦（deepseek-v4-flash）。
 * - 执行通道 = DSH 内核（en，deepseek-v4-flash，与基线同通道同 model）；rep 间
 *   串行（跨片前缀缓存）；断点粒度 = 组 × rep（<root>/reports/<groupId>/rep-<N>/
 *   report.json 存在即跳过，零重烧）。
 * - Pilot（§2.7 预算确认）：pnpm sharding-validation -- --group struts --reps 1。
 * - 失败组无 report 产物，重跑自然重试；退出码非零即存在失败组。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { MRCase } from "../src/contracts/mr-case.js";
import { createDshKernelDriver } from "../src/experiment/dsh-kernel.js";
import { RunStore } from "../src/experiment/run-store.js";
import { composeShardingArms } from "../src/experiment/sharding/arms.js";
import {
  buildGroupInputs,
  loadRepoSnapshot,
  runValidationGroups,
  type ShardingDriverGroup,
} from "../src/experiment/sharding/validation-driver.js";
import { DEFAULT_ORCHESTRATION_CONFIG } from "../src/sharding/orchestrate-review.js";
import { planShards } from "../src/sharding/plan-shards.js";
import { formatEnvLocalSummary, loadEnvLocalFile } from "../src/shared/env-local.js";

/** 控制臂统一档位（域内，留边界余量；跨组可比——实验设计 §2.2） */
const CONTROL_FILL = { targetFiles: 9, targetDiffLines: 1500 } as const;

/** 组合清单与处理臂档位（实验设计 §2.1–2.2：单维 / 双维 / 边界邻域三类超界形态） */
const GROUPS: readonly ShardingDriverGroup[] = [
  {
    groupId: "struts",
    caseIds: ["VUL4J-29", "VUL4J-30", "VUL4J-33", "VUL4J-35"],
    treatmentFill: { targetFiles: 24, targetDiffLines: 2400 }, // 双维超界（文件 + 行）
    controlFill: CONTROL_FILL,
  },
  {
    groupId: "spring-sec",
    caseIds: ["VUL4J-72", "VUL4J-73", "VUL4J-74"],
    treatmentFill: { targetFiles: 24, targetDiffLines: 1800 }, // 单维超界（文件）
    controlFill: CONTROL_FILL,
  },
  {
    groupId: "cxf",
    caseIds: ["VUL4J-15", "VUL4J-16"],
    treatmentFill: { targetFiles: 9, targetDiffLines: 2400 }, // 单维超界（行）
    controlFill: CONTROL_FILL,
  },
  {
    groupId: "uaa",
    caseIds: ["VUL4J-39", "VUL4J-40"],
    treatmentFill: { targetFiles: 11, targetDiffLines: 2100 }, // 边界邻域微超界
    controlFill: CONTROL_FILL,
  },
];

/** 固定口径（与 phase2-dsh 基线同通道同 model——harness 阶段 2 三元组匹配） */
const BASELINE_STORE_ROOT = path.join("runs", "phase2-dsh", "runs");
const CASES_FILE = path.join("data", "vul4j", "target-cases.json");
const FIX_COMMIT_DATES_FILE = path.join("data", "vul4j", "fix-commit-dates.json");
const MODEL = "deepseek-v4-flash";
const CONFIG_ID = "B" as const;
const BASELINE_REPS = [1, 2, 3] as const;

interface CliOptions {
  readonly groupIds: readonly string[];
  readonly reps: readonly number[];
  readonly root: string;
  /** 零 LLM 干跑：compose 全矩阵 + 片数预估后即停（弃案 / 档位错提前暴露） */
  readonly dryRun: boolean;
}

function usage(): never {
  console.log(
    [
      "usage: pnpm sharding-validation -- [--group <id>]... [--reps <csv>] [--root <dir>] [--dry-run]",
      "",
      "  --group    执行的组（可重复；缺省全部：struts, spring-sec, cxf, uaa）",
      "  --reps     执行的 rep 清单（逗号分隔；缺省 1,2,3）",
      "  --root     产物根目录（缺省 runs/sharding-validation）",
      "  --dry-run  零 LLM 干跑：双臂 compose + planShards 片数预估后即停",
      "",
      "pilot（实验设计 §2.7）：pnpm sharding-validation -- --group struts --reps 1",
    ].join("\n"),
  );
  process.exit(2);
}

/** 最小旗标解析（无外部依赖；pnpm 透传的前导 `--` 容忍跳过） */
function parseArgs(argv: readonly string[]): CliOptions {
  const groupIds: string[] = [];
  const reps: number[] = [];
  let root = path.join("runs", "sharding-validation");
  let dryRun = false;
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = args[i + 1];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--group" && value !== undefined) {
      groupIds.push(value);
      i++;
    } else if (arg === "--reps" && value !== undefined) {
      for (const part of value.split(",")) {
        const rep = Number.parseInt(part, 10);
        if (!Number.isInteger(rep) || rep < 1) {
          console.error(`--reps wants comma-separated positive integers (got ${JSON.stringify(value)})`);
          process.exit(2);
        }
        reps.push(rep);
      }
      i++;
    } else if (arg === "--root" && value !== undefined) {
      root = value;
      i++;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      console.error(`unknown or incomplete argument: ${arg}`);
      usage();
    }
  }
  return { groupIds, reps, root, dryRun };
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  // .env.local 装载（凭据注入 process.env；已存在的环境变量优先不覆盖）——
  // 必须在 DSH 内核 host spawn 之前（host 侧适配器构造期对缺凭据 fail fast）
  const envResult = loadEnvLocalFile(path.resolve(".env.local"), process.env);
  if (envResult.exists) {
    console.log(`env: .env.local found — ${formatEnvLocalSummary(envResult)}`);
  }

  const knownIds = new Set(GROUPS.map((group) => group.groupId));
  const unknown = options.groupIds.filter((id) => !knownIds.has(id));
  if (unknown.length > 0) {
    console.error(`unknown group id(s): ${unknown.join(", ")} (known: ${[...knownIds].join(", ")})`);
    return 2;
  }
  const selected = options.groupIds.length === 0 ? GROUPS : GROUPS.filter((g) => options.groupIds.includes(g.groupId));
  const reps = options.reps.length === 0 ? [1, 2, 3] : [...options.reps];

  // 装载面：案例 + fix commit 时间（gh api 一次性取数落盘的产物）+ 基线 RunStore
  const cases = JSON.parse(await readFile(CASES_FILE, "utf8")) as MRCase[];
  const datesRaw = JSON.parse(await readFile(FIX_COMMIT_DATES_FILE, "utf8")) as readonly {
    readonly caseId: string;
    readonly fixCommitAt: string;
  }[];
  const fixCommitDates = new Map(datesRaw.map((entry) => [entry.caseId, entry.fixCommitAt]));
  const baselineStore = new RunStore(BASELINE_STORE_ROOT);

  console.log(
    `#59 sharding validation: ${selected.map((g) => g.groupId).join(", ")} × reps ${reps.join(",")} ` +
      `(model=${MODEL} kernel=dsh en)`,
  );

  const built = await buildGroupInputs({
    groups: selected,
    cases,
    fixCommitDates,
    loadSnapshot: loadRepoSnapshot,
    readBaseline: (unit) =>
      baselineStore.read({ source: "vul4j", caseId: unit.caseId, configId: CONFIG_ID, rep: unit.rep }),
    baselineReps: BASELINE_REPS,
    configId: CONFIG_ID,
    model: MODEL,
  });
  for (const group of built.groups) {
    const ids = group.input.spec.candidates.map((candidate) => candidate.mrCase.caseId);
    console.log(`  group ${group.input.spec.groupId}: anchor=${group.anchorCaseId} candidates=${ids.join(" + ")}`);
  }

  // 零 LLM 干跑：双臂 compose（含干净套用 / 臂不变式预检）+ planShards 片数预估
  if (options.dryRun) {
    let failures = 0;
    for (const group of built.groups) {
      const groupId = group.input.spec.groupId;
      const arms = composeShardingArms(group.input.spec, DEFAULT_ORCHESTRATION_CONFIG.shard);
      if (!arms.ok) {
        failures++;
        console.error(`  group ${groupId}: COMPOSE FAILED — ${arms.error.message}`);
        continue;
      }
      for (const arm of ["treatment", "control"] as const) {
        const composite = arms.value[arm];
        const plan = planShards(composite.mrCase, DEFAULT_ORCHESTRATION_CONFIG.shard);
        if (!plan.ok) {
          failures++;
          console.error(`  group ${groupId}/${arm}: SHARD PLAN FAILED — ${plan.error.message}`);
          continue;
        }
        console.log(
          `  group ${groupId}/${arm}: ${composite.manifest.composite.files}f/${composite.manifest.composite.diffLines}l` +
            ` → ${plan.value.sharded ? `${plan.value.shards.length} shards (${plan.value.reason})` : "direct（域内）"}`,
        );
      }
      const manifest = arms.value.treatment.manifest;
      const dropped =
        manifest.droppedCases.length === 0
          ? "无"
          : manifest.droppedCases.map((drop) => `${drop.caseId}(${drop.reason})`).join(", ");
      console.log(`    included=[${manifest.includedCaseIds.join(", ")}] dropped=[${dropped}]`);
    }
    console.log(failures === 0 ? "dry-run: 全组 compose 通过（零 LLM 消耗）" : `dry-run: ${failures} 处失败`);
    return failures === 0 ? 0 : 1;
  }

  const kernel = createDshKernelDriver();
  try {
    const outcome = await runValidationGroups({
      groups: built.groups.map((group) => group.input),
      config: { configId: CONFIG_ID, model: MODEL, orchestration: DEFAULT_ORCHESTRATION_CONFIG },
      deps: {
        // 单元级进度留痕（长跑可观测；执行面零语义增删——透传 + 打点）
        executeUnit: async (request) => {
          console.log(`  [${new Date().toISOString()}] unit ${request.caseId} start`);
          const result = await kernel.runUnit(request);
          console.log(
            `  [${new Date().toISOString()}] unit ${request.caseId} done: ${result.findings.length} finding(s)`,
          );
          return result;
        },
      },
      auditRoot: path.join(options.root, "audit"),
      reportRoot: path.join(options.root, "reports"),
      reps,
    });

    console.log(
      `done: executed=${outcome.executed.length} skipped=${outcome.skipped.length} failed=${outcome.failures.length}`,
    );
    for (const key of outcome.executed) {
      console.log(`  executed: ${key}`);
    }
    for (const key of outcome.skipped) {
      console.log(`  skipped: ${key} (report.json exists — zero re-burn)`);
    }
    for (const failure of outcome.failures) {
      console.error(`  FAILED ${failure.groupId} @ ${failure.stage} [${failure.code ?? "runtime"}]: ${failure.message}`);
    }
    return outcome.failures.length > 0 ? 1 : 0;
  } finally {
    await kernel.close();
  }
}

const exitCode = await main();
process.exit(exitCode);
