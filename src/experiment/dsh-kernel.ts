/**
 * #27 DSH 内核驱动：实验 runner 侧的长驻内核进程客户端。
 *
 * 进程边界 = SDK JSON-RPC wire（@deepseek-ai/dsh-sdk-protocol 的
 * JsonRpcLineTransport——newline-delimited JSON-RPC 2.0 over stdio，与
 * dsh-sdk-client / Python SDK 同一线上协议）；host 进程 = 仓库内 review-dsh
 * 包的产品面 bin（bin/review-kernel-host.js，在位检查 + 按需编译 + 透传）。
 * sdk-client 的公开面绑死 dsh bin 启动（dshBin 走包清单版本门），通用进程
 * 构造器是内部导出——故进程管理（spawn / 拆解阶梯）在此自持，wire 层仍
 * 100% SDK 件。
 *
 * 生命周期：一个 driver = 一个 host 进程，整批单元复用（不为单元 spawn）；
 * close = 协议 shutdown（有界）→ stdin EOF → SIGTERM → SIGKILL 阶梯。
 * 凭据经环境变量透传（DEEPSEEK_API_KEY / DEEPSEEK_URL），不落代码与日志。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";

import { CONFIGS, type ConfigId, REFERENCE_CONFIG_ID } from "../contracts/config.js";
import type { RunResult } from "../contracts/run.js";

/** 单元请求（host 的 review/run 参数；configId 逐单元切换 preset） */
export interface DshKernelUnitRequest {
  readonly configId: ConfigId;
  readonly caseId: string;
  readonly issueDescription: string;
  readonly diff: string;
  readonly repoPath?: string;
  readonly auditDir: string;
}

export interface DshKernelDriverOptions {
  /** 子进程环境（凭据注入；缺省透传 process.env——host 侧适配器构造期 fail fast） */
  readonly env?: NodeJS.ProcessEnv;
}

export interface DshKernelDriver {
  /** 驱动一个检视单元：POC1 RunResult（+ auditPath；审计文件由 host 落盘） */
  runUnit(request: DshKernelUnitRequest): Promise<RunResult>;
  /** 拆解 host 进程（幂等；协议 shutdown 优先，阶梯兜底） */
  close(): Promise<void>;
}

const SHUTDOWN_TIMEOUT_MS = 5_000;
const EOF_GRACE_MS = 6_000;
const KILL_GRACE_MS = 3_000;

/** host bin 相对标记（repo 根下的既定位置） */
const HOST_BIN_RELATIVE_PATH = join("packages", "review-dsh", "bin", "review-kernel-host.js");

/** 上溯层数上界（源树两级 / 编译树三级；给嵌套部署形态留余量） */
const HOST_BIN_ANCESTRY_LIMIT = 6;

/**
 * 自给定目录逐级上溯定位 host bin（repo 根标记探测）。
 * 源树（src/experiment/）与编译树（.tmp-gen/src/experiment/——`pnpm experiment`
 * 产物镜像 repo 根相对结构）对本模块的深度不同：固定层级假设在编译树里解析到
 * 不存在的路径，host 子进程秒死 MODULE_NOT_FOUND、单元以「JSON-RPC input
 * closed」失败（#29 冒烟现场）。按标记上溯对两种形态统一成立；找不到即
 * fail fast 并列出探测过的路径。
 */
export function resolveHostBinPath(fromDir: string): string {
  const tried: string[] = [];
  let dir = fromDir;
  for (let depth = 0; depth < HOST_BIN_ANCESTRY_LIMIT; depth += 1) {
    const candidate = join(dir, HOST_BIN_RELATIVE_PATH);
    if (existsSync(candidate)) {
      return candidate;
    }
    tried.push(candidate);
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error(
    `dsh-kernel: review-kernel-host bin not found (searched ${HOST_BIN_ANCESTRY_LIMIT} ancestors of ${fromDir} for ${HOST_BIN_RELATIVE_PATH}):\n${tried.join("\n")}`,
  );
}

/** host bin 的缺省位置（本模块目录起按 repo 根标记上溯） */
function defaultHostBinPath(): string {
  return resolveHostBinPath(dirname(fileURLToPath(import.meta.url)));
}

export function createDshKernelDriver(options: DshKernelDriverOptions = {}): DshKernelDriver {
  const child = spawn(process.execPath, [defaultHostBinPath()], {
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = child.stdout;
  const stdin = child.stdin;
  if (stdout === null || stdin === null) {
    // stdio pipe 配置下不可达（防御值：spawn 已带 pipe 三元组）
    child.kill();
    throw new Error("dsh-kernel: host process spawned without piped stdio");
  }
  const transport = new JsonRpcLineTransport(stdout, stdin);
  transport.start();
  // host 已死时，close 阶梯的 shutdown 写入打到断管以 socket 'error' 事件冒出
  // （EPIPE 不在 transport.request 的拒绝面内，未处理会炸掉 runner 本体）——
  // 对已死进程的拆解是预期路径，吞掉写侧错误；逻辑失败已由 pending 拒绝面回报
  stdin.on("error", () => {});
  const stderrTail: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail.push(chunk.toString("utf8"));
    if (stderrTail.length > 20) {
      stderrTail.shift();
    }
  });
  const exited = new Promise<void>((resolveExit) => {
    child.once("exit", () => {
      transport.close();
      resolveExit();
    });
  });

  async function request(method: string, params: object): Promise<unknown> {
    return await transport.request(method, params);
  }

  return {
    async runUnit(unit: DshKernelUnitRequest): Promise<RunResult> {
      const response = await request("review/run", {
        configId: unit.configId,
        caseId: unit.caseId,
        issueDescription: unit.issueDescription,
        diff: unit.diff,
        ...(unit.repoPath !== undefined ? { repoPath: unit.repoPath } : {}),
        auditDir: unit.auditDir,
      });
      return parseRunResult(response, stderrTail.join(""));
    },
    close: async (): Promise<void> => {
      // 1) 协议 shutdown（有界 best-effort；host 回帧后以 0 退出）
      await Promise.race([
        request("shutdown", {}).catch(() => undefined),
        delay(SHUTDOWN_TIMEOUT_MS),
      ]);
      // 2) stdin EOF → SIGTERM → SIGKILL 阶梯（host 对 EOF/信号均以 0 退出）
      stdin.end();
      if (await withTimeout(exited, EOF_GRACE_MS)) {
        return;
      }
      child.kill("SIGTERM");
      if (await withTimeout(exited, KILL_GRACE_MS)) {
        return;
      }
      child.kill("SIGKILL");
      await exited;
    },
  };
}

/**
 * 进程边界响应校验（输入校验纪律的适用范围如实声明）：顶层容器与立即消费的
 * 字段实查（字符串 / 有限数 / configId ∈ 已知集合 / findings 元素为对象 /
 * usage token 数值），元素内部形状不再逐字段复验——与 POC1 持久化记录的
 * 读取约定同水位（`raw as ExperimentPlan` 先例）；错配即 fail fast。
 */
function parseRunResult(response: unknown, stderrTail: string): RunResult {
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    throw new Error(
      `dsh-kernel: host returned a malformed review/run response (${describe(response)}); stderr tail: ${stderrTail.trim()}`,
    );
  }
  const record = response as Record<string, unknown>;
  const stringField = (key: string): string => {
    const value = record[key];
    if (typeof value !== "string") {
      throw new Error(`dsh-kernel: review/run response field "${key}" must be a string`);
    }
    return value;
  };
  const numberField = (key: string): number => {
    const value = record[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`dsh-kernel: review/run response field "${key}" must be a finite number`);
    }
    return value;
  };
  const findings = record.findings;
  const audit = record.audit;
  const usage = record.usage;
  if (!Array.isArray(findings) || findings.some(isNotPlainObject)) {
    throw new Error(`dsh-kernel: review/run response field "findings" must be an array of objects`);
  }
  if (isNotPlainObject(audit)) {
    throw new Error(`dsh-kernel: review/run response field "audit" must be an object`);
  }
  if (!isUsageShape(usage)) {
    throw new Error(
      `dsh-kernel: review/run response field "usage" must be an object with finite token counts`,
    );
  }
  return {
    caseId: stringField("caseId"),
    configId: requireKnownConfigId(record),
    findings: findings as RunResult["findings"],
    usage: usage as RunResult["usage"],
    rounds: numberField("rounds"),
    toolCalls: numberField("toolCalls"),
    audit: audit as RunResult["audit"],
    auditPath: stringField("auditPath"),
  };
}

/** 非「普通对象」判定（不收窄类型——回投走 unknown 单转换，避免双向断言） */
function isNotPlainObject(value: unknown): boolean {
  return typeof value !== "object" || value === null || Array.isArray(value);
}

/** usage 的 token 数值形状（inputTokens / outputTokens 为非负有限数） */
function isUsageShape(value: unknown): boolean {
  if (isNotPlainObject(value)) {
    return false;
  }
  const fields = value as Record<string, unknown>;
  const isTokenCount = (input: unknown): input is number =>
    typeof input === "number" && Number.isFinite(input) && input >= 0;
  return isTokenCount(fields.inputTokens) && isTokenCount(fields.outputTokens);
}

/** host 回显的 configId 必须落在已知配置键全集（A–E + 外部参照单列）内 */
function requireKnownConfigId(record: Record<string, unknown>): RunResult["configId"] {
  const value = record.configId;
  const known = new Set<string>([...Object.keys(CONFIGS), REFERENCE_CONFIG_ID]);
  if (typeof value !== "string" || !known.has(value)) {
    throw new Error(
      `dsh-kernel: review/run response field "configId" must be one of ${[...known].join(", ")}`,
    );
  }
  return value as RunResult["configId"];
}

function describe(value: unknown): string {
  return value === null ? "null" : typeof value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

/** 有界等待：超时返回 false（不拒绝——阶梯语义是「还没退就升级」） */
function withTimeout(promise: Promise<void>, ms: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    delay(ms).then(() => false),
  ]);
}
