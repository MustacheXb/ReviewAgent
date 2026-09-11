/**
 * #26 CLI 参数解析（进程内主缝）：`review-agent review` 的用法契约。
 *
 * wrapper 薄到只做参数透传（票面 AC4）——本模块只认旗标与缺省值，不触碰
 * 内核行为；config 合法性对照 REVIEW_PRESETS 注册表（A–E 矩阵真源，#25）。
 * 用法错误以 union 返回（不抛异常）：用户输入错误是预期路径，不是完整性事故。
 */

import { basename } from "node:path";

import type { ConfigId } from "../../../../src/contracts/config.js";
import { REVIEW_PRESETS } from "../presets/review-presets.js";

/** 已知旗标（未知旗标 = 用法错误） */
const KNOWN_FLAGS: readonly string[] = ["--repo", "--mr", "--config", "--issue", "--out"];

/** 用法文案（stderr 错误路径的同款文案，单一来源） */
export const USAGE_TEXT = `usage: review-agent review --repo <path> --mr <diff-file> [--config A-E] [--issue <text>] [--out <dir>]
  --repo    <path>       仓库根目录（必需）
  --mr      <diff-file>  MR diff 文件路径（必需）
  --config  <A-E>        配置形态（缺省 A）
  --issue   <text>       MR 议题描述（缺省空）
  --out     <dir>        输出目录（审计与会话落盘；缺省 review-agent-output）`;

/** 解析后的 review 命令参数（config 已收窄为 A–E；caseId 由 --mr 派生） */
export interface ReviewCliArgs {
  readonly repo: string;
  readonly mr: string;
  /** 检视单元身份：--mr 文件名去扩展名（POC1 case 约定：一案一 diff 文件） */
  readonly caseId: string;
  readonly config: ConfigId;
  readonly issue: string;
  readonly out: string;
}

/** 解析结果：ok 或用法错误消息（调用方负责呈现与退出码） */
export type ParseReviewArgsResult =
  | { readonly ok: true; readonly args: ReviewCliArgs }
  | { readonly ok: false; readonly message: string };

export function parseReviewArgs(argv: readonly string[]): ParseReviewArgsResult {
  const [command, ...rest] = argv;
  if (command !== "review") {
    return {
      ok: false,
      message:
        argv.length === 0
          ? "missing command (expected `review`)"
          : `unknown command ${JSON.stringify(command)} (expected \`review\`)`,
    };
  }

  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (flag === undefined || !KNOWN_FLAGS.includes(flag)) {
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

  const repo = values.get("--repo");
  if (repo === undefined) {
    return { ok: false, message: "missing required flag --repo" };
  }
  const mr = values.get("--mr");
  if (mr === undefined) {
    return { ok: false, message: "missing required flag --mr" };
  }
  const configRaw = values.get("--config") ?? "A";
  if (!(configRaw in REVIEW_PRESETS)) {
    return { ok: false, message: `invalid --config ${JSON.stringify(configRaw)}: expected one of A, B, C, D, E` };
  }

  return {
    ok: true,
    args: {
      repo,
      mr,
      caseId: basename(mr).replace(/\.[^.]*$/, ""),
      config: configRaw as ConfigId,
      issue: values.get("--issue") ?? "",
      out: values.get("--out") ?? "review-agent-output",
    },
  };
}
