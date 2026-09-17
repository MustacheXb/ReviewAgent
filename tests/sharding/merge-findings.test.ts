import { describe, expect, it } from "vitest";
import type { Finding } from "../../src/contracts/finding.js";
import {
  DEFAULT_MERGE_CONFIG,
  type ShardFindings,
  mergeShardFindings,
} from "../../src/sharding/merge-findings.js";

/** 构造合法 Finding（默认值 + 覆盖）；id 缺省占位，调用处按需覆盖保证输入内唯一 */
function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F1",
    severity: "P2",
    category: "NullCheck",
    file: "src/App.java",
    line: 100,
    title: "可能的空指针",
    description: "该返回值可能为 null，直接解引用存在 NPE 风险",
    evidence: ["src/App.java:100 returnValue != null 检查缺失"],
    rule: "null-safety",
    confidence: 0.8,
    ...overrides,
  };
}

describe("mergeShardFindings（锚点键合并）", () => {
  it("同文件、行号差 ≤ 窗口、rule/category 相同：合并为一条，字段取首见分片", () => {
    const first = makeFinding({
      id: "A",
      line: 100,
      severity: "P1",
      evidence: ["src/App.java:100 片1证据"],
      confidence: 0.9,
    });
    const dup = makeFinding({
      id: "B",
      line: 102,
      severity: "P3",
      evidence: ["src/App.java:102 片2证据"],
      confidence: 0.5,
    });
    const result = mergeShardFindings([
      { shardId: "case#shard-001", findings: [first] },
      { shardId: "case#shard-002", findings: [dup] },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.findings).toHaveLength(1);
    const merged = result.value.findings[0]!;
    // 首见保留：字段以首见分片为准（severity/line/confidence 均取片 1）
    expect(merged).toMatchObject({
      id: "A",
      severity: "P1",
      line: 100,
      confidence: 0.9,
      shardIds: ["case#shard-001", "case#shard-002"],
    });
    // evidence 并集
    expect(merged.evidence).toEqual([
      "src/App.java:100 片1证据",
      "src/App.java:102 片2证据",
    ]);
  });

  it("无去重命中时逐条透传：字段与顺序不变", () => {
    const f1 = makeFinding({ id: "X1", file: "src/A.java", line: 10 });
    const f2 = makeFinding({ id: "X2", file: "src/B.java", line: 20 });
    const f3 = makeFinding({ id: "X3", file: "src/A.java", line: 10, rule: "other-rule" });
    const result = mergeShardFindings([
      { shardId: "s1", findings: [f1, f2] },
      { shardId: "s2", findings: [f3] },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.findings).toEqual([
      { ...f1, shardIds: ["s1"] },
      { ...f2, shardIds: ["s1"] },
      { ...f3, shardIds: ["s2"] },
    ]);
  });

  it("首见跨行号差方向无关：锚上方差 3 同样命中", () => {
    const anchor = makeFinding({ id: "A", line: 100 });
    const above = makeFinding({ id: "B", line: 97 });
    const result = mergeShardFindings([
      { shardId: "s1", findings: [anchor] },
      { shardId: "s2", findings: [above] },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.findings).toHaveLength(1);
    expect(result.value.findings[0]?.id).toBe("A");
    expect(result.value.findings[0]?.shardIds).toEqual(["s1", "s2"]);
  });
});

describe("mergeShardFindings（窗口边界值与不合并维度）", () => {
  function mergePair(second: Partial<Finding>): ReturnType<typeof mergeShardFindings> {
    return mergeShardFindings([
      { shardId: "s1", findings: [makeFinding({ id: "A", line: 100 })] },
      { shardId: "s2", findings: [makeFinding({ id: "B", line: 100, ...second })] },
    ]);
  }

  it("窗口边界：行号差 3 命中（窗口含端点）", () => {
    const result = mergePair({ line: 103 });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.findings).toHaveLength(1);
  });

  it("窗口边界：行号差 4 不命中（两条独立结果）", () => {
    const result = mergePair({ line: 104 });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.findings).toHaveLength(2);
  });

  it("窗口边界（方向对称）：锚下方差 4 同样不命中", () => {
    const result = mergePair({ line: 96 });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.findings).toHaveLength(2);
  });

  it("rule 不同：不合并", () => {
    const result = mergePair({ rule: "resource-leak" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.findings).toHaveLength(2);
  });

  it("category 不同：不合并", () => {
    const result = mergePair({ category: "ResourceLeak" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.findings).toHaveLength(2);
  });

  it("file 不同：不合并", () => {
    const result = mergePair({ file: "src/Other.java" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.findings).toHaveLength(2);
  });

  it("evidence 并集不引入重复条目", () => {
    const result = mergeShardFindings([
      {
        shardId: "s1",
        findings: [makeFinding({ id: "A", evidence: ["e1", "e2"] })],
      },
      {
        shardId: "s2",
        findings: [makeFinding({ id: "B", evidence: ["e2", "e3"] })],
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.findings).toHaveLength(1);
    expect(result.value.findings[0]?.evidence).toEqual(["e1", "e2", "e3"]);
  });

  it("并入路径：首见 evidence 的内部重复也一并洗掉（[e1,e1] 并入 e2 → [e1,e2]）", () => {
    const result = mergeShardFindings([
      {
        shardId: "s1",
        findings: [makeFinding({ id: "A", line: 100, evidence: ["e1", "e1"] })],
      },
      {
        shardId: "s2",
        findings: [makeFinding({ id: "B", line: 101, evidence: ["e2"] })],
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.findings).toHaveLength(1);
    expect(result.value.findings[0]?.evidence).toEqual(["e1", "e2"]);
  });

  it("行号窗口可配：lineWindow=5 时差 4 命中", () => {
    const result = mergeShardFindings(
      [
        { shardId: "s1", findings: [makeFinding({ id: "A", line: 100 })] },
        { shardId: "s2", findings: [makeFinding({ id: "B", line: 104 })] },
      ],
      { lineWindow: 5 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.findings).toHaveLength(1);
    // 回放上下文：结果携带本次生效的合并配置
    expect(result.value.config).toEqual({ lineWindow: 5 });
  });

  it("缺省配置：lineWindow = 3（起步值）", () => {
    expect(DEFAULT_MERGE_CONFIG.lineWindow).toBe(3);
  });

  it.each([
    ["lineWindow = 0", 0],
    ["负数 lineWindow", -1],
    ["非整数 lineWindow", 2.5],
  ])("非法配置（%s）：MERGE_CONFIG_INVALID 拒绝", (_label, lineWindow) => {
    const result = mergeShardFindings([{ shardId: "s1", findings: [] }], { lineWindow });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("MERGE_CONFIG_INVALID");
  });

  it("非法输入（shardId 空串）：MERGE_INPUT_INVALID 拒绝", () => {
    const result = mergeShardFindings([{ shardId: "", findings: [] }]);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("MERGE_INPUT_INVALID");
  });
});

describe("mergeShardFindings（锚点语义与决策回放）", () => {
  it("锚点语义（非传递聚类）：与锚差 6 不命中即新条目，即使与已并入条目差 3", () => {
    const result = mergeShardFindings([
      { shardId: "s1", findings: [makeFinding({ id: "A", line: 100 })] },
      { shardId: "s2", findings: [makeFinding({ id: "B", line: 103 })] },
      { shardId: "s3", findings: [makeFinding({ id: "C", line: 106 })] },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // B 并入锚 A（差 3）；C 与锚 A 差 6 → 不命中 → 新条目（不与已并入的 B 传递聚类）
    expect(result.value.findings).toHaveLength(2);
    expect(result.value.findings[0]?.id).toBe("A");
    expect(result.value.findings[0]?.shardIds).toEqual(["s1", "s2"]);
    expect(result.value.findings[1]?.id).toBe("C");
    expect(result.value.findings[1]?.shardIds).toEqual(["s3"]);
  });

  it("双锚同时命中：并入首见锚（确定性 tie-break）", () => {
    const result = mergeShardFindings([
      {
        shardId: "s1",
        findings: [
          makeFinding({ id: "A", line: 100 }),
          makeFinding({ id: "B", line: 106 }),
        ],
      },
      { shardId: "s2", findings: [makeFinding({ id: "C", line: 103 })] },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // A、B 互差 6 各自成锚；C 与 A、B 均差 3 → 并入首见锚 A
    expect(result.value.findings).toHaveLength(2);
    expect(result.value.findings[0]?.id).toBe("A");
    expect(result.value.findings[0]?.shardIds).toEqual(["s1", "s2"]);
    expect(result.value.findings[1]?.id).toBe("B");
    expect(result.value.findings[1]?.shardIds).toEqual(["s1"]);
  });

  it("同片多条并入同锚：shardIds 不重复列出", () => {
    const result = mergeShardFindings([
      { shardId: "s1", findings: [makeFinding({ id: "A", line: 100 })] },
      {
        shardId: "s2",
        findings: [makeFinding({ id: "B", line: 101 }), makeFinding({ id: "C", line: 102 })],
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.findings).toHaveLength(1);
    expect(result.value.findings[0]?.shardIds).toEqual(["s1", "s2"]);
  });

  it("decisions 回放：每条输入 finding 的去向（首见 / 并入锚 + 行号差）", () => {
    const result = mergeShardFindings([
      { shardId: "s1", findings: [makeFinding({ id: "A", line: 100 })] },
      { shardId: "s2", findings: [makeFinding({ id: "B", line: 103 })] },
      { shardId: "s3", findings: [makeFinding({ id: "C", line: 150 })] },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.decisions).toEqual([
      { shardId: "s1", findingId: "A", action: "first-seen", anchorFindingId: "A", lineDelta: null },
      { shardId: "s2", findingId: "B", action: "deduped", anchorFindingId: "A", lineDelta: 3 },
      { shardId: "s3", findingId: "C", action: "first-seen", anchorFindingId: "C", lineDelta: null },
    ]);
  });

  it("空输入：空结果", () => {
    const result = mergeShardFindings([]);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.findings).toEqual([]);
    expect(result.value.decisions).toEqual([]);
  });

  it("确定性：同输入两次调用结果完全相同", () => {
    const shards: readonly ShardFindings[] = [
      { shardId: "s1", findings: [makeFinding({ id: "A", line: 100 })] },
      { shardId: "s2", findings: [makeFinding({ id: "B", line: 102 })] },
      { shardId: "s3", findings: [makeFinding({ id: "C", line: 300 })] },
    ];
    const first = mergeShardFindings(shards);
    const second = mergeShardFindings(shards);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("纯函数：不修改输入", () => {
    const shards: readonly ShardFindings[] = [
      {
        shardId: "s1",
        findings: [makeFinding({ id: "A", evidence: ["e1", "e1"] })],
      },
      { shardId: "s2", findings: [makeFinding({ id: "B", evidence: ["e2"] })] },
    ];
    const before = JSON.stringify(shards);
    mergeShardFindings(shards);
    expect(JSON.stringify(shards)).toBe(before);
  });

  it("透传条目 evidence 原样（含内部重复也不去重），仅并入条目做并集去重", () => {
    const result = mergeShardFindings([
      { shardId: "s1", findings: [makeFinding({ id: "A", evidence: ["e1", "e1"] })] },
      { shardId: "s2", findings: [makeFinding({ id: "Z", file: "src/Other.java" })] },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // A 无命中 → 原样透传（内部重复保留）
    expect(result.value.findings[0]?.evidence).toEqual(["e1", "e1"]);
  });
});
