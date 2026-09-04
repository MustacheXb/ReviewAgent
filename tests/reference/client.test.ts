import { describe, expect, it } from "vitest";
import {
  buildClaudeCodeArgs,
  ClaudeCodeClientError,
  ClaudeCodeCliClient,
  CLAUDE_CODE_ALLOWED_TOOLS,
  DEFAULT_CLAUDE_CODE_TIMEOUT_MS,
} from "../../src/reference/client.js";

/**
 * Claude Code CLI 客户端（Ticket 13）：参数构造纯函数层的安全纪律——
 * 模型 id 注入防线（shell 元字符拒绝）、--allowedTools 只读白名单、
 * 超时/轮数有界。零网络：不触达真实 claude 进程（e2e 门控冒烟覆盖）。
 */

const BASE_INPUT = { prompt: "review this", cwd: "D:/repo", model: "sonnet", maxTurns: 5 };

describe("buildClaudeCodeArgs", () => {
  it("无头调用参数契约：-p + json 输出 + 模型 + 轮数上界 + 只读工具白名单", () => {
    expect(buildClaudeCodeArgs(BASE_INPUT)).toEqual([
      "-p",
      "--output-format",
      "json",
      "--model",
      "sonnet",
      "--max-turns",
      "5",
      "--allowedTools",
      "Read,Grep,Glob",
    ]);
  });

  it("完整模型 id（带点与连字符）合法", () => {
    expect(
      buildClaudeCodeArgs({ ...BASE_INPUT, model: "claude-sonnet-4-5-20250929" }),
    ).toContain("claude-sonnet-4-5-20250929");
  });

  it("注入防线：shell 元字符模型 id 拒绝", () => {
    for (const evil of ["sonnet; rm -rf /", "a&b", "x|y", "$(whoami)", "mo`del`", "a b"]) {
      expect(() => buildClaudeCodeArgs({ ...BASE_INPUT, model: evil })).toThrow(
        ClaudeCodeClientError,
      );
    }
  });

  it("空模型 id / 超长模型 id 拒绝", () => {
    expect(() => buildClaudeCodeArgs({ ...BASE_INPUT, model: "" })).toThrow(ClaudeCodeClientError);
    expect(() =>
      buildClaudeCodeArgs({ ...BASE_INPUT, model: "a".repeat(101) }),
    ).toThrow(ClaudeCodeClientError);
  });

  it("maxTurns 非正整数拒绝（成本有界纪律）", () => {
    for (const bad of [0, -1, 2.5, Number.NaN]) {
      expect(() => buildClaudeCodeArgs({ ...BASE_INPUT, maxTurns: bad })).toThrow(
        ClaudeCodeClientError,
      );
    }
  });
});

describe("ClaudeCodeCliClient 构造", () => {
  it("缺省超时 10 分钟；非法 timeoutMs 拒绝", () => {
    expect(DEFAULT_CLAUDE_CODE_TIMEOUT_MS).toBe(600_000);
    expect(() => new ClaudeCodeCliClient()).not.toThrow();
    expect(() => new ClaudeCodeCliClient({ timeoutMs: 30_000 })).not.toThrow();
    for (const bad of [0, -1000, 1.5]) {
      expect(() => new ClaudeCodeCliClient({ timeoutMs: bad })).toThrow(ClaudeCodeClientError);
    }
  });

  it("claudePath 缺省 claude（经 PATH 解析）；空白回退缺省", () => {
    expect(() => new ClaudeCodeCliClient({ claudePath: "  " })).not.toThrow();
  });
});

describe("只读工具白名单纪律", () => {
  it("白名单恰为 Read / Grep / Glob——不含任何写/执行类工具", () => {
    expect(CLAUDE_CODE_ALLOWED_TOOLS).toEqual(["Read", "Grep", "Glob"]);
  });
});
