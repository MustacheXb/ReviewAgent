/**
 * #26 验收（进程内主缝）：CLI wrapper 的参数解析 + 结果呈现契约。
 *
 * wrapper 薄到只做参数透传 + 结果呈现（票面 AC4）——本文件锁的就是这两块的
 * 行为契约；检视行为本体（六阶段 / Gate / 审计）全部留在内核并已在进程内
 * 测试锁定，这里不重复。
 *
 * 锁线：
 * - 解析：`review --repo <path> --mr <file> [--config A–E] [--issue <text>]
 *   [--out <dir>]`——必填项缺席 / 未知旗标 / 重复旗标 / 值缺席（含值吞旗标）/
 *   config 越界都是用法错误（union 返回，不抛异常——用户输入错误是预期路径
 *   不是完整性事故）；
 * - 默认值契约（AC2）：config 缺省 = "A"（明确默认），issue 缺省 = ""，
 *   out 缺省 = "review-agent-output"；
 * - caseId 派生（--mr 文件名去扩展名）在解析缝锁定——wrapper 不自带身份
 *   政策；
 * - 呈现：stdout 形状 = 单个 JSON 文档（ok/caseId/configId/runId/truncated/
 *   rounds/toolCalls/findings/auditPath 全字段在）。
 */

import { describe, expect, it } from "vitest";

import {
  parseReviewArgs,
  type ReviewCliArgs,
  USAGE_TEXT,
} from "../../src/cli/args.js";
import { renderReviewOutcome, type ReviewOutcome } from "../../src/cli/render.js";
import { FINDING_F001 } from "../../../../tests/helpers/dsh-replies.js";

// ---------- 参数解析 ----------

describe("parseReviewArgs（#26）", () => {
  it("happy path：必填两项 + 其余缺省（config=A、issue=\"\"、out=review-agent-output）", () => {
    const parsed = parseReviewArgs(["review", "--repo", "/repos/sample", "--mr", "fix.diff"]);

    expect(parsed).toEqual({
      ok: true,
      args: {
        repo: "/repos/sample",
        mr: "fix.diff",
        caseId: "fix",
        config: "A",
        issue: "",
        out: "review-agent-output",
      } satisfies ReviewCliArgs,
    });
  });

  it("五配置可选（AC2）：--config B/C/D/E 透传，默认 A 明确", () => {
    for (const config of ["B", "C", "D", "E"] as const) {
      const parsed = parseReviewArgs(["review", "--repo", "r", "--mr", "m", "--config", config]);
      expect(parsed).toMatchObject({ ok: true, args: { config } });
    }
    expect(parseReviewArgs(["review", "--repo", "r", "--mr", "m"])).toMatchObject({
      ok: true,
      args: { config: "A" },
    });
  });

  it("issue / out 透传（MrInput 契约字段与输出目录）", () => {
    const parsed = parseReviewArgs([
      "review",
      "--repo",
      "r",
      "--mr",
      "m",
      "--issue",
      "Vulnerability fix",
      "--out",
      "/tmp/out",
    ]);
    expect(parsed).toEqual({
      ok: true,
      args: { repo: "r", mr: "m", caseId: "m", config: "A", issue: "Vulnerability fix", out: "/tmp/out" },
    });
  });

  it("caseId 派生（解析缝锁定）：--mr 文件名去扩展名，多级扩展名只去最后一级", () => {
    const derive = (mr: string): string => {
      const parsed = parseReviewArgs(["review", "--repo", "r", "--mr", mr]);
      expect(parsed).toMatchObject({ ok: true });
      return parsed.ok ? parsed.args.caseId : "<parse failed>";
    };
    expect(derive("fix-url-encoding.diff")).toBe("fix-url-encoding");
    expect(derive("a.b.c.patch")).toBe("a.b.c");
    expect(derive("no-extension")).toBe("no-extension");
    expect(derive("diffs/nested-path.diff")).toBe("nested-path");
  });

  it("用法错误（union 返回不抛）：缺 --repo / 缺 --mr / 缺命令", () => {
    const noRepo = parseReviewArgs(["review", "--mr", "m"]);
    expect(noRepo).toMatchObject({ ok: false });
    if (noRepo.ok === false) expect(noRepo.message).toContain("--repo");

    const noMr = parseReviewArgs(["review", "--repo", "r"]);
    expect(noMr).toMatchObject({ ok: false });
    if (noMr.ok === false) expect(noMr.message).toContain("--mr");

    const noCommand = parseReviewArgs([]);
    expect(noCommand).toMatchObject({ ok: false });
    if (noCommand.ok === false) expect(noCommand.message).toContain("review");
  });

  it("config 越界：F（或小写）→ 用法错误并列出 A–E", () => {
    const upper = parseReviewArgs(["review", "--repo", "r", "--mr", "m", "--config", "F"]);
    expect(upper).toMatchObject({ ok: false });
    if (upper.ok === false) {
      expect(upper.message).toContain("--config");
      for (const letter of ["A", "B", "C", "D", "E"]) {
        expect(upper.message).toContain(letter);
      }
    }
    expect(parseReviewArgs(["review", "--repo", "r", "--mr", "m", "--config", "a"])).toMatchObject({
      ok: false,
    });
  });

  it("未知旗标、值缺席与重复旗标：用法错误", () => {
    expect(parseReviewArgs(["review", "--repo", "r", "--mr", "m", "--wat", "x"])).toMatchObject({
      ok: false,
    });
    expect(parseReviewArgs(["review", "--repo"])).toMatchObject({ ok: false });
    const duplicate = parseReviewArgs(["review", "--repo", "r", "--repo", "r2", "--mr", "m"]);
    expect(duplicate).toMatchObject({ ok: false });
    if (duplicate.ok === false) expect(duplicate.message).toContain("--repo");
  });

  it("值吞旗标：`--issue --out x` 的 --out 不会被当成 --issue 的值", () => {
    const parsed = parseReviewArgs(["review", "--repo", "r", "--mr", "m", "--issue", "--out", "x"]);
    expect(parsed).toMatchObject({ ok: false });
    if (parsed.ok === false) expect(parsed.message).toContain("--issue");
  });

  it("用法文案：包含完整命令形状（烟测 stderr 的同款文案单一来源）", () => {
    expect(USAGE_TEXT).toContain("review-agent review --repo <path> --mr <diff-file>");
    expect(USAGE_TEXT).toContain("--config");
  });
});

// ---------- 结果呈现 ----------

describe("renderReviewOutcome（#26）", () => {
  const OUTCOME: ReviewOutcome = {
    caseId: "fix-url-encoding",
    configId: "A",
    runId: "20260911T120000Z-A-fix-url-encoding",
    truncated: false,
    rounds: 1,
    toolCalls: 0,
    findings: [FINDING_F001],
    auditPath: "D:\\audit\\run.json",
  };

  it("stdout 形状：单个 JSON 文档，全字段在（findings 结构化透传）", () => {
    const rendered = renderReviewOutcome(OUTCOME);

    // 整个 stdout 即一个 JSON 文档（可含尾随换行）
    expect(() => JSON.parse(rendered)).not.toThrow();
    const parsed = JSON.parse(rendered) as Record<string, unknown>;
    expect(parsed).toEqual({
      ok: true,
      caseId: "fix-url-encoding",
      configId: "A",
      runId: "20260911T120000Z-A-fix-url-encoding",
      truncated: false,
      rounds: 1,
      toolCalls: 0,
      findings: [FINDING_F001],
      auditPath: "D:\\audit\\run.json",
    });
  });

  it("空 Finding 集与截断标记如实呈现", () => {
    const rendered = renderReviewOutcome({ ...OUTCOME, findings: [], truncated: true, rounds: 5 });
    const parsed = JSON.parse(rendered) as Record<string, unknown>;
    expect(parsed.findings).toEqual([]);
    expect(parsed.truncated).toBe(true);
    expect(parsed.rounds).toBe(5);
  });
});
