import { describe, expect, it } from "vitest";
import {
  cliOptionsToPlan,
  experimentCliUsage,
  parseExperimentArgs,
} from "../../src/experiment/cli.js";

/**
 * parseExperimentArgs 特征锁定测试（表驱动重构的行为零变化锚点）：
 * 覆盖 缺省值 / 内联 = 与空格取值 / 取值缺失 / 未知 flag / 枚举与数值校验 / 可重复参数。
 */

function parseOk(argv: readonly string[]): ReturnType<typeof parseExperimentArgs> {
  const parsed = parseExperimentArgs(argv);
  expect(parsed.ok, `expected ok for ${JSON.stringify(argv)}`).toBe(true);
  return parsed;
}

function parseFail(argv: readonly string[]): { readonly message: string; readonly usage: string } {
  const parsed = parseExperimentArgs(argv);
  expect(parsed.ok, `expected failure for ${JSON.stringify(argv)}`).toBe(false);
  if (parsed.ok) {
    throw new Error("unreachable");
  }
  return { message: parsed.message, usage: parsed.usage };
}

describe("parseExperimentArgs — 缺省与必填", () => {
  it("仅 --id：其余全缺省", () => {
    const parsed = parseOk(["--id", "poc1"]);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.options).toMatchObject({
      experimentId: "poc1",
      sources: ["defects4j", "vul4j", "msb-java", "clean-mr"],
      configs: ["A", "B", "C", "D", "E"],
      reps: 3,
      verifier: "off",
      model: "deepseek-v4-flash",
      highRiskOnly: false,
      perSourceLimit: null,
      caseFilter: [],
      judge: false,
      humanReviewRate: 0.1,
      humanReviewSeed: "poc1-human-review-2026",
      cleanMr: false,
      reportOnly: false,
      runsRoot: "runs",
    });
    expect(parsed.options.casesFile).toBeUndefined();
    expect(parsed.options.cleanMrRepoPath).toBeUndefined();
  });

  it("缺 --id 报错并附 usage", () => {
    const { message, usage } = parseFail(["--reps", "2"]);
    expect(message).toBe("--id is required");
    expect(usage).toBe(experimentCliUsage());
  });

  it("--help / -h 走失败通道（消息固定）", () => {
    expect(parseFail(["--help"]).message).toBe("--help requested");
    expect(parseFail(["-h"]).message).toBe("--help requested");
  });
});

describe("parseExperimentArgs — 取值形式", () => {
  it("空格取值与 --flag=value 等价", () => {
    expect(parseOk(["--id", "a", "--reps", "2"]).ok && parseOk(["--id", "a", "--reps=2"]).ok).toBe(true);
    const spaced = parseOk(["--id", "a", "--reps", "2"]);
    const inline = parseOk(["--id=a", "--reps=2"]);
    expect(spaced.ok && spaced.options.reps).toBe(inline.ok && inline.options.reps);
  });

  it("取值缺失（下一个 token 是 flag 或结尾）报 requires a value", () => {
    expect(parseFail(["--id", "a", "--reps", "--judge"]).message).toBe('flag --reps requires a value');
    expect(parseFail(["--id", "a", "--reps"]).message).toBe('flag --reps requires a value');
  });

  it("内联空串被接受为空值（--id= → 后续 --id is required）", () => {
    expect(parseFail(["--id="]).message).toBe("--id is required");
  });

  it("未知 flag 报错（消息内嵌 usage）", () => {
    const { message } = parseFail(["--id", "a", "--bogus"]);
    expect(message).toContain('unknown flag "--bogus"');
    expect(message).toContain("Usage: run-experiment [options]");
  });

  it("未知 flag 的内联值形态在错误中保留原 token", () => {
    const { message } = parseFail(["--id", "a", "--bogus=3"]);
    expect(message).toContain('unknown flag "--bogus=3"');
  });
});

describe("parseExperimentArgs — 列表 / 枚举 / 数值校验", () => {
  it("--sources 与 --configs 解析（configs 大小写不敏感）", () => {
    const parsed = parseOk(["--id", "a", "--sources", "defects4j,clean-mr", "--configs", "a,c"]);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.options.sources).toEqual(["defects4j", "clean-mr"]);
    expect(parsed.options.configs).toEqual(["A", "C"]);
  });

  it("列表：空项 / 未知项 / 重复项逐一报错", () => {
    expect(parseFail(["--id", "a", "--sources", " , "]).message).toContain("comma list of source names");
    expect(parseFail(["--id", "a", "--sources", "defects4j,github"]).message).toContain(
      "unknown source name(s): github",
    );
    expect(parseFail(["--id", "a", "--configs", "A,A"]).message).toContain(
      "config list must not contain duplicates",
    );
  });

  it("--verifier 只接受 off|on", () => {
    const parsed = parseOk(["--id", "a", "--verifier", "on"]);
    expect(parsed.ok && parsed.options.verifier).toBe("on");
    expect(parseFail(["--id", "a", "--verifier", "maybe"]).message).toBe(
      '--verifier must be "off" or "on" (got "maybe")',
    );
  });

  it("--model 接受别名与全名", () => {
    expect(parseOk(["--id", "a", "--model", "pro"]).ok && parseOk(["--id", "a", "--model", "deepseek-v4-pro"]).ok).toBe(true);
    const alias = parseOk(["--id", "a", "--model", "pro"]);
    const full = parseOk(["--id", "a", "--model", "deepseek-v4-pro"]);
    expect(alias.ok && alias.options.model).toBe(full.ok && full.options.model);
    expect(parseFail(["--id", "a", "--model", "gpt-9"]).message).toBe(
      '--model must be one of flash, deepseek-v4-flash, pro, deepseek-v4-pro (got "gpt-9")',
    );
  });

  it("--reps / --limit 拒绝非正整数", () => {
    expect(parseFail(["--id", "a", "--reps", "0"]).message).toBe('--reps must be an integer >= 1 (got "0")');
    expect(parseFail(["--id", "a", "--reps", "x"]).message).toBe('--reps must be an integer >= 1 (got "x")');
    expect(parseFail(["--id", "a", "--limit", "-1"]).message).toBe('--limit must be an integer >= 1 (got "-1")');
    const parsed = parseOk(["--id", "a", "--limit", "5"]);
    expect(parsed.ok && parsed.options.perSourceLimit).toBe(5);
  });

  it("--human-review-rate 限 (0,1]、--human-review-seed 非空", () => {
    expect(parseFail(["--id", "a", "--human-review-rate", "0"]).message).toBe(
      '--human-review-rate must be a number in (0, 1] (got "0")',
    );
    expect(parseFail(["--id", "a", "--human-review-rate", "1.1"]).message).toBe(
      '--human-review-rate must be a number in (0, 1] (got "1.1")',
    );
    expect(parseFail(["--id", "a", "--human-review-seed", "  "]).message).toBe(
      "--human-review-seed must be a non-empty string",
    );
    const parsed = parseOk(["--id", "a", "--human-review-rate", "0.25", "--human-review-seed", "seed-x"]);
    expect(parsed.ok && parsed.options.humanReviewRate).toBe(0.25);
  });
});

describe("parseExperimentArgs — 布尔 flag 与可重复参数", () => {
  it("布尔 flag：--clean-mr / --high-risk-only / --judge / --report-only", () => {
    const parsed = parseOk(["--id", "a", "--clean-mr", "--high-risk-only", "--judge", "--report-only"]);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.options.cleanMr).toBe(true);
    expect(parsed.options.highRiskOnly).toBe(true);
    expect(parsed.options.judge).toBe(true);
    expect(parsed.options.reportOnly).toBe(true);
  });

  it("--clean-mr 未提供 repo 时填充占位路径（A/B 零工具不读取）", () => {
    const parsed = parseOk(["--id", "a", "--clean-mr"]);
    expect(parsed.ok && parsed.options.cleanMrRepoPath).toBe("./clean-mr-placeholder-repo");
    const withRepo = parseOk(["--id", "a", "--clean-mr", "--clean-mr-repo", "D:/repos/clean"]);
    expect(withRepo.ok && withRepo.options.cleanMrRepoPath).toBe("D:/repos/clean");
  });

  it("--case 可重复累积，空值报错", () => {
    const parsed = parseOk(["--id", "a", "--case", "c-1", "--case=c-2"]);
    expect(parsed.ok && parsed.options.caseFilter).toEqual(["c-1", "c-2"]);
    expect(parseFail(["--id", "a", "--case", ""]).message).toBe("--case requires a non-empty caseId");
  });

  it("--cases-file / --runs-root 透传", () => {
    const parsed = parseOk(["--id", "a", "--cases-file", "ds.json", "--runs-root", "out/runs"]);
    expect(parsed.ok && parsed.options.casesFile).toBe("ds.json");
    expect(parsed.ok && parsed.options.runsRoot).toBe("out/runs");
  });
});

describe("cliOptionsToPlan — 校验透传", () => {
  it("合法选项产出合法计划（v4-pro + highRiskOnly）", () => {
    const parsed = parseOk(["--id", "a", "--model", "pro", "--high-risk-only", "--sources", "defects4j"]);
    if (!parsed.ok) throw new Error("unreachable");
    const plan = cliOptionsToPlan(parsed.options);
    expect(plan.model).toBe("deepseek-v4-pro");
    expect(plan.highRiskOnly).toBe(true);
  });

  it("v4-pro 未开 highRiskOnly 时由计划校验拦截", () => {
    const parsed = parseOk(["--id", "a", "--model", "pro"]);
    if (!parsed.ok) throw new Error("unreachable");
    expect(() => cliOptionsToPlan(parsed.options)).toThrow(/highRiskOnly/);
  });
});
