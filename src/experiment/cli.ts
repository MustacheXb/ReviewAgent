import path from "node:path";
import type { ConfigId } from "../contracts/config.js";
import { CONFIGS } from "../contracts/config.js";
import { DeepSeekClient } from "../deepseek/deepseek-client.js";
import type { JudgeClient } from "../judge/index.js";
import { GptJudgeClient } from "../judge/index.js";
import { renderDashboardMarkdown } from "./dashboard.js";
import { loadExperimentCases } from "./datasets.js";
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

/** CLI 解析结果（ExperimentPlan 的原料 + 装载/运行控制项） */
export interface ExperimentCliOptions {
  readonly experimentId: string;
  readonly sources: readonly ExperimentSource[];
  readonly configs: readonly ConfigId[];
  readonly reps: number;
  readonly verifier: VerifierMode;
  readonly model: ExperimentModel;
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

export type ParseArgsResult =
  | { readonly ok: true; readonly options: ExperimentCliOptions }
  | { readonly ok: false; readonly message: string; readonly usage: string };

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

/** 单个 flag 的应用结果：ok=true 给出待合并的值补丁，ok=false 给出错误消息 */
type FlagApplyResult =
  | { readonly ok: true; readonly patch: Partial<CliValues> }
  | { readonly ok: false; readonly message: string };

/** 值参数解析器：(取值, 当前累加值) → 补丁 | 错误 */
type ValueFlagParser = (value: string, current: CliValues) => FlagApplyResult;

/** 布尔 flag 表：命中即合并补丁（内联 =value 按原实现忽略不校验） */
const BOOLEAN_FLAGS: Readonly<Record<string, Partial<CliValues>>> = {
  "--clean-mr": { cleanMr: true },
  "--high-risk-only": { highRiskOnly: true },
  "--judge": { judge: true },
  "--report-only": { reportOnly: true },
};

/** 值参数表：参数名 → 解析器（错误消息与表驱动重构前逐字一致，特征测试锚定） */
const VALUE_FLAGS: Readonly<Record<string, ValueFlagParser>> = {
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

const flagOk = (patch: Partial<CliValues>): FlagApplyResult => ({ ok: true, patch });
const flagFail = (message: string): FlagApplyResult => ({ ok: false, message });

/** 解析起点：全部字段取缺省值（与 spec/usage 文档一致） */
function defaultCliValues(): CliValues {
  return {
    experimentId: "",
    sources: [...ALL_SOURCES],
    configs: [...ALL_CONFIG_IDS],
    reps: DEFAULT_REPS,
    verifier: "off",
    model: DEFAULT_EXPERIMENT_MODEL,
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

/** 取 flag 的值：内联 --flag=value 原样返回；空格形式消费下一个 token（不得是 flag 或结尾） */
function nextValue(
  argv: readonly string[],
  index: number,
  name: string,
  inlineValue: string | undefined,
):
  | { readonly ok: true; readonly value: string; readonly nextIndex: number }
  | { readonly ok: false; readonly message: string } {
  if (inlineValue !== undefined) {
    return { ok: true, value: inlineValue, nextIndex: index + 1 };
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    return { ok: false, message: `flag ${name} requires a value` };
  }
  return { ok: true, value, nextIndex: index + 2 };
}

/** 逗号列表参数 → 补丁（parseList 的错误消息原样透传） */
function applyListFlag<T extends string>(
  value: string,
  universe: readonly T[],
  kind: string,
  assign: (list: T[]) => Partial<CliValues>,
): FlagApplyResult {
  const parsed = parseList(value, universe, kind);
  return parsed.ok ? flagOk(assign(parsed.value)) : flagFail(parsed.message);
}

/** 整数参数 → 补丁（保留 parseInt 截断语义：带数字前缀的脏值可截断通过） */
function applyIntFlag(
  value: string,
  flag: string,
  assign: (parsed: number) => Partial<CliValues>,
): FlagApplyResult {
  const parsed = parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return flagFail(`${flag} must be an integer >= 1 (got ${JSON.stringify(value)})`);
  }
  return flagOk(assign(parsed));
}

/** 收尾：--id 必填校验 + clean-mr 占位路径 + 只读 options 装配（undefined 键省略） */
function finalizeCliValues(values: CliValues, usage: string): ParseArgsResult {
  if (values.experimentId.trim().length === 0) {
    return { ok: false, message: "--id is required", usage };
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

/** 纯函数解析 argv（支持 --flag value 与 --flag=value；--case 可重复） */
export function parseExperimentArgs(argv: readonly string[]): ParseArgsResult {
  const usage = experimentCliUsage();
  let values = defaultCliValues();
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined) {
      break;
    }
    if (token === "--help" || token === "-h") {
      return { ok: false, message: "--help requested", usage };
    }
    const [name, inlineValue] = splitFlag(token);
    const booleanPatch = BOOLEAN_FLAGS[name];
    if (booleanPatch !== undefined) {
      values = { ...values, ...booleanPatch };
      index += 1;
      continue;
    }
    const parser = VALUE_FLAGS[name];
    if (parser === undefined) {
      return { ok: false, message: `unknown flag ${JSON.stringify(token)}\n${usage}`, usage };
    }
    const fetched = nextValue(argv, index, name, inlineValue);
    if (!fetched.ok) {
      return { ok: false, message: fetched.message, usage };
    }
    const applied = parser(fetched.value, values);
    if (!applied.ok) {
      return { ok: false, message: applied.message, usage };
    }
    values = { ...values, ...applied.patch };
    index = fetched.nextIndex;
  }
  return finalizeCliValues(values, usage);
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
  readonly log: (line: string) => void;
}

export function defaultCliRunDeps(): CliRunDeps {
  return {
    env: process.env,
    createLlmClient: () => new DeepSeekClient(),
    createJudgeClient: () => new GptJudgeClient(),
    log: (line) => console.log(line),
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
    const unit = `${event.unit.source}/${event.unit.caseId}/${event.unit.configId}/rep-${event.unit.rep}`;
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
      `model=${plan.model} verifier=${plan.verifier} reps=${plan.reps} configs=${plan.configs.join("")}`,
  );
  return await runExperiment(plan, dataset.cases, {
    llmClient: deps.createLlmClient(),
    onUnit: unitEventLogger(deps),
  }, { experimentRoot });
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

function splitFlag(token: string): readonly [string, string | undefined] {
  const eq = token.indexOf("=");
  if (token.startsWith("--") && eq > 0) {
    return [token.slice(0, eq), token.slice(eq + 1)];
  }
  return [token, undefined];
}

function parseList<T extends string>(
  value: string,
  universe: readonly T[],
  kind: string,
): { readonly ok: true; readonly value: T[] } | { readonly ok: false; readonly message: string } {
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (items.length === 0) {
    return { ok: false, message: `expected a comma list of ${kind} names (got ${JSON.stringify(value)})` };
  }
  const known = new Set<string>(universe);
  const unknown = items.filter((item) => !known.has(item));
  if (unknown.length > 0) {
    return {
      ok: false,
      message: `unknown ${kind} name(s): ${unknown.join(", ")} (allowed: ${universe.join(", ")})`,
    };
  }
  if (new Set(items).size !== items.length) {
    return { ok: false, message: `${kind} list must not contain duplicates (got ${JSON.stringify(value)})` };
  }
  return { ok: true, value: items as T[] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 进程入口（scripts/run-experiment.ts 调用） */
export async function main(argv: readonly string[]): Promise<number> {
  return runExperimentCli(argv);
}
