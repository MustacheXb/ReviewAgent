import path from "node:path";
import { loadExperimentCases } from "../experiment/datasets.js";
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

export type ParseReferenceArgsResult =
  | { readonly ok: true; readonly options: ReferenceCliOptions }
  | { readonly ok: false; readonly message: string; readonly usage: string };

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
    "  --model <id>              Claude-family model id passed to --model (default: sonnet)",
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

/** 纯函数解析 argv（支持 --flag value 与 --flag=value；--case 可重复） */
export function parseReferenceArgs(argv: readonly string[]): ParseReferenceArgsResult {
  const values = {
    referenceId: "",
    sources: [...ALL_REFERENCE_SOURCES] as ReferenceSource[],
    reps: DEFAULT_REFERENCE_REPS,
    model: DEFAULT_CLAUDE_CODE_MODEL,
    maxTurns: DEFAULT_CLAUDE_CODE_MAX_TURNS,
    timeoutMs: DEFAULT_CLAUDE_CODE_TIMEOUT_MS,
    perSourceLimit: null as number | null,
    caseFilter: [] as string[],
    casesFile: undefined as string | undefined,
    cleanMr: false,
    cleanMrRepoPath: undefined as string | undefined,
    reportOnly: false,
    runsRoot: "runs",
  };
  const usage = referenceCliUsage();
  const fail = (message: string): ParseReferenceArgsResult => ({ ok: false, message, usage });
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined) {
      break;
    }
    if (token === "--help" || token === "-h") {
      return fail("--help requested");
    }
    const [name, inlineValue] = splitFlag(token);
    const next = (): string | { readonly error: string } => {
      if (inlineValue !== undefined) {
        return inlineValue;
      }
      index++;
      const value = argv[index];
      if (value === undefined || value.startsWith("--")) {
        return { error: `flag ${name} requires a value` };
      }
      return value;
    };
    const intValue = (flag: string, min: number): number | { readonly error: string } => {
      const value = next();
      if (typeof value !== "string") {
        return value;
      }
      const parsed = parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed < min) {
        return { error: `${flag} must be an integer >= ${min} (got ${JSON.stringify(value)})` };
      }
      return parsed;
    };
    switch (name) {
      case "--id": {
        const value = next();
        if (typeof value !== "string") {
          return fail(value.error);
        }
        values.referenceId = value;
        break;
      }
      case "--cases-file": {
        const value = next();
        if (typeof value !== "string") {
          return fail(value.error);
        }
        values.casesFile = value;
        break;
      }
      case "--clean-mr-repo": {
        const value = next();
        if (typeof value !== "string") {
          return fail(value.error);
        }
        values.cleanMrRepoPath = value;
        break;
      }
      case "--clean-mr":
        values.cleanMr = true;
        break;
      case "--sources": {
        const value = next();
        if (typeof value !== "string") {
          return fail(value.error);
        }
        const parsed = parseList(value, ALL_REFERENCE_SOURCES, "source");
        if (!parsed.ok) {
          return fail(parsed.message);
        }
        values.sources = parsed.value;
        break;
      }
      case "--reps": {
        const parsed = intValue("--reps", 1);
        if (typeof parsed !== "number") {
          return fail(parsed.error);
        }
        values.reps = parsed;
        break;
      }
      case "--model": {
        const value = next();
        if (typeof value !== "string") {
          return fail(value.error);
        }
        if (value.trim().length === 0) {
          return fail("--model must be a non-empty model id");
        }
        values.model = value.trim();
        break;
      }
      case "--max-turns": {
        const parsed = intValue("--max-turns", 1);
        if (typeof parsed !== "number") {
          return fail(parsed.error);
        }
        values.maxTurns = parsed;
        break;
      }
      case "--timeout-ms": {
        const parsed = intValue("--timeout-ms", 1000);
        if (typeof parsed !== "number") {
          return fail(parsed.error);
        }
        values.timeoutMs = parsed;
        break;
      }
      case "--limit": {
        const parsed = intValue("--limit", 1);
        if (typeof parsed !== "number") {
          return fail(parsed.error);
        }
        values.perSourceLimit = parsed;
        break;
      }
      case "--case": {
        const value = next();
        if (typeof value !== "string") {
          return fail(value.error);
        }
        if (value.length === 0) {
          return fail("--case requires a non-empty caseId");
        }
        values.caseFilter = [...values.caseFilter, value];
        break;
      }
      case "--report-only":
        values.reportOnly = true;
        break;
      case "--runs-root": {
        const value = next();
        if (typeof value !== "string") {
          return fail(value.error);
        }
        values.runsRoot = value;
        break;
      }
      default:
        return fail(`unknown flag ${JSON.stringify(token)}\n${usage}`);
    }
    index++;
  }
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

/** 进程入口（scripts/run-claude-code-reference.ts 调用） */
export async function main(argv: readonly string[]): Promise<number> {
  return runClaudeCodeReferenceCli(argv);
}
