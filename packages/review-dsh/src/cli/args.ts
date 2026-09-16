/**
 * #26/#46 CLI 参数解析（进程内主缝）：`review-agent review` 与
 * `review-agent smoke` 两个子命令的用法契约。
 *
 * wrapper 薄到只做参数透传（票面 AC4）——本模块只认子命令、旗标与缺省值，
 * 不触碰内核行为；config 合法性对照 REVIEW_PRESETS 注册表（A–E 矩阵真源，
 * #25）。用法错误以 union 返回（不抛异常）：用户输入错误是预期路径，不是
 * 完整性事故。
 *
 * #46 起 smoke 子命令只有一个旗标 --model（与 review 同缺省同校验，双包
 * 各自单源 DEFAULT_MODEL）；review 专属旗标（--repo 等）对 smoke 是未知
 * 旗标——冒烟自检不跑检视，参数面自然更窄。
 */

import { basename } from "node:path";

import type { ConfigId } from "../../../../src/contracts/config.js";
import { DEFAULT_MODEL } from "../plugins/review-policy.js";
import { REVIEW_PRESETS } from "../presets/review-presets.js";

/** review 子命令的已知旗标（未知旗标 = 用法错误） */
const KNOWN_REVIEW_FLAGS: readonly string[] = ["--repo", "--mr", "--config", "--issue", "--out", "--model"];

/** smoke 子命令的已知旗标（#46） */
const KNOWN_SMOKE_FLAGS: readonly string[] = ["--model"];

/** 用法文案（stderr 错误路径的同款文案，单一来源） */
export const USAGE_TEXT = `usage: review-agent review --repo <path> --mr <diff-file> [--config A-E] [--issue <text>] [--out <dir>] [--model <id>]
       review-agent smoke [--model <id>]
  （smoke = 网关冒烟自检，#46：对目标端点发 1 次最小补全 + 1 次最小工具调用探针，输出人话诊断）

review 旗标：
  --repo    <path>       仓库根目录（必需）
  --mr      <diff-file>  MR diff 文件路径（必需）
  --config  <A-E>        配置形态（缺省 A）
  --issue   <text>       MR 议题描述（缺省空）
  --out     <dir>        输出目录（审计与会话落盘；缺省 review-agent-output）
  --model   <id>         被测模型 id（缺省 deepseek-v4-flash；自由 id 透传，退役 id 拒绝）

smoke 旗标：
  --model   <id>         被测模型 id（同上缺省与校验；端点/key 走 REVIEWER_* 环境变量或 .env.local）`;

/** 解析后的 review 命令参数（config 已收窄为 A–E；caseId 由 --mr 派生） */
export interface ReviewCliArgs {
  readonly repo: string;
  readonly mr: string;
  /** 检视单元身份：--mr 文件名去扩展名（POC1 case 约定：一案一 diff 文件） */
  readonly caseId: string;
  readonly config: ConfigId;
  readonly issue: string;
  readonly out: string;
  /** 被测模型（#45）：缺省 DEFAULT_MODEL；自由 id 透传（空串/空白 = 用法错误） */
  readonly model: string;
}

/** 解析后的 smoke 命令参数（#46） */
export interface SmokeCliArgs {
  /** 被测模型：缺省 DEFAULT_MODEL；自由 id 透传（空串/空白 = 用法错误） */
  readonly model: string;
}

/** 解析结果：子命令 + 参数，或用法错误消息（调用方负责呈现与退出码） */
export type ParseCliArgsResult =
  | { readonly ok: true; readonly command: "review"; readonly args: ReviewCliArgs }
  | { readonly ok: true; readonly command: "smoke"; readonly args: SmokeCliArgs }
  | { readonly ok: false; readonly message: string };

/** 旗标循环（两子命令共用）：未知旗标 / 重复旗标 / 值缺席（含值吞旗标）都是用法错误 */
function parseFlags(
  rest: readonly string[],
  knownFlags: readonly string[],
): { readonly ok: true; readonly values: Map<string, string> } | { readonly ok: false; readonly message: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (flag === undefined || !knownFlags.includes(flag)) {
      return { ok: false, message: `unknown flag ${JSON.stringify(flag)}` };
    }
    if (values.has(flag)) {
      return { ok: false, message: `duplicate flag ${flag}` };
    }
    const value = rest[index + 1];
    // 值以 -- 开头 = 相邻旗标被吞（如 `--issue --out x`）——fail fast 不静默
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, message: `flag ${flag} requires a value` };
    }
    values.set(flag, value);
  }
  return { ok: true, values };
}

/** --model 的缺省与校验（两子命令同口径） */
function parseModelFlag(values: Map<string, string>): { readonly ok: true; readonly model: string } | { readonly ok: false; readonly message: string } {
  const modelRaw = values.get("--model") ?? DEFAULT_MODEL;
  if (modelRaw.trim().length === 0) {
    return { ok: false, message: `invalid --model ${JSON.stringify(modelRaw)}: must be a non-empty model id (free ids accepted)` };
  }
  return { ok: true, model: modelRaw };
}

export function parseCliArgs(argv: readonly string[]): ParseCliArgsResult {
  const [command, ...rest] = argv;
  if (command !== "review" && command !== "smoke") {
    return {
      ok: false,
      message:
        argv.length === 0
          ? "missing command (expected `review` or `smoke`)"
          : `unknown command ${JSON.stringify(command)} (expected \`review\` or \`smoke\`)`,
    };
  }
  const flags = parseFlags(rest, command === "review" ? KNOWN_REVIEW_FLAGS : KNOWN_SMOKE_FLAGS);
  if (!flags.ok) {
    return flags;
  }
  const model = parseModelFlag(flags.values);
  if (!model.ok) {
    return model;
  }
  if (command === "smoke") {
    return { ok: true, command: "smoke", args: { model: model.model } };
  }

  const repo = flags.values.get("--repo");
  if (repo === undefined) {
    return { ok: false, message: "missing required flag --repo" };
  }
  const mr = flags.values.get("--mr");
  if (mr === undefined) {
    return { ok: false, message: "missing required flag --mr" };
  }
  const configRaw = flags.values.get("--config") ?? "A";
  if (!(configRaw in REVIEW_PRESETS)) {
    return { ok: false, message: `invalid --config ${JSON.stringify(configRaw)}: expected one of A, B, C, D, E` };
  }

  return {
    ok: true,
    command: "review",
    args: {
      repo,
      mr,
      caseId: basename(mr).replace(/\.[^.]*$/, ""),
      config: configRaw as ConfigId,
      issue: flags.values.get("--issue") ?? "",
      out: flags.values.get("--out") ?? "review-agent-output",
      model: model.model,
    },
  };
}
