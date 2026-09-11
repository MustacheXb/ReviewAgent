import path from "node:path";
import type { ConfigId } from "../contracts/config.js";
import { CONFIGS } from "../contracts/config.js";
import { runUnitKeyString } from "../contracts/run-unit.js";
import { DeepSeekClient } from "../deepseek/deepseek-client.js";
import type { JudgeClient } from "../judge/index.js";
import { GptJudgeClient } from "../judge/index.js";
import {
  applyListFlag,
  type CliArgSpec,
  type CliParseResult,
  errorMessage,
  flagFail,
  flagOk,
  parseCliArgs,
  type ValueFlagParser,
  type FlagApplyResult,
} from "../shared/cli-args.js";
import { loadEnvLocalFile, type EnvLocalLoadResult } from "../shared/env-local.js";
import { renderDashboardMarkdown } from "./dashboard.js";
import { loadExperimentCases } from "./datasets.js";
import { createDshKernelDriver, type DshKernelDriver } from "./dsh-kernel.js";
import { checkExperimentEnv, envErrorMessage } from "./env.js";
import {
  DEFAULT_EXPERIMENT_MODEL,
  DEFAULT_HUMAN_REVIEW_RATE,
  DEFAULT_HUMAN_REVIEW_SEED,
  DEFAULT_REPS,
  type ExperimentModel,
  type ExperimentPlan,
  type ExperimentSource,
  type VerifierMode,
  validateExperimentPlan,
} from "./plan.js";
import { buildExperimentReport, persistExperimentReport } from "./report.js";
import type { ReportDeps } from "./report.js";
import { rebuildExperimentOutcome } from "./report.js";
import { loadPersistedCases, loadPersistedPlan, runExperiment } from "./runner.js";
import type { UnitEvent } from "./runner.js";
import { writeFile, mkdir } from "node:fs/promises";

/**
 * 实验运行器 CLI（Ticket 12 / issue #13）："一条命令跑全量矩阵"的入口。
 *
 * 用法（完整矩阵见 spec #1；成本纪律支持子集/限量/续跑）：
 *   pnpm experiment -- --id poc1-main --cases-file dataset.json --clean-mr \
 *     --configs A,B,C,D,E --reps 3 --verifier on --judge
 *
 * 退出码：0 = 完成（单元级失败已隔离留痕，不改变退出码）；
 *         1 = 一条记录都没产出（全量失败）；2 = 用法/环境/配置错误。
 * key 只经环境变量注入（启动统一校验并给缺失清单；输出不回显 key 值）。
 */

/** 检视执行内核（#27）：poc1 = 进程内 runReview（基线）；dsh = 长驻 DSH 内核 host 进程 */
export type KernelMode = "poc1" | "dsh";

/** CLI 解析结果（ExperimentPlan 的原料 + 装载/运行控制项） */
export interface ExperimentCliOptions {
  readonly experimentId: string;
  readonly sources: readonly ExperimentSource[];
  readonly configs: readonly ConfigId[];
  readonly reps: number;
  readonly verifier: VerifierMode;
  readonly model: ExperimentModel;
  readonly kernel: KernelMode;
  readonly highRiskOnly: boolean;
  readonly perSourceLimit: number | null;
  readonly caseFilter: readonly string[];
  readonly judge: boolean;
  readonly humanReviewRate: number;
  readonly humanReviewSeed: string;
  readonly casesFile?: string;
  readonly cleanMr: boolean;
  readonly cleanMrRepoPath?: string;
  readonly reportOnly: boolean;
  /** 实验根目录（缺省 runs/；产物落 runs/<id>/，已被 gitignore） */
  readonly runsRoot: string;
}

export type ParseArgsResult = CliParseResult<ExperimentCliOptions>;

const ALL_CONFIG_IDS = Object.keys(CONFIGS) as ConfigId[];
const ALL_SOURCES: readonly ExperimentSource[] = ["defects4j", "vul4j", "msb-java", "clean-mr"];
const MODELS: Readonly<Record<string, ExperimentModel>> = {
  flash: "deepseek-v4-flash",
  "deepseek-v4-flash": "deepseek-v4-flash",
  pro: "deepseek-v4-pro",
  "deepseek-v4-pro": "deepseek-v4-pro",
};

export function experimentCliUsage(): string {
  return [
    "Usage: run-experiment [options]",
    "Options:",
    "  --id <id>                 experiment id (required; artifacts under <runsRoot>/<id>/)",
    "  --cases-file <path>       materialized MRCase[] JSON (d4j / vul4j / msb exports)",
    "  --clean-mr                include the shipped clean-MR negative control (data/clean-mr)",
    "  --clean-mr-repo <path>    repoPath for clean-MR cases (read by configs C/D/E only)",
    "  --sources <list>          comma list of defects4j,vul4j,msb-java,clean-mr (default: all)",
    "  --configs <list>          comma list of A-E (default: all)",
    "  --reps <n>                repetitions per MR, rep1 cold / rep2+ hot (default: 3)",
    "  --verifier <off|on>       second-pass verifier ablation (default: off)",
    "  --model <flash|pro>       deepseek-v4-flash | deepseek-v4-pro (default: flash)",
    "  --kernel <poc1|dsh>       review execution kernel (default: poc1; dsh locks model to flash)",
    "  --high-risk-only          only riskClass=High cases (required for v4-pro)",
    "  --limit <n>               per-source case cap (default: none)",
    "  --case <id>               exact caseId filter (repeatable)",
    "  --judge                   run the GPT judge-chain stage (needs OPENAI_API_KEY)",
    "  --human-review-rate <r>   sampling rate in (0,1] (default: 0.1)",
    "  --human-review-seed <s>   deterministic sampling seed",
    "  --report-only             rebuild the report from persisted records (no review runs)",
    "  --runs-root <dir>         experiments root (default: runs)",
    "  --help                    show this help",
  ].join("\n");
}

/** 解析过程中的累加器（每轮以不可变合并推进；最终装配为只读 options） */
type CliValues = {
  experimentId: string;
  sources: ExperimentSource[];
  configs: ConfigId[];
  reps: number;
  verifier: VerifierMode;
  model: ExperimentModel;
  kernel: KernelMode;
  highRiskOnly: boolean;
  perSourceLimit: number | null;
  caseFilter: string[];
  judge: boolean;
  humanReviewRate: number;
  humanReviewSeed: string;
  casesFile: string | undefined;
  cleanMr: boolean;
  cleanMrRepoPath: string | undefined;
  reportOnly: boolean;
  runsRoot: string;
};

/** 布尔 flag 表：命中即合并补丁（内联 =value 按原实现忽略不校验） */
const BOOLEAN_FLAGS: Readonly<Record<string, Partial<CliValues>>> = {
  "--clean-mr": { cleanMr: true },
  "--high-risk-only": { highRiskOnly: true },
  "--judge": { judge: true },
  "--report-only": { reportOnly: true },
};

/** 值参数表：参数名 → 解析器（错误消息与表驱动重构前逐字一致，特征测试锚定） */
const VALUE_FLAGS: Readonly<Record<string, ValueFlagParser<CliValues>>> = {
  "--id": (value) => flagOk({ experimentId: value }),
  "--cases-file": (value) => flagOk({ casesFile: value }),
  "--clean-mr-repo": (value) => flagOk({ cleanMrRepoPath: value }),
  "--runs-root": (value) => flagOk({ runsRoot: value }),
  "--sources": (value) =>
    applyListFlag(value, ALL_SOURCES, "source", (list) => ({ sources: list })),
  "--configs": (value) =>
    applyListFlag(value.toUpperCase(), ALL_CONFIG_IDS, "config", (list) => ({ configs: list })),
  "--reps": (value) => applyIntFlag(value, "--reps", (parsed) => ({ reps: parsed })),
  "--limit": (value) => applyIntFlag(value, "--limit", (parsed) => ({ perSourceLimit: parsed })),
  "--verifier": (value) =>
    value === "off" || value === "on"
      ? flagOk({ verifier: value })
      : flagFail(`--verifier must be "off" or "on" (got ${JSON.stringify(value)})`),
  "--model": (value) => {
    const model = MODELS[value];
    return model !== undefined
      ? flagOk({ model })
      : flagFail(
          `--model must be one of flash, deepseek-v4-flash, pro, deepseek-v4-pro (got ${JSON.stringify(value)})`,
        );
  },
  "--kernel": (value) =>
    value === "poc1" || value === "dsh"
      ? flagOk({ kernel: value })
      : flagFail(`--kernel must be "poc1" or "dsh" (got ${JSON.stringify(value)})`),
  "--case": (value, current) =>
    value.length === 0
      ? flagFail("--case requires a non-empty caseId")
      : flagOk({ caseFilter: [...current.caseFilter, value] }),
  "--human-review-rate": (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 1
      ? flagOk({ humanReviewRate: parsed })
      : flagFail(`--human-review-rate must be a number in (0, 1] (got ${JSON.stringify(value)})`);
  },
  "--human-review-seed": (value) =>
    value.trim().length === 0
      ? flagFail("--human-review-seed must be a non-empty string")
      : flagOk({ humanReviewSeed: value }),
};

/** 整数参数 → 补丁（保留 parseInt 截断语义：带数字前缀的脏值可截断通过） */
function applyIntFlag(
  value: string,
  flag: string,
  assign: (parsed: number) => Partial<CliValues>,
): FlagApplyResult<CliValues> {
  const parsed = parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return flagFail(`${flag} must be an integer >= 1 (got ${JSON.stringify(value)})`);
  }
  return flagOk(assign(parsed));
}

/** 解析起点：全部字段取缺省值（与 spec/usage 文档一致） */
function defaultCliValues(): CliValues {
  return {
    experimentId: "",
    sources: [...ALL_SOURCES],
    configs: [...ALL_CONFIG_IDS],
    reps: DEFAULT_REPS,
    verifier: "off",
    model: DEFAULT_EXPERIMENT_MODEL,
    kernel: "poc1",
    highRiskOnly: false,
    perSourceLimit: null,
    caseFilter: [],
    judge: false,
    humanReviewRate: DEFAULT_HUMAN_REVIEW_RATE,
    humanReviewSeed: DEFAULT_HUMAN_REVIEW_SEED,
    casesFile: undefined,
    cleanMr: false,
    cleanMrRepoPath: undefined,
    reportOnly: false,
    runsRoot: "runs",
  };
}

/** 收尾：--id 必填校验 + clean-mr 占位路径 + 只读 options 装配（undefined 键省略） */
function finalizeCliValues(
  values: CliValues,
  fail: (message: string) => ParseArgsResult,
): ParseArgsResult {
  if (values.experimentId.trim().length === 0) {
    return fail("--id is required");
  }
  // clean MR 的 repoPath 只有 C/D/E 读取；未提供时用占位路径（A/B 零工具不读取）
  const cleanMrRepoPath =
    values.cleanMr && values.cleanMrRepoPath === undefined
      ? `./clean-mr-placeholder-repo`
      : values.cleanMrRepoPath;
  return {
    ok: true,
    options: {
      experimentId: values.experimentId,
      sources: values.sources,
      configs: values.configs,
      reps: values.reps,
      verifier: values.verifier,
      model: values.model,
      kernel: values.kernel,
      highRiskOnly: values.highRiskOnly,
      perSourceLimit: values.perSourceLimit,
      caseFilter: values.caseFilter,
      judge: values.judge,
      humanReviewRate: values.humanReviewRate,
      humanReviewSeed: values.humanReviewSeed,
      ...(values.casesFile !== undefined ? { casesFile: values.casesFile } : {}),
      cleanMr: values.cleanMr,
      ...(cleanMrRepoPath !== undefined ? { cleanMrRepoPath } : {}),
      reportOnly: values.reportOnly,
      runsRoot: values.runsRoot,
    },
  };
}

/** 解析声明（骨架共享自 shared/cli-args：主循环 / 取值形式 / 错误消息语义一致） */
const EXPERIMENT_ARG_SPEC: CliArgSpec<CliValues, ExperimentCliOptions> = {
  usage: experimentCliUsage(),
  defaultValues: defaultCliValues,
  booleanFlags: BOOLEAN_FLAGS,
  valueFlags: VALUE_FLAGS,
  finalize: finalizeCliValues,
};

/** 纯函数解析 argv（支持 --flag value 与 --flag=value；--case 可重复） */
export function parseExperimentArgs(argv: readonly string[]): ParseArgsResult {
  return parseCliArgs(argv, EXPERIMENT_ARG_SPEC);
}

/** CLI 选项 → ExperimentPlan（含校验；校验失败抛错由调用方捕获转退出码） */
export function cliOptionsToPlan(options: ExperimentCliOptions): ExperimentPlan {
  const plan: ExperimentPlan = {
    experimentId: options.experimentId,
    sources: options.sources,
    configs: options.configs,
    reps: options.reps,
    verifier: options.verifier,
    model: options.model,
    highRiskOnly: options.highRiskOnly,
    perSourceLimit: options.perSourceLimit,
    caseFilter: options.caseFilter,
    judge: options.judge,
    humanReviewRate: options.humanReviewRate,
    humanReviewSeed: options.humanReviewSeed,
  };
  validateExperimentPlan(plan);
  return plan;
}

/** 运行时依赖注入点（测试注入 fake 客户端与环境；缺省为真实客户端 + process.env） */
export interface CliRunDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly createLlmClient: () => DeepSeekClient;
  readonly createJudgeClient: () => JudgeClient;
  /** DSH 内核驱动工厂（--kernel dsh 时调用一次；缺省 = 真实 host 进程驱动） */
  readonly createDshKernel: () => DshKernelDriver;
  readonly log: (line: string) => void;
  /** 启动期装载 .env.local（注入 process.env）；缺省读仓库根 .env.local 并打印键名摘要 */
  readonly loadEnvLocal: () => EnvLocalLoadResult;
}

export function defaultCliRunDeps(): CliRunDeps {
  const log = (line: string): void => console.log(line);
  return {
    env: process.env,
    createLlmClient: () => new DeepSeekClient(),
    createJudgeClient: () => new GptJudgeClient(),
    createDshKernel: () => createDshKernelDriver(),
    log,
    loadEnvLocal: () => {
      const result = loadEnvLocalFile(path.resolve(".env.local"), process.env);
      if (result.exists) {
        // 只报键名与行号（key 纪律：值绝不回显）；skipped = 空值或环境已有非空值
        const parts = [
          result.loadedKeys.length > 0 ? `injected ${result.loadedKeys.join(", ")}` : "nothing to inject",
          ...(result.skippedKeys.length > 0 ? [`skipped ${result.skippedKeys.join(", ")} (empty value or already set)`] : []),
          ...(result.malformedLines.length > 0 ? [`malformed ${result.malformedLines.join(", ")}`] : []),
        ];
        log(`env: .env.local found — ${parts.join("; ")}`);
      }
      return result;
    },
  };
}

/** CLI 主流程（返回进程退出码；异常统一转为 2 + 清单式错误信息） */
export async function runExperimentCli(
  argv: readonly string[],
  deps: Partial<CliRunDeps> = {},
): Promise<number> {
  const resolved: CliRunDeps = { ...defaultCliRunDeps(), ...deps };
  const parsed = parseExperimentArgs(argv);
  if (!parsed.ok) {
    resolved.log(parsed.message);
    resolved.log(parsed.usage);
    return 2;
  }
  const options = parsed.options;
  let plan: ExperimentPlan;
  try {
    plan = cliOptionsToPlan(options);
  } catch (error) {
    resolved.log(`invalid experiment plan: ${errorMessage(error)}`);
    return 2;
  }
  // .env.local 装载（本机注入面，文件缺失 no-op）——必须在环境校验前，
  // 让 checkExperimentEnv 看到注入的 key（resolved.env 与装载目标同为 process.env）
  try {
    resolved.loadEnvLocal();
  } catch (error) {
    resolved.log(`failed to load .env.local: ${errorMessage(error)}`);
    return 2;
  }
  const envCheck = checkExperimentEnv(
    {
      judge: plan.judge,
      // --report-only 不跑检视：DEEPSEEK_API_KEY 不再必需；judge 阶段仍会续跑补缺 → OPENAI 仍校验
      reviewRuns: !options.reportOnly,
    },
    resolved.env,
  );
  if (!envCheck.satisfied) {
    resolved.log(envErrorMessage(envCheck.missing));
    return 2;
  }
  const experimentRoot = path.resolve(options.runsRoot, options.experimentId);
  try {
    return await executeCli(plan, options, experimentRoot, resolved);
  } catch (error) {
    resolved.log(`experiment "${plan.experimentId}" failed: ${errorMessage(error)}`);
    return 2;
  }
}

async function executeCli(
  plan: ExperimentPlan,
  options: ExperimentCliOptions,
  experimentRoot: string,
  deps: CliRunDeps,
): Promise<number> {
  const judgeDeps = buildJudgeDeps(plan, deps);
  const outcome = options.reportOnly
    ? await rebuildOutcomeOnly(plan, experimentRoot, deps)
    : await runReviewMatrix(plan, options, experimentRoot, deps);
  if (outcome === null) {
    return 2;
  }
  return await finalizeExperiment(plan, experimentRoot, outcome, judgeDeps, deps);
}

/** 报告阶段所需 outcome 形状（runExperiment 全量结果与 --report-only 重建结果的公共结构） */
type ReportableOutcome = Parameters<typeof buildExperimentReport>[0];

/** judge 链依赖（未开启 judge 时为空对象 = 报告阶段跳过判定） */
function buildJudgeDeps(plan: ExperimentPlan, deps: CliRunDeps): ReportDeps {
  return plan.judge
    ? {
        judgeClient: deps.createJudgeClient(),
        onJudgeUnit: (event) => deps.log(`  judge ${event.unit}: ${event.status}`),
      }
    : {};
}

/** 单元事件 → 单行进度日志（completed / resumed / failed） */
function unitEventLogger(deps: CliRunDeps): (event: UnitEvent) => void {
  return (event) => {
    const unit = runUnitKeyString(event.unit);
    if (event.kind === "completed") {
      deps.log(`  ${unit}: completed (${event.findings} finding(s))`);
    } else if (event.kind === "resumed") {
      deps.log(`  ${unit}: resumed (cached)`);
    } else {
      deps.log(`  ${unit}: FAILED — ${event.message}`);
    }
  };
}

/** --report-only：不跑检视，从持久化产物（plan + cases + records）重建 outcome */
async function rebuildOutcomeOnly(
  plan: ExperimentPlan,
  experimentRoot: string,
  deps: CliRunDeps,
): Promise<ReportableOutcome> {
  deps.log(`[experiment ${plan.experimentId}] report-only rebuild from ${experimentRoot}`);
  return await rebuildExperimentOutcome(
    experimentRoot,
    () => loadPersistedPlan(experimentRoot),
    () => loadPersistedCases(experimentRoot),
  );
}

/** 装载数据集并跑全量矩阵；数据集为空时返回 null（调用方以退出码 2 收场） */
async function runReviewMatrix(
  plan: ExperimentPlan,
  options: ExperimentCliOptions,
  experimentRoot: string,
  deps: CliRunDeps,
): Promise<ReportableOutcome | null> {
  const dataset = await loadExperimentCases({
    ...(options.casesFile !== undefined ? { casesFile: options.casesFile } : {}),
    cleanMr: options.cleanMr,
    ...(options.cleanMrRepoPath !== undefined
      ? { cleanMrRepoPath: options.cleanMrRepoPath }
      : {}),
  });
  for (const failure of dataset.failures) {
    deps.log(`  dataset failure (${failure.source}): ${failure.message}`);
  }
  if (dataset.cases.length === 0) {
    deps.log(
      "no cases loaded (check --cases-file / --clean-mr and the dataset failures above)",
    );
    return null;
  }
  deps.log(
    `[experiment ${plan.experimentId}] ${dataset.cases.length} case(s) loaded; ` +
      `model=${plan.model} kernel=${options.kernel} verifier=${plan.verifier} ` +
      `reps=${plan.reps} configs=${plan.configs.join("")}`,
  );
  const dshKernel = options.kernel === "dsh" ? deps.createDshKernel() : undefined;
  try {
    return await runExperiment(
      plan,
      dataset.cases,
      {
        llmClient: deps.createLlmClient(),
        ...(dshKernel !== undefined ? { dshKernel } : {}),
        onUnit: unitEventLogger(deps),
      },
      { experimentRoot },
    );
  } finally {
    await dshKernel?.close();
  }
}

/** 报告/dashboard 落盘 + 收尾日志 → 退出码（0 = 完成；1 = 零记录全量失败） */
async function finalizeExperiment(
  plan: ExperimentPlan,
  experimentRoot: string,
  outcome: ReportableOutcome,
  judgeDeps: ReportDeps,
  deps: CliRunDeps,
): Promise<number> {
  const report = await buildExperimentReport(outcome, judgeDeps, { experimentRoot });
  await persistExperimentReport(experimentRoot, report);
  await writeDashboard(experimentRoot, report);
  deps.log(
    `[experiment ${plan.experimentId}] done: executed=${report.executed} resumed=${report.resumed} ` +
      `failed=${report.failed} cases=${report.caseCount} cleanMr=${report.negativeControlCaseCount}`,
  );
  deps.log(`report: ${path.join(experimentRoot, "report.json")}`);
  deps.log(`dashboard: ${path.join(experimentRoot, "dashboard.md")}`);
  if (outcome.records.length === 0) {
    deps.log("no run records were produced (all units failed) — see failures above");
    return 1;
  }
  return 0;
}

async function writeDashboard(experimentRoot: string, report: unknown): Promise<void> {
  const markdown = renderDashboardMarkdown(report as Parameters<typeof renderDashboardMarkdown>[0]);
  const dashboardPath = path.join(experimentRoot, "dashboard.md");
  await mkdir(path.dirname(dashboardPath), { recursive: true });
  await writeFile(dashboardPath, markdown, "utf8");
}

/** 进程入口（scripts/run-experiment.ts 调用） */
export async function main(argv: readonly string[]): Promise<number> {
  return runExperimentCli(argv);
}
