/**
 * #22 单元层验收：POC1 预取管线 → DSH 注入材料适配器。
 *
 * 三条锁线（oracle = 冻结 harness 的 buildPrefetchContext 同参直跑）：
 * - 字节一致：同一 repoPath + diff 下，适配器产出的 Zone B 消息与三层消息
 *   逐字段等于冻结管线（同一仓库 + 同一 diff → 字节级相同注入内容）；
 * - 记账转发：4 条 PrefetchLayerRecord（zone-b / symbol / reference /
 *   call-chain 固定管线序）1:1 进入注入材料（audit.prefetch 的数据源）；
 * - fail fast：repoPath 缺失时显式拒绝（预取已启用但无仓库可读是输入错误）。
 */

import { DEFAULT_PREFETCH_BUDGETS } from "../../../../src/contracts/prefetch.js";
import type { PrefetchContext } from "../../../../src/zoneb/prefetch.js";
import { buildPrefetchContext } from "../../../../src/zoneb/prefetch.js";
import { SAMPLE_MR_CASE } from "../../../../tests/fixtures/sample-mr-case.js";
import { beforeAll, describe, expect, it } from "vitest";

import { buildPrefetchInjection } from "../../src/context/prefetch-context.js";
import type { MrInput } from "../../src/plugins/review-context.js";

const INPUT: MrInput = {
  caseId: "PREFETCH-1",
  issueDescription: SAMPLE_MR_CASE.issueDescription,
  diff: SAMPLE_MR_CASE.diff,
  repoPath: SAMPLE_MR_CASE.repoPath,
};

let oracle: PrefetchContext;

beforeAll(async () => {
  oracle = await buildPrefetchContext({
    repoPath: SAMPLE_MR_CASE.repoPath,
    diff: SAMPLE_MR_CASE.diff,
    budgets: DEFAULT_PREFETCH_BUDGETS,
  });
});

describe("buildPrefetchInjection：POC1 预取管线适配（config B 注入材料）", () => {
  it("Zone B 与三层消息逐字段等于冻结管线直跑（同仓库 + 同 diff → 字节级相同）", async () => {
    const injection = await buildPrefetchInjection(INPUT);

    expect(injection.zoneBMessage).toEqual(oracle.zoneBMessage);
    expect(injection.layerMessages).toEqual(oracle.layerMessages);
  });

  it("记账转发：4 条 PrefetchLayerRecord 按固定管线序，与冻结管线一致", async () => {
    const injection = await buildPrefetchInjection(INPUT);

    expect(injection.records.map((record) => record.layer)).toEqual([
      "zone-b",
      "symbol",
      "reference",
      "call-chain",
    ]);
    expect(injection.records).toEqual(oracle.records);
  });

  it("fail fast：repoPath 缺失 → 显式拒绝（预取启用但无仓库可读）", async () => {
    const { repoPath: _repoPath, ...withoutRepo } = INPUT;

    await expect(buildPrefetchInjection(withoutRepo)).rejects.toThrow(/requires MrInput\.repoPath/);
  });
});
