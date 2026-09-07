import path from "node:path";
import { loadExperimentCases } from "../experiment/datasets.js";
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
import type { ClaudeCodeClient } from "./contracts.js";
import { ClaudeCodeCliClient, DEFAULT_CLAUDE_CODE_TIMEOUT_MS } from "./client.js";
import {
  DEFAULT_CLAUDE_CODE_MAX_TURNS,
  DEFAULT_CLAUDE_CODE_MODEL,
  DEFAULT_REFERENCE_REPS,
  type ClaudeCodeReferencePlan,
  type ReferenceSource,
  expandReferencePlan,
  validateReferencePlan,
} from "./plan.js";
import { CLAUDE_CODE_PROMPT_TEMPLATE_VERSION } from "./prompt.js";
import {
  buildClaudeCodeReferenceReport,
  persistReferenceReport,
  rebuildReferenceOutcome,
} from "./report.js";
import {
  loadPersistedReferenceCases,
  loadPersistedReferencePlan,
  runClaudeCodeReference,
} from "./runner.js";

/**
 * 外部参照 CLI（Ticket 13 / issue #14）——「一条命令跑 Claude Code 单列参照」。
 *
 * 用法（数据集与主实验共用装载；成本纪律支持子集/限量/续跑）：
 *   pnpm reference -- --id ref-claude-001 --cases-file dataset.json --clean-mr \
 *     --model sonnet --max-turns 5 --reps 1
 *
 * 产物落 <runsRoot>/claude-code/<id>/（已被 gitignore）：reference-plan.json /
 * cases.json / runs/<source>/<caseId>/rep-<rep>.json / raw/<...> /
 * reference-report.json / reference-dashboard.md。
 *
 * 退出码：0 = 完成（单元级失败已隔离留痕，不改变退出码）；
 *         1 = 一条记录都没产出（全量失败）；2 = 用法/环境/配置错误。
 * 认证沿用 claude CLI 自身配置（本 harness 不经手任何凭据，无环境变量要求）。
 */

/** CLI 解析结果（ClaudeCodeReferencePlan 的原料 + 装载/运行控制项） */
export interface ReferenceCliOptions {
  readonly referenceId: string;
  readonly sources: readonly ReferenceSource[];
  readonly reps: number;
  readonly model: string;
  readonly maxTurns: number;
  readonly timeoutMs: number;
  readonly perSourceLimit: number | null;
  readonly caseFilter: readonly string[];
  readonly casesFile?: string;
  readonly cleanMr: boolean;
  readonly cleanMrRepoPath?: string;
  readonly reportOnly: boolean;
  /** 参照运行根目录（缺省 runs/；产物落 runs/claude-code/<id>/，已被 gitignore） */
  readonly runsRoot: string;
}

export type ParseReferenceArgsResult = CliParseResult<ReferenceCliOptions>;

const ALL_REFERENCE_SOURCES: readonly ReferenceSource[] = [
  "defects4j",
  "vul4j",
  "msb-java",
  "clean-mr",
];

export function referenceCliUsage(): string {
  return [
    "Usage: run-claude-code-reference [options]",
    "Options:",
    "  --id <id>                 reference run id (required; artifacts under <runsRoot>/claude-code/<id>/)",
    "  --cases-file <path>       materialized MRCase[] JSON (shared with the main experiment)",
    "  --clean-mr                include the shipped clean-MR negative control (data/clean-mr)",
    "  --clean-mr-repo <path>    repoPath for clean-MR cases (read by the claude CLI subprocess)",
    "  --sources <list>          comma list of defects4j,vul4j,msb-java,clean-mr (default: all)",
    "  --reps <n>                repetitions per MR (default: 1)",
    "  --model <id>              Claude-family model id: claude-* full id or sonnet/opus/haiku alias (default: sonnet)",
    "  --max-turns <n>           --max-turns bound per review run (default: 5)",
    "  --timeout-ms <n>          wall-clock timeout per CLI call (default: 600000)",
    "  --limit <n>               per-source case cap (default: none)",
    "  --case <id>               exact caseId filter (repeatable)",
    "  --report-only             rebuild the reference report from persisted records (no CLI calls)",
    "  --runs-root <dir>         runs root (default: runs)",
    "  --help                    show this help",
    "Notes:",
    "  External cross-model reference: findings are normalized into the unified schema and",
    "  scored through the same metrics pipeline (single column \"claude-code\"), but are",
    "  explicitly excluded from the S/A/B main verdict.",
  ].join("\n");
}

/** 解析过程中的累加器（每轮以不可变合并推进；最终装配为只读 options） */
type ReferenceCliValues = {
  referenceId: string;
  sources: ReferenceSource[];
  reps: number;
  model: string;
  maxTurns: number;
  timeoutMs: number;
  perSourceLimit: number | null;
  caseFilter: string[];
  casesFile: string | undefined;
  cleanMr: boolean;
  cleanMrRepoPath: string | undefined;
  reportOnly: boolean;
  runsRoot: string;
};

/** 布尔 flag 表：命中即合并补丁（内联 =value 忽略不校验） */
const BOOLEAN_FLAGS: Readonly<Record<string, Partial<ReferenceCliValues>>> = {
  "--clean-mr": { cleanMr: true },
  "--report-only": { reportOnly: true },
};

/** 整数参数 → 补丁（Number + isInteger 严格口径：parseInt 会把 "1.5" 静默截成 1，放过非法输入） */
function applyStrictIntFlag(
  value: string,
  flag: string,
  min: number,
  assign: (parsed: number) => Partial<ReferenceCliValues>,
): FlagApplyResult<ReferenceCliValues> {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    return flagFail(`${flag} must be an integer >= ${min} (got ${JSON.stringify(value)})`);
  }
  return flagOk(assign(parsed));
}

/** 值参数表：参数名 → 解析器（错误消息与重构前逐字一致） */
const VALUE_FLAGS: Readonly<Record<string, ValueFlagParser<ReferenceCliValues>>> = {
  "--id": (value) => flagOk({ referenceId: value }),
  "--cases-file": (value) => flagOk({ casesFile: value }),
  "--clean-mr-repo": (value) => flagOk({ cleanMrRepoPath: value }),
  "--runs-root": (value) => flagOk({ runsRoot: value }),
  "--sources": (value) =>
    applyListFlag(value, ALL_REFERENCE_SOURCES, "source", (list) => ({ sources: list })),
  "--reps": (value) => applyStrictIntFlag(value, "--reps", 1, (parsed) => ({ reps: parsed })),
  "--model": (value) => {
    const trimmed = value.trim();
    return trimmed.length === 0
      ? flagFail("--model must be a non-empty model id")
      : flagOk({ model: trimmed });
  },
  "--max-turns": (value) =>
    applyStrictIntFlag(value, "--max-turns", 1, (parsed) => ({ maxTurns: parsed })),
  "--timeout-ms": (value) =>
    applyStrictIntFlag(value, "--timeout-ms", 1000, (parsed) => ({ timeoutMs: parsed })),
  "--limit": (value) =>
    applyStrictIntFlag(value, "--limit", 1, (parsed) => ({ perSourceLimit: parsed })),
  "--case": (value, current) =>
    value.length === 0
      ? flagFail("--case requires a non-empty caseId")
      : flagOk({ caseFilter: [...current.caseFilter, value] }),
};

/** 解析起点：全部字段取缺省值 */
function defaultReferenceCliValues(): ReferenceCliValues {
  return {
    referenceId: "",
    sources: [...ALL_REFERENCE_SOURCES],
    reps: DEFAULT_REFERENCE_REPS,
    model: DEFAULT_CLAUDE_CODE_MODEL,
    maxTurns: DEFAULT_CLAUDE_CODE_MAX_TURNS,
    timeoutMs: DEFAULT_CLAUDE_CODE_TIMEOUT_MS,
    perSourceLimit: null,
    caseFilter: [],
    casesFile: undefined,
    cleanMr: false,
    cleanMrRepoPath: undefined,
    reportOnly: false,
    runsRoot: "runs",
  };
}

/** 收尾：--id 必填校验 + 只读 options 装配（undefined 键省略） */
function finalizeReferenceCliValues(
  values: ReferenceCliValues,
  fail: (message: string) => ParseReferenceArgsResult,
): ParseReferenceArgsResult {
  if (values.referenceId.trim().length === 0) {
    return fail("--id is required");
  }
  return {
    ok: true,
    options: {
      referenceId: values.referenceId,
      sources: values.sources,
      reps: values.reps,
      model: values.model,
      maxTurns: values.maxTurns,
      timeoutMs: values.timeoutMs,
      perSourceLimit: values.perSourceLimit,
      caseFilter: values.caseFilter,
      ...(values.casesFile !== undefined ? { casesFile: values.casesFile } : {}),
      cleanMr: values.cleanMr,
      ...(values.cleanMrRepoPath !== undefined
        ? { cleanMrRepoPath: values.cleanMrRepoPath }
        : {}),
      reportOnly: values.reportOnly,
      runsRoot: values.runsRoot,
    },
  };
}

/** 解析声明（骨架共享自 shared/cli-args：主循环 / 取值形式 / 错误消息语义一致） */
const REFERENCE_ARG_SPEC: CliArgSpec<ReferenceCliValues, ReferenceCliOptions> = {
  usage: referenceCliUsage(),
  defaultValues: defaultReferenceCliValues,
  booleanFlags: BOOLEAN_FLAGS,
  valueFlags: VALUE_FLAGS,
  finalize: finalizeReferenceCliValues,
};

/** 纯函数解析 argv（支持 --flag value 与 --flag=value；--case 可重复） */
export function parseReferenceArgs(argv: readonly string[]): ParseReferenceArgsResult {
  return parseCliArgs(argv, REFERENCE_ARG_SPEC);
}

/** CLI 选项 → ClaudeCodeReferencePlan（含校验；失败抛错由调用方转退出码） */
export function referenceCliOptionsToPlan(options: ReferenceCliOptions): ClaudeCodeReferencePlan {
  const plan: ClaudeCodeReferencePlan = {
    referenceId: options.referenceId,
    sources: options.sources,
    reps: options.reps,
    model: options.model,
    maxTurns: options.maxTurns,
    promptTemplateVersion: CLAUDE_CODE_PROMPT_TEMPLATE_VERSION,
    perSourceLimit: options.perSourceLimit,
    caseFilter: options.caseFilter,
  };
  validateReferencePlan(plan);
  return plan;
}

/** 运行时依赖注入点（测试注入 fake 客户端；缺省为真实 CLI 客户端） */
export interface ReferenceCliDeps {
  readonly createClient: (options: { readonly timeoutMs: number }) => ClaudeCodeClient;
  readonly log: (line: string) => void;
}

export function defaultReferenceCliDeps(): ReferenceCliDeps {
  return {
    createClient: (options) => new ClaudeCodeCliClient({ timeoutMs: options.timeoutMs }),
    log: (line) => console.log(line),
  };
}

/** CLI 主流程（返回进程退出码；异常统一转为 2 + 清单式错误信息） */
export async function runClaudeCodeReferenceCli(
  argv: readonly string[],
  deps: Partial<ReferenceCliDeps> = {},
): Promise<number> {
  const resolved: ReferenceCliDeps = { ...defaultReferenceCliDeps(), ...deps };
  const parsed = parseReferenceArgs(argv);
  if (!parsed.ok) {
    resolved.log(parsed.message);
    resolved.log(parsed.usage);
    return 2;
  }
  const options = parsed.options;
  let plan: ClaudeCodeReferencePlan;
  try {
    plan = referenceCliOptionsToPlan(options);
  } catch (error) {
    resolved.log(`invalid reference plan: ${errorMessage(error)}`);
    return 2;
  }
  const referenceRoot = path.resolve(options.runsRoot, "claude-code", options.referenceId);
  try {
    return await executeReferenceCli(plan, options, referenceRoot, resolved);
  } catch (error) {
    resolved.log(`reference "${plan.referenceId}" failed: ${errorMessage(error)}`);
    return 2;
  }
}

async function executeReferenceCli(
  plan: ClaudeCodeReferencePlan,
  options: ReferenceCliOptions,
  referenceRoot: string,
  deps: ReferenceCliDeps,
): Promise<number> {
  let outcome;
  if (options.reportOnly) {
    deps.log(`[reference ${plan.referenceId}] report-only rebuild from ${referenceRoot}`);
    outcome = await rebuildReferenceOutcome(
      referenceRoot,
      () => loadPersistedReferencePlan(referenceRoot),
      () => loadPersistedReferenceCases(referenceRoot),
    );
  } else {
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
      return 2;
    }
    const expanded = expandReferencePlan(plan, dataset.cases);
    if (expanded.units.length === 0) {
      deps.log(
        `planned 0 units: sources=${plan.sources.join(", ")} / caseFilter=${plan.caseFilter.length > 0 ? plan.caseFilter.join(", ") : "(none)"} ` +
          `matched no loaded cases (see --sources / --case / --limit)`,
      );
      return 2;
    }
    deps.log(
      `[reference ${plan.referenceId}] ${expanded.cases.length} case(s) / ${expanded.units.length} unit(s); ` +
        `model=${plan.model} maxTurns=${plan.maxTurns} reps=${plan.reps} sources=${plan.sources.join(",")}`,
    );
    outcome = await runClaudeCodeReference(
      plan,
      dataset.cases,
      {
        client: deps.createClient({ timeoutMs: options.timeoutMs }),
        onUnit: (event) => {
          const unit = `${event.unit.source}/${event.unit.caseId}/rep-${event.unit.rep}`;
          if (event.kind === "completed") {
            deps.log(`  ${unit}: completed (${event.findings} finding(s))`);
          } else if (event.kind === "resumed") {
            deps.log(`  ${unit}: resumed (cached)`);
          } else {
            deps.log(`  ${unit}: FAILED — ${event.message}`);
          }
        },
      },
      { referenceRoot },
    );
  }
  const report = buildClaudeCodeReferenceReport(outcome);
  await persistReferenceReport(referenceRoot, report);
  deps.log(
    `[reference ${plan.referenceId}] done: executed=${report.executed} resumed=${report.resumed} ` +
      `failed=${report.failed} cases=${report.caseCount} cleanMr=${report.negativeControlCaseCount}`,
  );
  deps.log(
    `external reference: EXCLUDED from the S/A/B main verdict (${report.mainVerdictNote})`,
  );
  deps.log(`report: ${path.join(referenceRoot, "reference-report.json")}`);
  deps.log(`dashboard: ${path.join(referenceRoot, "reference-dashboard.md")}`);
  if (outcome.records.length === 0) {
    deps.log("no run records were produced (all units failed) — see failures above");
    return 1;
  }
  return 0;
}

/** 进程入口（scripts/run-claude-code-reference.ts 调用） */
export async function main(argv: readonly string[]): Promise<number> {
  return runClaudeCodeReferenceCli(argv);
}
