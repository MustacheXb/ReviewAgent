/**
 * #26/#46 验收（进程内主缝）：CLI wrapper 的参数解析 + 结果呈现契约。
 *
 * wrapper 薄到只做参数透传 + 结果呈现（票面 AC4）——本文件锁的就是这两块的
 * 行为契约；检视行为本体（六阶段 / Gate / 审计）全部留在内核并已在进程内
 * 测试锁定，这里不重复。
 *
 * 锁线：
 * - 解析：`review --repo <path> --mr <file> [--config A–E] [--issue <text>]
 *   [--out <dir>] [--model <id>]` 与 `smoke [--model <id>]`（#46 网关冒烟
 *   子命令）——必填项缺席 / 未知命令 / 未知旗标 / 重复旗标 / 值缺席（含值吞
 *   旗标）/ config 越界都是用法错误（union 返回，不抛异常——用户输入错误是
 *   预期路径不是完整性事故）；
 * - 默认值契约（AC2）：config 缺省 = "A"（明确默认），issue 缺省 = ""，
 *   out 缺省 = "review-agent-output"，model 缺省 = deepseek-v4-flash；
 * - caseId 派生（--mr 文件名去扩展名）在解析缝锁定——wrapper 不自带身份
 *   政策；
 * - 呈现：stdout 形状 = 单个 JSON 文档（ok/caseId/configId/runId/truncated/
 *   rounds/toolCalls/findings/auditPath 全字段在）；
 * - #56 切分内建：CLI 输入 → MRCase（检视四字段直传、truth 恒 null、labels
 *   中性载体）；超界合并呈现 = ok 包络 + 跨片求和摘要（rounds/toolCalls/
 *   usage 之和、truncated 任一片）+ shards 节 + shardIds 溯源，顶层不带
 *   runId/auditPath（多片无单一关联键，关联键在各片条目）。
 */

import { describe, expect, it } from "vitest";

import {
  parseCliArgs,
  type ReviewCliArgs,
  type SmokeCliArgs,
  USAGE_TEXT,
} from "../../src/cli/args.js";
import { cliMrCase } from "../../src/cli/orchestration.js";
import {
  renderReviewOutcome,
  renderShardedReviewOutcome,
  type ReviewOutcome,
  type ShardedReviewOutcome,
} from "../../src/cli/render.js";
import { FINDING_F001 } from "../../../../tests/helpers/dsh-replies.js";

// ---------- 参数解析（review 子命令） ----------

describe("parseCliArgs review（#26）", () => {
  it("happy path：必填两项 + 其余缺省（config=A、issue=\"\"、out=review-agent-output）", () => {
    const parsed = parseCliArgs(["review", "--repo", "/repos/sample", "--mr", "fix.diff"]);

    expect(parsed).toEqual({
      ok: true,
      command: "review",
      args: {
        repo: "/repos/sample",
        mr: "fix.diff",
        caseId: "fix",
        config: "A",
        issue: "",
        out: "review-agent-output",
        model: "deepseek-v4-flash",
      } satisfies ReviewCliArgs,
    });
  });

  it("五配置可选（AC2）：--config B/C/D/E 透传，默认 A 明确", () => {
    for (const config of ["B", "C", "D", "E"] as const) {
      const parsed = parseCliArgs(["review", "--repo", "r", "--mr", "m", "--config", config]);
      expect(parsed).toMatchObject({ ok: true, args: { config } });
    }
    expect(parseCliArgs(["review", "--repo", "r", "--mr", "m"])).toMatchObject({
      ok: true,
      args: { config: "A" },
    });
  });

  it("issue / out 透传（MrInput 契约字段与输出目录）", () => {
    const parsed = parseCliArgs([
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
      command: "review",
      args: { repo: "r", mr: "m", caseId: "m", config: "A", issue: "Vulnerability fix", out: "/tmp/out", model: "deepseek-v4-flash" },
    });
  });

  it("caseId 派生（解析缝锁定）：--mr 文件名去扩展名，多级扩展名只去最后一级", () => {
    const derive = (mr: string): string => {
      const parsed = parseCliArgs(["review", "--repo", "r", "--mr", mr]);
      expect(parsed).toMatchObject({ ok: true, command: "review" });
      return parsed.ok && parsed.command === "review" ? parsed.args.caseId : "<parse failed>";
    };
    expect(derive("fix-url-encoding.diff")).toBe("fix-url-encoding");
    expect(derive("a.b.c.patch")).toBe("a.b.c");
    expect(derive("no-extension")).toBe("no-extension");
    expect(derive("diffs/nested-path.diff")).toBe("nested-path");
  });

  it("用法错误（union 返回不抛）：缺 --repo / 缺 --mr / 缺命令", () => {
    const noRepo = parseCliArgs(["review", "--mr", "m"]);
    expect(noRepo).toMatchObject({ ok: false });
    if (noRepo.ok === false) expect(noRepo.message).toContain("--repo");

    const noMr = parseCliArgs(["review", "--repo", "r"]);
    expect(noMr).toMatchObject({ ok: false });
    if (noMr.ok === false) expect(noMr.message).toContain("--mr");

    const noCommand = parseCliArgs([]);
    expect(noCommand).toMatchObject({ ok: false });
    if (noCommand.ok === false) expect(noCommand.message).toContain("review");
  });

  it("config 越界：F（或小写）→ 用法错误并列出 A–E", () => {
    const upper = parseCliArgs(["review", "--repo", "r", "--mr", "m", "--config", "F"]);
    expect(upper).toMatchObject({ ok: false });
    if (upper.ok === false) {
      expect(upper.message).toContain("--config");
      for (const letter of ["A", "B", "C", "D", "E"]) {
        expect(upper.message).toContain(letter);
      }
    }
    expect(parseCliArgs(["review", "--repo", "r", "--mr", "m", "--config", "a"])).toMatchObject({
      ok: false,
    });
  });

  it("未知旗标、值缺席与重复旗标：用法错误", () => {
    expect(parseCliArgs(["review", "--repo", "r", "--mr", "m", "--wat", "x"])).toMatchObject({
      ok: false,
    });
    expect(parseCliArgs(["review", "--repo"])).toMatchObject({ ok: false });
    const duplicate = parseCliArgs(["review", "--repo", "r", "--repo", "r2", "--mr", "m"]);
    expect(duplicate).toMatchObject({ ok: false });
    if (duplicate.ok === false) expect(duplicate.message).toContain("--repo");
  });

  it("值吞旗标：`--issue --out x` 的 --out 不会被当成 --issue 的值", () => {
    const parsed = parseCliArgs(["review", "--repo", "r", "--mr", "m", "--issue", "--out", "x"]);
    expect(parsed).toMatchObject({ ok: false });
    if (parsed.ok === false) expect(parsed.message).toContain("--issue");
  });

  it("用法文案：包含两个子命令的完整形状（烟测 stderr 的同款文案单一来源）", () => {
    expect(USAGE_TEXT).toContain("review-agent review --repo <path> --mr <diff-file>");
    expect(USAGE_TEXT).toContain("--config");
    expect(USAGE_TEXT).toContain("--model");
    expect(USAGE_TEXT).toContain("review-agent smoke");
  });
});

// ---------- --model（#45：被测模型经 CLI 旗标下传） ----------

describe("parseCliArgs review --model（#45）", () => {
  it("透传：--model glm-4.7 进入解析结果（自由 id，不设白名单）", () => {
    const parsed = parseCliArgs(["review", "--repo", "r", "--mr", "m", "--model", "glm-4.7"]);
    expect(parsed).toMatchObject({ ok: true, args: { model: "glm-4.7" } });
  });

  it("缺省：不带 --model → deepseek-v4-flash（与内核 DEFAULT_MODEL 同值，双包各自单源）", () => {
    const parsed = parseCliArgs(["review", "--repo", "r", "--mr", "m"]);
    expect(parsed).toMatchObject({ ok: true, args: { model: "deepseek-v4-flash" } });
  });

  it("空串：--model \"\" → 用法错误（解析缝拒绝，不留给组装期）", () => {
    const parsed = parseCliArgs(["review", "--repo", "r", "--mr", "m", "--model", ""]);
    expect(parsed).toMatchObject({ ok: false });
    if (parsed.ok === false) {
      expect(parsed.message).toContain("--model");
    }
  });

  it("重复旗标：两个 --model → 用法错误", () => {
    const parsed = parseCliArgs([
      "review",
      "--repo",
      "r",
      "--mr",
      "m",
      "--model",
      "glm-4.7",
      "--model",
      "qwen3.8-flash",
    ]);
    expect(parsed).toMatchObject({ ok: false });
    if (parsed.ok === false) {
      expect(parsed.message).toContain("--model");
    }
  });
});

// ---------- smoke 子命令（#46：网关冒烟自检） ----------

describe("parseCliArgs smoke（#46）", () => {
  it("透传：smoke --model glm-4.7（自由 id，与 review 同缺省同校验）", () => {
    const parsed = parseCliArgs(["smoke", "--model", "glm-4.7"]);
    expect(parsed).toEqual({
      ok: true,
      command: "smoke",
      args: { model: "glm-4.7" } satisfies SmokeCliArgs,
    });
  });

  it("缺省：smoke（无旗标）→ deepseek-v4-flash（与 review 同值单源）", () => {
    const parsed = parseCliArgs(["smoke"]);
    expect(parsed).toEqual({
      ok: true,
      command: "smoke",
      args: { model: "deepseek-v4-flash" } satisfies SmokeCliArgs,
    });
  });

  it("空串：smoke --model \"\" → 用法错误（与 review 的 --model 同口径）", () => {
    const parsed = parseCliArgs(["smoke", "--model", ""]);
    expect(parsed).toMatchObject({ ok: false });
    if (parsed.ok === false) {
      expect(parsed.message).toContain("--model");
    }
  });

  it("重复旗标：两个 --model → 用法错误", () => {
    const parsed = parseCliArgs(["smoke", "--model", "glm-4.7", "--model", "deepseek-v4-pro"]);
    expect(parsed).toMatchObject({ ok: false });
    if (parsed.ok === false) {
      expect(parsed.message).toContain("--model");
    }
  });

  it("未知旗标：review 的旗标不属于 smoke（--repo / --mr → 用法错误）", () => {
    const withRepo = parseCliArgs(["smoke", "--repo", "r"]);
    expect(withRepo).toMatchObject({ ok: false });
    if (withRepo.ok === false) {
      expect(withRepo.message).toContain("--repo");
    }
    expect(parseCliArgs(["smoke", "--mr", "m.diff"])).toMatchObject({ ok: false });
  });

  it("未知命令：deploy → 用法错误并列出两个子命令", () => {
    const parsed = parseCliArgs(["deploy"]);
    expect(parsed).toMatchObject({ ok: false });
    if (parsed.ok === false) {
      expect(parsed.message).toContain("review");
      expect(parsed.message).toContain("smoke");
    }
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

// ---------- #56 切分内建：CLI 输入 → MRCase 与超界合并呈现 ----------

describe("cliMrCase（#56）", () => {
  it("CLI 输入 → MRCase：检视四字段直传；truth 恒 null、labels 为中性载体（生产路径无数据集语义）", () => {
    const args: ReviewCliArgs = {
      repo: "/repos/x",
      mr: "big-mr.diff",
      caseId: "big-mr",
      config: "B",
      issue: "refactor across packages",
      out: "review-agent-output",
      model: "deepseek-v4-flash",
    };
    expect(cliMrCase(args, "/repos/x", "diff-bytes")).toEqual({
      caseId: "big-mr",
      repoPath: "/repos/x",
      diff: "diff-bytes",
      issueDescription: "refactor across packages",
      truth: null,
      labels: { source: "production", riskClass: "Medium", allowedConfigs: ["B"] },
    });
  });
});

describe("renderShardedReviewOutcome（#56）", () => {
  const SHARDED_OUTCOME: ShardedReviewOutcome = {
    caseId: "big-mr",
    configId: "A",
    truncated: false,
    rounds: 2,
    toolCalls: 0,
    usage: { inputTokens: 1200, outputTokens: 120, cacheReadTokens: 600 },
    findings: [{ ...FINDING_F001, shardIds: ["big-mr#shard-001", "big-mr#shard-002"] }],
    shards: {
      reason: "files",
      boundary: { maxFiles: 10, maxDiffLines: 2000 },
      count: 2,
      entries: [
        {
          shardId: "big-mr#shard-001",
          files: 6,
          diffLines: 12,
          outOfDomain: false,
          runId: "20260918T000000Z-A-big-mr-shard-001",
          auditPath: "D:\\audit\\20260918T000000Z-A-big-mr-shard-001.json",
        },
        {
          shardId: "big-mr#shard-002",
          files: 6,
          diffLines: 12,
          outOfDomain: false,
          runId: "20260918T000001Z-A-big-mr-shard-002",
          auditPath: "D:\\audit\\20260918T000001Z-A-big-mr-shard-002.json",
        },
      ],
    },
  };

  it("stdout 形状：单个 JSON 文档（ok 包络 + 跨片求和摘要含 usage + shards 节；findings 携带 shardIds；顶层不带 runId/auditPath）", () => {
    const rendered = renderShardedReviewOutcome(SHARDED_OUTCOME);
    expect(() => JSON.parse(rendered)).not.toThrow();
    expect(JSON.parse(rendered)).toEqual({
      ok: true,
      caseId: "big-mr",
      configId: "A",
      truncated: false,
      rounds: 2,
      toolCalls: 0,
      usage: { inputTokens: 1200, outputTokens: 120, cacheReadTokens: 600 },
      findings: [{ ...FINDING_F001, shardIds: ["big-mr#shard-001", "big-mr#shard-002"] }],
      shards: SHARDED_OUTCOME.shards,
    });
  });

  it("单文件超界片如实呈现 outOfDomain；任一片截断则顶层 truncated", () => {
    const rendered = renderShardedReviewOutcome({
      ...SHARDED_OUTCOME,
      truncated: true,
      shards: {
        reason: "lines",
        boundary: { maxFiles: 10, maxDiffLines: 2000 },
        count: 1,
        entries: [
          {
            shardId: "big-mr#shard-001",
            files: 1,
            diffLines: 2001,
            outOfDomain: true,
            runId: "run-x",
            auditPath: "D:\\audit\\run-x.json",
          },
        ],
      },
    });
    const parsed = JSON.parse(rendered) as Record<string, unknown>;
    expect(parsed.truncated).toBe(true);
    const shards = parsed.shards as { reason: string; count: number; entries: { outOfDomain: boolean }[] };
    expect(shards.reason).toBe("lines");
    expect(shards.count).toBe(1);
    expect(shards.entries[0]!.outOfDomain).toBe(true);
  });
});
