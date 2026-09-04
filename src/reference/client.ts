import { spawn } from "node:child_process";
import type {
  ClaudeCodeClient,
  ClaudeCodeRunInput,
  ClaudeCodeRunOutput,
} from "./contracts.js";

/**
 * Claude Code CLI 真实客户端（Ticket 13 / issue #14）。
 *
 * 无头调用契约（本机 claude CLI 2.1.241 实测）：
 * - `claude -p --output-format json --model <id> --max-turns <n>`，
 *   提示词经 stdin 注入（diff 可达 2K 行，命令行参数有长度上限，不可作参数传递）；
 * - stdout 为单条 JSON（result / usage / num_turns / total_cost_usd / modelUsage 等，
 *   解析归 normalize.ts）；诊断信息走 stderr；
 * - `--version` 输出版本号（随运行留档，支撑可复现性）。
 *
 * 安全纪律：
 * - 绝不使用 --dangerously-skip-permissions；--allowedTools 显式白名单只读工具
 *   （Read / Grep / Glob），未授权工具由 CLI 记入 permission_denials（留痕）；
 * - shell: true 仅为兼容 Windows .cmd 启动器；所有参数为程序控制的白名单值，
 *   模型 id 经严格字符校验（杜绝 shell 元字符注入）；
 * - 子进程环境原样透传（本实测：代理型后端依赖 CLI 自身注入的环境变量做模型
 *   路由，剔除 CLAUDECODE 等变量会直接导致 unrecognized_model）；
 *   认证沿用 CLI 自身配置（本 harness 不经手任何凭据）。
 */

/** 只读工具白名单：检视需要仓库读取与检索，禁止一切写/执行类工具 */
export const CLAUDE_CODE_ALLOWED_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];

/** 模型 id 字符白名单（经 shell 传递前的注入防线） */
const MODEL_ID_RE = /^[A-Za-z0-9._-]{1,100}$/;

export const DEFAULT_CLAUDE_CODE_TIMEOUT_MS = 600_000;
const VERSION_TIMEOUT_MS = 30_000;
const STDERR_SNIPPET_LENGTH = 400;

export class ClaudeCodeClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeCodeClientError";
  }
}

export interface ClaudeCodeCliClientOptions {
  /** claude 可执行文件（缺省 "claude"，经 PATH 解析） */
  readonly claudePath?: string;
  /** 单次检视调用的墙钟超时（毫秒；缺省 10 分钟） */
  readonly timeoutMs?: number;
  /** 子进程环境注入（缺省 process.env；测试/e2e 可覆盖） */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** 无头调用的参数构造（纯函数：全部为程序控制的白名单值） */
export function buildClaudeCodeArgs(input: ClaudeCodeRunInput): readonly string[] {
  if (!MODEL_ID_RE.test(input.model)) {
    throw new ClaudeCodeClientError(
      `claude model id must match ${MODEL_ID_RE.source} (got ${JSON.stringify(input.model)})`,
    );
  }
  if (!Number.isInteger(input.maxTurns) || input.maxTurns < 1) {
    throw new ClaudeCodeClientError(
      `maxTurns must be a positive integer (got ${JSON.stringify(input.maxTurns)})`,
    );
  }
  return [
    "-p",
    "--output-format",
    "json",
    "--model",
    input.model,
    "--max-turns",
    String(input.maxTurns),
    "--allowedTools",
    CLAUDE_CODE_ALLOWED_TOOLS.join(","),
  ];
}

export class ClaudeCodeCliClient implements ClaudeCodeClient {
  private readonly claudePath: string;
  private readonly timeoutMs: number;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private versionCache: string | null = null;

  constructor(options: ClaudeCodeCliClientOptions = {}) {
    this.claudePath = options.claudePath?.trim() || "claude";
    this.timeoutMs =
      options.timeoutMs === undefined
        ? DEFAULT_CLAUDE_CODE_TIMEOUT_MS
        : options.timeoutMs;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new ClaudeCodeClientError(
        `timeoutMs must be a positive integer (got ${JSON.stringify(options.timeoutMs)})`,
      );
    }
    this.env = options.env ?? process.env;
  }

  async run(input: ClaudeCodeRunInput): Promise<ClaudeCodeRunOutput> {
    const args = buildClaudeCodeArgs(input);
    return new Promise<ClaudeCodeRunOutput>((resolve, reject) => {
      const child = spawn(this.claudePath, args, {
        cwd: input.cwd,
        shell: true,
        env: this.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, this.timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(
          new ClaudeCodeClientError(
            `failed to spawn claude CLI (${this.claudePath}): ${error.message}`,
          ),
        );
      });
      child.on("close", (exitCode) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (timedOut) {
          reject(
            new ClaudeCodeClientError(
              `claude CLI timed out after ${this.timeoutMs}ms (cwd: ${input.cwd})`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr, exitCode, timedOut: false });
      });
      // 提示词经 stdin 注入（长 diff 不受命令行长度限制；写失败由 close/error 路径兜底）
      child.stdin?.on("error", (error) => {
        stderr += `\n[stdin write failed] ${error.message}`;
      });
      child.stdin?.end(input.prompt, "utf8");
    });
  }

  async version(): Promise<string> {
    if (this.versionCache !== null) {
      return this.versionCache;
    }
    const version = await new Promise<string>((resolve, reject) => {
      const child = spawn(this.claudePath, ["--version"], {
        shell: true,
        env: this.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        child.kill();
      }, VERSION_TIMEOUT_MS);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(
          new ClaudeCodeClientError(
            `failed to spawn claude CLI for --version (${this.claudePath}): ${error.message}`,
          ),
        );
      });
      child.on("close", (exitCode) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (exitCode !== 0) {
          reject(
            new ClaudeCodeClientError(
              `claude --version exited with ${exitCode}: ${truncate(stderr.trim(), STDERR_SNIPPET_LENGTH)}`,
            ),
          );
          return;
        }
        const parsed = stdout.trim();
        if (parsed.length === 0) {
          reject(new ClaudeCodeClientError("claude --version produced empty output"));
          return;
        }
        resolve(parsed);
      });
    });
    this.versionCache = version;
    return version;
  }
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}
