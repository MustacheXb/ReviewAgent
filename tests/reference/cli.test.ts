import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClaudeCodeClient } from "../../src/reference/contracts.js";
import {
  parseReferenceArgs,
  referenceCliOptionsToPlan,
  runClaudeCodeReferenceCli,
} from "../../src/reference/cli.js";
import { CLAUDE_CODE_PROMPT_TEMPLATE_VERSION } from "../../src/reference/prompt.js";
import {
  claudeStdout,
  FakeClaudeCodeClient,
  failedRunOutput,
  findingJson,
  okRunOutput,
  referenceCleanCase,
  referenceMainCase,
} from "./helpers.js";
import type { FakeScriptEntry } from "./helpers.js";

/**
 * 外部参照 CLI（Ticket 13）：参数解析纯函数 + 主流程装配。
 * 零网络：client 全部注入 FakeClaudeCodeClient；数据集经临时 cases 文件。
 * 退出码纪律：0 = 完成；1 = 零记录（全量失败）；2 = 用法/配置错误。
 */

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "review-agent-ref-cli-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function writeCasesFile(name: string, cases: unknown[]): Promise<string> {
  const filePath = path.join(workDir, `${name}.json`);
  await writeFile(filePath, JSON.stringify(cases), "utf8");
  return filePath;
}

function fakeDeps(script: readonly FakeScriptEntry[]): {
  readonly deps: {
    readonly createClient: (options: { readonly timeoutMs: number }) => ClaudeCodeClient;
    readonly log: (line: string) => void;
  };
  readonly client: FakeClaudeCodeClient;
  readonly lines: readonly string[];
} {
  const client = FakeClaudeCodeClient.fromOutputs(script);
  const lines: string[] = [];
  return {
    client,
    lines,
    deps: {
      createClient: () => client,
      log: (line) => lines.push(line),
    },
  };
}

describe("parseReferenceArgs", () => {
  it("缺省值：reps 1 / model sonnet / maxTurns 5 / timeout 600000 / 全源 / runs", () => {
    const parsed = parseReferenceArgs(["--id", "ref-1"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.options).toMatchObject({
        referenceId: "ref-1",
        sources: ["defects4j", "vul4j", "msb-java", "clean-mr"],
        reps: 1,
        model: "sonnet",
        maxTurns: 5,
        timeoutMs: 600_000,
        perSourceLimit: null,
        caseFilter: [],
        cleanMr: false,
        reportOnly: false,
        runsRoot: "runs",
      });
      expect(parsed.options.casesFile).toBeUndefined();
    }
  });

  it("--flag=value 与 --case 可重复", () => {
    const parsed = parseReferenceArgs([
      "--id=ref-2",
      "--case=a",
      "--case=b",
      "--sources=defects4j,clean-mr",
      "--limit=3",
      "--reps=2",
    ]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.options.referenceId).toBe("ref-2");
      expect(parsed.options.caseFilter).toEqual(["a", "b"]);
      expect(parsed.options.sources).toEqual(["defects4j", "clean-mr"]);
      expect(parsed.options.perSourceLimit).toBe(3);
      expect(parsed.options.reps).toBe(2);
    }
  });

  it("必填与校验：--id 必填、未知 flag / 非法数值 / 未知源给 usage", () => {
    expect(parseReferenceArgs([]).ok).toBe(false);
    expect(parseReferenceArgs(["--id", "x", "--bogus"]).ok).toBe(false);
    expect(parseReferenceArgs(["--id", "x", "--reps", "0"]).ok).toBe(false);
    expect(parseReferenceArgs(["--id", "x", "--max-turns", "1.5"]).ok).toBe(false);
    expect(parseReferenceArgs(["--id", "x", "--timeout-ms", "10"]).ok).toBe(false);
    expect(parseReferenceArgs(["--id", "x", "--limit", "-1"]).ok).toBe(false);
    expect(parseReferenceArgs(["--id", "x", "--sources", "typo"]).ok).toBe(false);
    const missing = parseReferenceArgs(["--id", "x", "--model"]);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.message).toContain("requires a value");
      expect(missing.usage).toContain("--id <id>");
    }
  });

  it("model 两端空白被裁剪（CLI 别名容错）", () => {
    const parsed = parseReferenceArgs(["--id", "x", "--model", "  opus  "]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.options.model).toBe("opus");
    }
  });
});

describe("referenceCliOptionsToPlan", () => {
  it("映射齐全且 promptTemplateVersion 锁当前模板", () => {
    const parsed = parseReferenceArgs(["--id", "plan-1", "--model", "opus", "--max-turns", "8"]);
    if (!parsed.ok) {
      throw new Error("parse failed");
    }
    const plan = referenceCliOptionsToPlan(parsed.options);
    expect(plan).toMatchObject({
      referenceId: "plan-1",
      model: "opus",
      maxTurns: 8,
      promptTemplateVersion: CLAUDE_CODE_PROMPT_TEMPLATE_VERSION,
    });
  });

  it("非法模型 id（shell 元字符）与非 Claude 系模型族在计划层被拒", () => {
    const parsed = parseReferenceArgs(["--id", "plan-2", "--model", "sonnet; rm"]);
    if (!parsed.ok) {
      throw new Error("parse failed");
    }
    expect(() => referenceCliOptionsToPlan(parsed.options)).toThrow(/model/);
    const foreign = parseReferenceArgs(["--id", "plan-3", "--model", "gpt-5.2-pro"]);
    if (!foreign.ok) {
      throw new Error("parse failed");
    }
    expect(() => referenceCliOptionsToPlan(foreign.options)).toThrow(/Claude-family/);
  });
});

describe("runClaudeCodeReferenceCli（主流程）", () => {
  it("快乐路径：exit 0，报告/Dashboard/记录全落盘，外部参照标注打印", async () => {
    const casesFile = await writeCasesFile("cli-happy", [
      referenceMainCase("cli-main-001"),
      referenceCleanCase("cli-clean-001"),
    ]);
    const { deps, lines, client } = fakeDeps([
      okRunOutput(claudeStdout({ findings: [findingJson("F001")] })),
      okRunOutput(claudeStdout({ findings: [findingJson("F002", { line: 25 })] })),
    ]);
    const runsRoot = path.join(workDir, "runs-happy");
    const exitCode = await runClaudeCodeReferenceCli(
      ["--id", "cli-happy", "--cases-file", casesFile, "--runs-root", runsRoot],
      deps,
    );
    expect(exitCode).toBe(0);
    expect(client.runInputs).toHaveLength(2);
    // 进度与收尾日志
    expect(lines.some((l) => l.includes("cli-main-001") && l.includes("completed"))).toBe(true);
    expect(lines.some((l) => l.includes("EXCLUDED from the S/A/B main verdict"))).toBe(true);
    // 产物：claude-code/<id>/ 下 report / dashboard / plan / cases / 记录
    const root = path.join(runsRoot, "claude-code", "cli-happy");
    const report = JSON.parse(
      await readFile(path.join(root, "reference-report.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(report.kind).toBe("claude-code-external-reference");
    expect(report.verdicts).toBeNull();
    expect(report.excludedFromMainVerdict).toBe(true);
    const dashboard = await readFile(path.join(root, "reference-dashboard.md"), "utf8");
    expect(dashboard).toContain("NOT part of the S/A/B main verdict");
    const record = JSON.parse(
      await readFile(path.join(root, "runs", "defects4j", "cli-main-001", "rep-1.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(record).toMatchObject({ caseId: "cli-main-001", status: "ok" });
  });

  it("--case 过滤 + 单元失败隔离：exit 0（部分失败不改变退出码），failures.json 留痕", async () => {
    const casesFile = await writeCasesFile("cli-filter", [
      referenceMainCase("cli-a"),
      referenceMainCase("cli-b"),
    ]);
    const { deps, lines } = fakeDeps([
      failedRunOutput("quota exceeded", 1),
      okRunOutput(claudeStdout({ findings: [findingJson("F001")] })),
    ]);
    const runsRoot = path.join(workDir, "runs-filter");
    const exitCode = await runClaudeCodeReferenceCli(
      [
        "--id",
        "cli-filter",
        "--cases-file",
        casesFile,
        "--case",
        "cli-a",
        "--case",
        "cli-b",
        "--runs-root",
        runsRoot,
      ],
      deps,
    );
    expect(exitCode).toBe(0);
    expect(lines.some((l) => l.includes("FAILED") && l.includes("exited with code 1"))).toBe(true);
    const root = path.join(runsRoot, "claude-code", "cli-filter");
    const failures = JSON.parse(
      await readFile(path.join(root, "failures.json"), "utf8"),
    ) as unknown[];
    expect(failures).toEqual([
      { source: "defects4j", caseId: "cli-a", rep: 1, message: expect.stringContaining("code 1") },
    ]);
  });

  it("全量失败：exit 1（零记录）", async () => {
    const casesFile = await writeCasesFile("cli-allfail", [referenceMainCase("cli-fail")]);
    const { deps } = fakeDeps([failedRunOutput("down", 1)]);
    const exitCode = await runClaudeCodeReferenceCli(
      ["--id", "cli-allfail", "--cases-file", casesFile, "--runs-root", path.join(workDir, "runs-allfail")],
      deps,
    );
    expect(exitCode).toBe(1);
  });

  it("用法/配置错误：exit 2（未知 flag / 缺 --id / 非法计划）", async () => {
    const { deps } = fakeDeps([]);
    expect(await runClaudeCodeReferenceCli(["--bogus"], deps)).toBe(2);
    expect(await runClaudeCodeReferenceCli([], deps)).toBe(2);
    expect(
      await runClaudeCodeReferenceCli(
        ["--id", "bad model", "--model", "a;b", "--runs-root", path.join(workDir, "runs-bad")],
        deps,
      ),
    ).toBe(2);
    // 非 Claude 系模型族：外部参照不得请求（计划层 fail fast，exit 2）
    const { deps: foreignDeps, lines } = fakeDeps([]);
    expect(
      await runClaudeCodeReferenceCli(
        [
          "--id",
          "foreign-model",
          "--model",
          "deepseek-v4-flash",
          "--runs-root",
          path.join(workDir, "runs-foreign"),
        ],
        foreignDeps,
      ),
    ).toBe(2);
    expect(lines.some((l) => l.includes("Claude-family"))).toBe(true);
  });

  it("零匹配单元（过滤不命中）：exit 2", async () => {
    const casesFile = await writeCasesFile("cli-nomatch", [referenceMainCase("cli-x")]);
    const { deps, lines } = fakeDeps([]);
    const exitCode = await runClaudeCodeReferenceCli(
      [
        "--id",
        "cli-nomatch",
        "--cases-file",
        casesFile,
        "--case",
        "no-such-case",
        "--runs-root",
        path.join(workDir, "runs-nomatch"),
      ],
      deps,
    );
    expect(exitCode).toBe(2);
    expect(lines.some((l) => l.includes("planned 0 units"))).toBe(true);
  });

  it("数据集为空：exit 2", async () => {
    const casesFile = await writeCasesFile("cli-empty", []);
    const { deps, lines } = fakeDeps([]);
    const exitCode = await runClaudeCodeReferenceCli(
      ["--id", "cli-empty", "--cases-file", casesFile, "--runs-root", path.join(workDir, "runs-empty")],
      deps,
    );
    expect(exitCode).toBe(2);
    expect(lines.some((l) => l.includes("no cases loaded"))).toBe(true);
  });

  it("--report-only：从落盘记录重建报告，零 claude 调用（createClient 不被触达）", async () => {
    const casesFile = await writeCasesFile("cli-reportonly", [referenceMainCase("cli-ro-1")]);
    const runsRoot = path.join(workDir, "runs-reportonly");
    const seeded = fakeDeps([okRunOutput(claudeStdout({ findings: [findingJson("F001")] }))]);
    expect(
      await runClaudeCodeReferenceCli(
        ["--id", "cli-ro", "--cases-file", casesFile, "--runs-root", runsRoot],
        seeded.deps,
      ),
    ).toBe(0);

    const lines: string[] = [];
    let clientCreated = false;
    const exitCode = await runClaudeCodeReferenceCli(
      ["--id", "cli-ro", "--report-only", "--runs-root", runsRoot],
      {
        createClient: () => {
          clientCreated = true;
          return FakeClaudeCodeClient.fromOutputs([]);
        },
        log: (line) => lines.push(line),
      },
    );
    expect(exitCode).toBe(0);
    expect(clientCreated).toBe(false);
    expect(lines.some((l) => l.includes("report-only rebuild"))).toBe(true);
    // 重建报告与首跑一致
    const report = JSON.parse(
      await readFile(
        path.join(runsRoot, "claude-code", "cli-ro", "reference-report.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(report.caseCount).toBe(1);
    expect(report.executed).toBe(0);
    expect(report.resumed).toBe(1);
  });

  it("续跑（同 id 再跑）：已缓存单元跳过，exit 0", async () => {
    const casesFile = await writeCasesFile("cli-resume", [referenceMainCase("cli-res-1")]);
    const runsRoot = path.join(workDir, "runs-resume");
    const first = fakeDeps([okRunOutput(claudeStdout({ findings: [findingJson("F001")] }))]);
    expect(
      await runClaudeCodeReferenceCli(
        ["--id", "cli-resume", "--cases-file", casesFile, "--runs-root", runsRoot],
        first.deps,
      ),
    ).toBe(0);
    const second = fakeDeps([]);
    const exitCode = await runClaudeCodeReferenceCli(
      ["--id", "cli-resume", "--cases-file", casesFile, "--runs-root", runsRoot],
      second.deps,
    );
    expect(exitCode).toBe(0);
    expect(second.client.runInputs).toHaveLength(0);
    expect(second.lines.some((l) => l.includes("resumed (cached)"))).toBe(true);
  });
});
