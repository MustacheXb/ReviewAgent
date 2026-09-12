/**
 * 对齐门 CLI（#31）——「一条命令跑指标对齐门 v2」。
 *
 * 参数解析共享骨架（src/shared/cli-args.ts，experiment / reference 双 CLI 同款）：
 * --flag value 与 --flag=value 两种取值形式、--help、裸 --（end-of-options）跳过、
 * 跨 CLI 错误消息语义一致；本文件只声明缺省值、flag 表与收尾装配。
 * 数值域规则不在解析层重复维护——finalize 统一经 validateAlignmentGateOptions
 * （模块单源）校验。
 *
 * 用法（经 package.json 脚本 `pnpm alignment-gate -- <args>` 透传）：
 *   pnpm alignment-gate -- --baseline runs/poc1-vul4j-gateway \
 *     --candidate runs/dsh-vul4j-gateway --noise runs/poc1-vul4j-gateway-r2 \
 *     [--out gate.json] [--metrics lineRecall,totalTokens,...] \
 *     [--min-sample 3] [--advisory-sample 15] [--alpha 0.05] [--gap-hours 48]
 *
 * 退出码：PASS/INCONCLUSIVE → 0；FAIL → 1；用法/加载错误 → 2。
 * 纯离线：只读 runs/ 留痕，零网络、零网关消耗。
 */
import {
  DEFAULT_ALIGNMENT_GATE_OPTIONS,
  DEFAULT_GATE_METRICS,
  runAlignmentGate,
  validateAlignmentGateOptions,
} from "../metrics/alignment-gate.js";
import type { AlignmentGateOptions, AlignmentGateReport, GateCell } from "../metrics/alignment-gate.js";
import { METRICS_FIELDS } from "../metrics/types.js";
import type { MetricsField } from "../metrics/types.js";
import { writeJsonFile } from "../shared/report-io.js";
import { loadGateSide } from "./alignment-gate-io.js";
import type { GateSideInput } from "../metrics/alignment-gate.js";
import {
  applyListFlag,
  errorMessage,
  flagFail,
  flagOk,
  parseCliArgs,
} from "../shared/cli-args.js";
import type { CliArgSpec, CliParseResult, ValueFlagParser } from "../shared/cli-args.js";

const USAGE = `用法：run-alignment-gate --baseline <runDir> --candidate <runDir> [--noise <runDir>]
  [--out <file.json>] [--metrics <csv>] [--min-sample <n>] [--advisory-sample <n>] [--alpha <x>] [--gap-hours <h>]
  --baseline         基线侧实验目录（cases.json + runs/）
  --candidate        候选侧实验目录
  --noise            噪声对照侧（自身重跑；在场时启用单元配对符号检验为主判据）
  --out              结构化 JSON 报告落盘路径（缺省仅 stdout）
  --metrics          判定指标子集（缺省四指标 lineRecall,linePrecision,totalTokens,cacheHitRate）
  --min-sample       最小样本护栏（缺省 3；任一侧 n < 该值不判定）
  --advisory-sample  样本量建议阈值（缺省 15；已判定格最小侧 n < 该值出 advisory）
  --alpha            符号检验显著性水平（缺省 0.05）
  --gap-hours        时点配对预警阈值小时（缺省 48）
  取值形式：--flag value 或 --flag=value；--help 打印用法`;

interface GateCliValues {
  readonly baseline: string;
  readonly candidate: string;
  readonly noise: string | null;
  readonly out: string | null;
  readonly options: AlignmentGateOptions;
}

export type ParseAlignmentGateArgsResult = CliParseResult<GateCliValues>;

/** 解析期可变值（全部字段取缺省值起步；数值域校验收尾统一做） */
interface GateParseValues {
  baseline: string | null;
  candidate: string | null;
  noise: string | null;
  out: string | null;
  metrics: readonly MetricsField[];
  minSampleCount: number;
  advisorySampleCount: number;
  significanceLevel: number;
  temporalPairingHours: number;
}

/** 单次值 flag：重复给值报错（路径类四项共用） */
function pathFlag(flagName: "--baseline" | "--candidate" | "--noise" | "--out"): ValueFlagParser<GateParseValues> {
  const field = flagName.slice(2) as "baseline" | "candidate" | "noise" | "out";
  return (value, current) =>
    current[field] !== null ? flagFail(`flag ${flagName} given more than once`) : flagOk({ [field]: value });
}

/** 数值 flag：只查「是不是数」（域规则归 validateAlignmentGateOptions 单源） */
function numberFlag(flagName: "--min-sample" | "--advisory-sample" | "--alpha" | "--gap-hours"): ValueFlagParser<GateParseValues> {
  return (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return flagFail(`flag ${flagName} requires a number (got ${JSON.stringify(value)})`);
    }
    return flagOk<GateParseValues>(
      flagName === "--min-sample"
        ? { minSampleCount: parsed }
        : flagName === "--advisory-sample"
          ? { advisorySampleCount: parsed }
          : flagName === "--alpha"
            ? { significanceLevel: parsed }
            : { temporalPairingHours: parsed },
    );
  };
}

const GATE_ARG_SPEC: CliArgSpec<GateParseValues, GateCliValues> = {
  usage: USAGE,
  defaultValues: (): GateParseValues => ({
    baseline: null,
    candidate: null,
    noise: null,
    out: null,
    metrics: DEFAULT_GATE_METRICS,
    minSampleCount: DEFAULT_ALIGNMENT_GATE_OPTIONS.minSampleCount,
    advisorySampleCount: DEFAULT_ALIGNMENT_GATE_OPTIONS.advisorySampleCount,
    significanceLevel: DEFAULT_ALIGNMENT_GATE_OPTIONS.significanceLevel,
    temporalPairingHours: DEFAULT_ALIGNMENT_GATE_OPTIONS.temporalPairingHours,
  }),
  booleanFlags: {},
  valueFlags: {
    "--baseline": pathFlag("--baseline"),
    "--candidate": pathFlag("--candidate"),
    "--noise": pathFlag("--noise"),
    "--out": pathFlag("--out"),
    "--metrics": (value) => applyListFlag(value, METRICS_FIELDS, "metric", (list) => ({ metrics: list })),
    "--min-sample": numberFlag("--min-sample"),
    "--advisory-sample": numberFlag("--advisory-sample"),
    "--alpha": numberFlag("--alpha"),
    "--gap-hours": numberFlag("--gap-hours"),
  },
  finalize: (values, fail) => {
    if (values.baseline === null) {
      return fail("missing required flag --baseline");
    }
    if (values.candidate === null) {
      return fail("missing required flag --candidate");
    }
    const options: AlignmentGateOptions = {
      metrics: values.metrics,
      minSampleCount: values.minSampleCount,
      advisorySampleCount: values.advisorySampleCount,
      significanceLevel: values.significanceLevel,
      temporalPairingHours: values.temporalPairingHours,
    };
    try {
      validateAlignmentGateOptions(options);
    } catch (error) {
      return fail(errorMessage(error));
    }
    return {
      ok: true,
      options: {
        baseline: values.baseline,
        candidate: values.candidate,
        noise: values.noise,
        out: values.out,
        options,
      },
    };
  },
};

/** 参数解析（纯函数）：非法输入返回人读错误，不抛异常 */
export function parseAlignmentGateArgs(argv: readonly string[]): ParseAlignmentGateArgsResult {
  return parseCliArgs(argv, GATE_ARG_SPEC);
}

/** 入口：解析 → 加载两侧（+噪声侧）→ 门 → stdout 判定表（+ 可选 JSON 落盘）→ 退出码 */
export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseCliArgs(argv, GATE_ARG_SPEC);
  if (!parsed.ok) {
    console.error(`${parsed.message}\n${parsed.usage}`);
    return 2;
  }

  let baseline: GateSideInput;
  let candidate: GateSideInput;
  let noise: GateSideInput | null;
  try {
    baseline = await loadGateSide(parsed.options.baseline);
    candidate = await loadGateSide(parsed.options.candidate);
    noise = parsed.options.noise === null ? null : await loadGateSide(parsed.options.noise);
  } catch (error) {
    console.error(`加载失败：${errorMessage(error)}`);
    return 2;
  }

  const report = runAlignmentGate(baseline, candidate, noise, parsed.options.options);
  printGateReport(report);

  if (parsed.options.out !== null) {
    try {
      await writeJsonFile(parsed.options.out, report);
      console.log(`report: ${parsed.options.out}`);
    } catch (error) {
      console.error(`报告落盘失败：${errorMessage(error)}`);
      return 2;
    }
  }

  return report.verdict === "FAIL" ? 1 : 0;
}

// ===== stdout 呈现 =====

function formatNumber(value: number): string {
  return Math.abs(value) >= 1000 ? value.toFixed(0) : value.toFixed(4);
}

function formatStat(label: string, n: number, mean: number, std: number): string {
  return `${label} ${n} ${formatNumber(mean)}±${formatNumber(std)}`;
}

function formatCell(cell: GateCell): string {
  const label = `${cell.configId}/${cell.metric}`.padEnd(20);
  const baseline =
    cell.baseline === null
      ? "—".padEnd(18)
      : formatStat("b", cell.baseline.count, cell.baseline.mean, cell.baseline.std).padEnd(18);
  const candidate =
    cell.candidate === null
      ? "—".padEnd(18)
      : formatStat("c", cell.candidate.count, cell.candidate.mean, cell.candidate.std).padEnd(18);
  const delta = cell.delta === null ? "—" : formatNumber(cell.delta);
  const band =
    cell.symmetricBand === null
      ? "—"
      : `[${formatNumber(cell.symmetricBand.lo)}, ${formatNumber(cell.symmetricBand.hi)}]`;
  return `${label} ${baseline} ${candidate} ${delta.padStart(10)}  ${band.padEnd(22)} ${cell.status.padEnd(20)} ${cell.legacyStatus}`;
}

function printGateReport(report: AlignmentGateReport): void {
  const noiseNote = report.noiseSide === null ? "无" : report.noiseSide;
  console.log(`对齐门 v2（对称 max σ 带 + 最小样本护栏 + 单元配对符号检验主判据）`);
  console.log(`candidate=${report.candidateSide} vs baseline=${report.baselineSide}（noise=${noiseNote}）`);
  console.log("");
  console.log("── 格判定（config × metric；修订=对称带、遗留=#29 单侧带）──");
  console.log(`${"config/metric".padEnd(20)} ${"baseline".padEnd(18)} ${"candidate".padEnd(18)} ${"Δ".padStart(10)}  ${"对称带".padEnd(22)} ${"修订".padEnd(20)} 遗留`);
  for (const cell of report.cells) {
    console.log(formatCell(cell));
  }
  console.log("");
  console.log("── 配对符号检验（噪声对照在场时；为主判据——PASS 指标的带外格不触发 FAIL）──");
  if (report.paired.length === 0) {
    console.log("未执行（未提供 --noise 噪声对照侧）");
  } else {
    console.log(
      `${"metric".padEnd(16)} ${"pairs".padStart(5)} ${"mean|Δcand|".padStart(12)} ${"mean|Δnoise|".padStart(12)} ${"worse/better/ties".padStart(18)} ${"p(更差方向)".padStart(12)}  判定`,
    );
    for (const paired of report.paired) {
      const candDelta = paired.candidateMeanDelta === null ? "—" : formatNumber(paired.candidateMeanDelta);
      const noiseDelta = paired.noiseMeanDelta === null ? "—" : formatNumber(paired.noiseMeanDelta);
      const p = paired.worseDirectionP === null ? "—" : paired.worseDirectionP.toFixed(4);
      console.log(
        `${paired.metric.padEnd(16)} ${String(paired.pairCount).padStart(5)} ${candDelta.padStart(12)} ${noiseDelta.padStart(12)} ${`${paired.candidateWorse}/${paired.candidateBetter}/${paired.ties}`.padStart(18)} ${p.padStart(12)}  ${paired.verdict}`,
      );
    }
  }
  console.log("");
  console.log("── 时点配对 ──");
  const temporal = report.temporal;
  if (temporal === null) {
    console.log("未提供执行窗（记录无 completedAt 留痕或加载侧未携带）");
  } else {
    const windowText = (label: string, window: { readonly first: string; readonly last: string } | null): string =>
      window === null ? `${label}=—` : `${label}=[${window.first} … ${window.last}]`;
    const gapText =
      temporal.candidateGapHours === null ? "间隔=—" : `间隔=${temporal.candidateGapHours.toFixed(1)}h${temporal.exceedsThreshold ? "（超阈值预警）" : ""}`;
    console.log(
      `${windowText("baseline", temporal.baselineWindow)} ${windowText("candidate", temporal.candidateWindow)} ${gapText}`,
    );
  }
  if (report.advisories.length > 0) {
    console.log("");
    console.log("── advisories ──");
    for (const advisory of report.advisories) {
      console.log(`- ${advisory}`);
    }
  }
  console.log("");
  console.log(`判定：${report.verdict} —— ${report.basis}`);
}
