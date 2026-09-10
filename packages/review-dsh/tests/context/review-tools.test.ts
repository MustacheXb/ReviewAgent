/**
 * #20 单元层验收：POC1 工具箱 → DSH ToolDefinition 适配器。
 *
 * 三条锁线（oracle = 冻结 harness 的 buildReviewToolkit / buildReviewReadTools）：
 * - schema 字节：名称 / 顺序 / 描述与注册表 1:1，parameters 经 JSON round-trip
 *   后仍产出注册表的 canonical 字节串（键序不漂移）；
 * - 执行字节：同一 fixture 与入参下，适配器 execute 与冻结 executor 逐字节一致
 *   （含参数 JSON 序列化 round-trip：对象 → argumentsJson → 解析）；
 * - Ledger / 预算：readThroughLedger 命中返回 "Already loaded: ctx#NNN" 引用；
 *   预算守卫第 max+1 次调用拒绝。
 */

import type { ToolRunContext as DshToolRunContext } from "@deepseek-ai/dsh-tools";
import { describe, expect, it } from "vitest";

import { REVIEW_TOOL_ORDER } from "../../../../src/tools/registry.js";
import { buildReviewReadTools, buildReviewToolkit } from "../../../../src/tools/toolkit.js";
import { SAMPLE_MR_CASE } from "../../../../tests/fixtures/sample-mr-case.js";
import { createToolBudgetGuard, toDshToolDefinitions } from "../../src/context/review-tools.js";

/** POC1 侧 oracle 工具箱（独立实例：与被测侧各自从空 Ledger 出发） */
const oracleToolkit = buildReviewToolkit({
  repoPath: SAMPLE_MR_CASE.repoPath,
  diff: SAMPLE_MR_CASE.diff,
});

/** 被测侧：同一 fixture 上的独立工具箱 + DSH 适配器 */
const dshToolkit = buildReviewToolkit({
  repoPath: SAMPLE_MR_CASE.repoPath,
  diff: SAMPLE_MR_CASE.diff,
});
const dshDefinitions = toDshToolDefinitions(dshToolkit);
const dshByName = new Map(dshDefinitions.map((definition) => [definition.name, definition] as const));

/**
 * execute 第二参（dsh-tools ToolRunContext）被适配器有意忽略（POC1 工具不接收
 * 取消信号——rg 自带 30s 超时）；直接调用经最小桩满足类型，真实形态由
 * kernel-tools 集成测试经注册表全覆盖。
 */
function stubExec(name: string, args: unknown): DshToolRunContext {
  return { name, arguments: args } as unknown as DshToolRunContext;
}

/** 7 工具 × 代表入参（field 名与冻结 schema 一致：path/startLine/endLine、symbol、query） */
const REPRESENTATIVE_CALLS: readonly { readonly name: string; readonly argsJson: string }[] = [
  { name: "review.get_diff", argsJson: "{}" },
  { name: "review.get_symbol", argsJson: '{"symbol":"sumFirst"}' },
  {
    name: "review.get_file",
    argsJson: '{"path":"src/main/java/com/example/math/MathUtils.java","startLine":1,"endLine":40}',
  },
  { name: "review.find_references", argsJson: '{"symbol":"sumFirst"}' },
  { name: "review.get_call_chain", argsJson: '{"symbol":"sumFirst"}' },
  { name: "review.search_rule", argsJson: '{"query":"boundary"}' },
  { name: "review.search_history", argsJson: '{"query":"overflow"}' },
];

describe("toDshToolDefinitions：schema 字节与冻结注册表 1:1", () => {
  it("7 工具按 REVIEW_TOOL_ORDER 挂载，名称 / 描述逐一相同", () => {
    expect(dshDefinitions.map((definition) => definition.name)).toEqual([...REVIEW_TOOL_ORDER]);
    const registered = buildReviewReadTools();
    expect(dshDefinitions.map((definition) => definition.description)).toEqual(
      registered.map((tool) => tool.description),
    );
  });

  it("parameters 经 JSON round-trip 后逐字节等于注册表 canonical 序列化", () => {
    const registered = buildReviewReadTools();
    for (const [index, definition] of dshDefinitions.entries()) {
      const tool = registered[index];
      if (tool === undefined) throw new Error(`registry has no tool #${index}`);
      expect(JSON.stringify(definition.parameters)).toBe(tool.parametersJson);
    }
  });
});

describe("toDshToolDefinitions：执行结果与冻结 executor 逐字节一致", () => {
  for (const call of REPRESENTATIVE_CALLS) {
    it(`${call.name} ${call.argsJson}`, async () => {
      const oracle = await oracleToolkit.executor.execute({
        id: "call-oracle",
        name: call.name,
        argumentsJson: call.argsJson,
      });
      const definition = dshByName.get(call.name);
      if (definition === undefined) throw new Error(`tool ${call.name} is not mounted`);
      const adapted = await definition.execute(JSON.parse(call.argsJson), stubExec(call.name, call.argsJson));
      expect(adapted).toBe(oracle);
    });
  }
});

describe("Context Ledger：功能态命中返回引用而非原文", () => {
  const ledgerToolkit = buildReviewToolkit({
    repoPath: SAMPLE_MR_CASE.repoPath,
    diff: SAMPLE_MR_CASE.diff,
    ledger: true,
  });
  const ledgerDefinitions = toDshToolDefinitions(ledgerToolkit);
  const getFile = ledgerDefinitions.find((definition) => definition.name === "review.get_file");
  if (getFile === undefined) throw new Error("review.get_file is not mounted");

  const ARGS = { path: "src/main/java/com/example/math/MathUtils.java", startLine: 1, endLine: 40 } as const;

  it("首次读取返回原文，同参重复返回 ctx#001 引用", async () => {
    const first = await getFile.execute(ARGS, stubExec("review.get_file", ARGS));
    const second = await getFile.execute(ARGS, stubExec("review.get_file", ARGS));
    expect(second).not.toBe(first);
    expect(second).toMatch(/^Already loaded: ctx#001 \(review\.get_file /);
  });

  it("惰性态（缺省）永不命中：重复调用返回相同原文", async () => {
    const inertToolkit = buildReviewToolkit({
      repoPath: SAMPLE_MR_CASE.repoPath,
      diff: SAMPLE_MR_CASE.diff,
    });
    const inertGetFile = toDshToolDefinitions(inertToolkit).find(
      (definition) => definition.name === "review.get_file",
    );
    if (inertGetFile === undefined) throw new Error("review.get_file is not mounted");
    const first = await inertGetFile.execute(ARGS, stubExec("review.get_file", ARGS));
    const second = (await inertGetFile.execute(ARGS, stubExec("review.get_file", ARGS))) as string;
    expect(second).toBe(first);
    expect(second.startsWith("Already loaded:")).toBe(false);
  });
});

describe("createToolBudgetGuard：max_tool_calls 计数守卫", () => {
  it("放行前 max 次，其后每次拒绝并返回拒绝理由", () => {
    const guard = createToolBudgetGuard(2);
    const execution = stubExec("review.get_diff", {});
    expect(guard(execution)).toBeUndefined();
    expect(guard(execution)).toBeUndefined();
    expect(guard(execution)).toBe("tool call budget exhausted");
    expect(guard(execution)).toBe("tool call budget exhausted");
  });

  it("max=0 时立即拒绝（防呆下界）", () => {
    const guard = createToolBudgetGuard(0);
    expect(guard(stubExec("review.get_diff", {}))).toBe("tool call budget exhausted");
  });
});
