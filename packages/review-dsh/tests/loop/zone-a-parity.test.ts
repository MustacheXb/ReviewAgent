/**
 * #23 验收：Zone A 内容源全量移植的迁移审计——DSH 组装 × 冻结薄 harness
 * 同配置逐字节对照，差异集显式登记。
 *
 * 对照面（DSH 侧 = POC1 形态审计请求；冻结侧 = 薄 harness 自有装配函数，只读）：
 * - Zone A system 字节：冻结 buildSystemMessage()——检视角色 / 政策 / 输出
 *   Schema / Severity / Evidence Policy 的全量内容源；
 * - 路由：冻结 DEFAULT_MODEL / DEFAULT_EFFORT（ADR-0002 锁定档位）；
 * - 工具面（config C/E）：冻结 buildReviewToolkit().tools（冻结侧自注
 *   「挂载到 LlmRequest.tools 的 schema，Zone A 的一部分」；parameters 经
 *   JSON round-trip 对照注册表 canonical 字节）。
 *
 * 差异集契约（票 #23：允许差异集仅限两类，登记面经类型双重收口）：
 * - ASSEMBLY_WRAPPING：DSH 组装层必需的包裹——物化为 SYSTEM_PROMPT_BYTES[*]
 *   键（#18 实测 includeHarnessIdentity / includeRuntimeContext 双关断 +
 *   complete section 下 renderPrompt 输出零包裹，当前未物化）；
 * - TOOL_NAME_WIRE_MAPPING：review.* → review_* 工具名映射只发生在 DeepSeek
 *   适配器的 wire 序列化点（#19 测试锁定 wire 字节），审计面永不物化——
 *   不占登记位。
 * 可登记键 = 仅 SYSTEM_PROMPT_BYTES[*]（RegistrableZoneADiffKey 模板字面量
 * 类型收口）：工具名 / 路由 / schema 字段的漂移无键可登记，唯一出路是修实现。
 *
 * 实际差异集 = REGISTERED_ZONE_A_DIFFS（当前 ∅）。计算差异若非空，必须在
 * 同一变更内登记（key + reason）——expectParity 的
 * toEqual(REGISTERED.map(key)) 即该纪律的执行点。
 */

import { describe, expect, it } from "vitest";

import type { ToolSchema } from "../../../../src/contracts/llm-client.js";
import { buildSystemMessage } from "../../../../src/loop/messages.js";
import { DEFAULT_EFFORT, DEFAULT_MODEL } from "../../../../src/run/run-review.js";
import { buildReviewToolkit } from "../../../../src/tools/toolkit.js";
import { SAMPLE_MR_CASE } from "../../../../tests/fixtures/sample-mr-case.js";

import type { FakeLlmScriptStep } from "../../src/llm/fake-adapter.js";
import type { MrInput } from "../../src/plugins/review-context.js";
import type { AuditLlmRequest } from "../../src/plugins/review-runtime.js";
import { mount } from "../helpers/mount-profile.js";

/**
 * 可登记差异键（「仅限允许项」的类型收口）：本对照面上，两类允许差异中只有
 * DSH 组装层包裹物化为 SYSTEM_PROMPT_BYTES[*]；TOOL_NAME_WIRE_MAPPING 只出现在
 * wire 序列化点（#19 持有），审计面永不物化。工具名 / 路由 / schema 字段的
 * 漂移无键可登记——计算差异与登记差异强制相等下，唯一出路是修实现。
 */
type RegistrableZoneADiffKey = `SYSTEM_PROMPT_BYTES[${number}]`;

/** 一条已登记的 Zone A 差异（key 形态经 RegistrableZoneADiffKey 收口 = 组装包裹） */
interface RegisteredZoneADiff {
  readonly key: RegistrableZoneADiffKey;
  readonly reason: string;
}

/** 实际差异集（显式登记）：当前为空——零组装包裹、工具 schema 无漂移 */
const REGISTERED_ZONE_A_DIFFS: readonly RegisteredZoneADiff[] = [];

/** 对照输入：三形态共用（caseId / diff 属 Zone C 内容，不进 Zone A 字节） */
const INPUT: MrInput = {
  caseId: "ZONE-A-PARITY-1",
  issueDescription: SAMPLE_MR_CASE.issueDescription,
  diff: SAMPLE_MR_CASE.diff,
  repoPath: SAMPLE_MR_CASE.repoPath,
};

/** 六阶段纯文本脚本（零工具调用——C/E 形态下工具 schema 仍逐请求挂载） */
const PHASE_REPLIES: readonly string[] = [
  '{"summary":"Deterministic parity run."}',
  '{"riskClass":"Low","reason":"mechanical change"}',
  '{"neededContext":[],"reason":"diff is self-contained"}',
  '{"notes":"No further context in this configuration."}',
  '{"candidates":[]}',
  '{"verdicts":[],"complete":true}',
];

function phaseScript(): readonly FakeLlmScriptStep[] {
  return PHASE_REPLIES.map((content) => ({ kind: "reply" as const, content }));
}

/** 冻结 oracle：同配置对照面——Zone A 字节（system + 工具 schema）+ 路由
 * （model / effort；非 Zone A 组成部分，作同配置对照的旁证位） */
interface ZoneAOracle {
  readonly systemPrompt: string;
  readonly model: string;
  readonly effort: string;
  readonly tools: readonly ToolSchema[];
}

const FROZEN_SYSTEM_PROMPT = buildSystemMessage().content;
const FROZEN_TOOLS = buildReviewToolkit({
  repoPath: SAMPLE_MR_CASE.repoPath,
  diff: SAMPLE_MR_CASE.diff,
}).tools;

function oracleFor(tools: readonly ToolSchema[]): ZoneAOracle {
  return { systemPrompt: FROZEN_SYSTEM_PROMPT, model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, tools };
}

/**
 * 计算实际差异集：逐请求对照 system 字节（含 role）、路由、工具面（数量 +
 * 名称 / 描述 / canonical parameters 字节）。返回差异键列表——任何键非空
 * 即迁移漂移，必须登记进 REGISTERED_ZONE_A_DIFFS 才能通过 expectParity。
 */
function diffZoneA(requests: readonly AuditLlmRequest[], oracle: ZoneAOracle): string[] {
  const diffs: string[] = [];
  for (const [index, request] of requests.entries()) {
    if (request.model !== oracle.model) {
      diffs.push(`MODEL[${index}]`);
    }
    if (request.effort !== oracle.effort) {
      diffs.push(`EFFORT[${index}]`);
    }
    const system = request.messages[0];
    if (system === undefined || system.role !== "system" || system.content !== oracle.systemPrompt) {
      diffs.push(`SYSTEM_PROMPT_BYTES[${index}]`);
    }
    if (request.tools.length !== oracle.tools.length) {
      diffs.push(`TOOL_COUNT[${index}]`);
    }
    for (const [toolIndex, tool] of request.tools.entries()) {
      const expected = oracle.tools[toolIndex];
      if (expected === undefined) continue; // 数量差异已记 TOOL_COUNT
      if (tool.name !== expected.name) {
        diffs.push(`TOOL_NAME[${index}][${toolIndex}]`);
      }
      if (tool.description !== expected.description) {
        diffs.push(`TOOL_DESCRIPTION[${index}][${toolIndex}]`);
      }
      if (JSON.stringify(tool.parameters) !== expected.parametersJson) {
        diffs.push(`TOOL_PARAMETERS_JSON[${index}][${toolIndex}]`);
      }
    }
  }
  return diffs;
}

/** 对照纪律断言：计算差异集 = 登记差异集（登记 ⊆ 允许类别由类型收口） */
function expectParity(requests: readonly AuditLlmRequest[], oracle: ZoneAOracle): void {
  expect(diffZoneA(requests, oracle)).toEqual(REGISTERED_ZONE_A_DIFFS.map((entry) => entry.key));
}

describe("Zone A 对照（#23：DSH 组装 × 冻结薄 harness，差异集显式登记）", () => {
  it("config A（零工具）：全请求 system = 冻结 buildSystemMessage 字节，tools = []，差异集 = 登记（∅）", async () => {
    const { ctx } = await mount(phaseScript());

    const result = await ctx.reviewRuntime.run(INPUT);

    expect(result.audit.configId).toBe("A");
    expectParity(result.audit.requests, oracleFor([]));
  });

  it("config C（7 工具 schema）：system + 工具面与冻结 buildReviewToolkit 逐字段一致，差异集 = ∅", async () => {
    const { ctx } = await mount(phaseScript(), { policy: { toolsEnabled: true } });

    const result = await ctx.reviewRuntime.run(INPUT);

    expect(result.audit.configId).toBe("C");
    expectParity(result.audit.requests, oracleFor(FROZEN_TOOLS));
  });

  it("config E（C + Ledger）：Ledger 不入请求字节，工具 schema 与 C 同源，差异集 = ∅", async () => {
    const { ctx } = await mount(phaseScript(), { policy: { toolsEnabled: true, ledger: true } });

    const result = await ctx.reviewRuntime.run(INPUT);

    expect(result.audit.configId).toBe("E");
    expectParity(result.audit.requests, oracleFor(FROZEN_TOOLS));
  });

  it("失效自检（负面对照）：diffZoneA 对路由 / system / 工具面扰动逐一敏感", () => {
    const oracle = oracleFor(FROZEN_TOOLS);
    const first = FROZEN_TOOLS[0];
    if (first === undefined) throw new Error("frozen toolkit is empty");
    const perturbed: AuditLlmRequest = {
      model: `${DEFAULT_MODEL}_x`,
      effort: `${DEFAULT_EFFORT}_x`,
      messages: [{ role: "system", content: `${FROZEN_SYSTEM_PROMPT}x` }],
      tools: [
        {
          name: `${first.name}_x`,
          description: `${first.description}x`,
          parameters: { ...JSON.parse(first.parametersJson), extra: true },
        },
        ...FROZEN_TOOLS.slice(1).map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: JSON.parse(tool.parametersJson) as Record<string, unknown>,
        })),
        { name: "review.extra", description: "count perturbation", parameters: {} },
      ],
    };

    // 七类差异键全部产出（计算面无盲区；登记面类型收口无后门——这些键中
    // 除 SYSTEM_PROMPT_BYTES 外均不可登记，漂移只能修实现）
    expect(diffZoneA([perturbed], oracle)).toEqual([
      "MODEL[0]",
      "EFFORT[0]",
      "SYSTEM_PROMPT_BYTES[0]",
      "TOOL_COUNT[0]",
      "TOOL_NAME[0][0]",
      "TOOL_DESCRIPTION[0][0]",
      "TOOL_PARAMETERS_JSON[0][0]",
    ]);
  });
});
