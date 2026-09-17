import { describe, expect, it } from "vitest";

import { DEFAULT_SHARD_CONFIG } from "../../../src/sharding/plan-shards.js";
import { composeShardingArms } from "../../../src/experiment/sharding/arms.js";
import { SMALL_BOUNDARY, specOf } from "./fixtures.js";

/**
 * #57 双臂调度（用户故事 15–16）：同一组候选案例构造处理臂（超界 → 切分）
 * 与控制臂（域内 → 直通）。
 *
 * 锁线：臂不变式（处理臂必切 / 控制臂必不切——档位配错零运行成本拒绝）、
 * 同构造参数对照（同锚同入选同弃用）、composeComposite 错误原样透传。
 */

describe("composeShardingArms（#57 双臂构造）", () => {
  it("双臂构造成功：处理臂超界（planShards 判切分）/ 控制臂域内（直通）；compositeId 按臂派生", () => {
    const result = composeShardingArms(specOf("g1"), SMALL_BOUNDARY);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.treatment.mrCase.caseId).toBe("g1-treatment");
    expect(result.value.control.mrCase.caseId).toBe("g1-control");
    // 臂不变式由切分器同款判定复核（预检零运行成本）
    expect(result.value.treatment.manifest.composite.files).toBe(6);
    expect(result.value.control.manifest.composite.files).toBe(2);
  });

  it("同构造参数对照：两臂同锚案例、同入选序、同弃用痕（acceptance 只依赖候选，不依赖填充档位）", () => {
    const result = composeShardingArms(specOf("g1"), SMALL_BOUNDARY);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const { treatment, control } = result.value;
    expect(treatment.manifest.anchorCaseId).toBe(control.manifest.anchorCaseId);
    expect(treatment.manifest.anchorCaseId).toBe("VUL4J-2");
    expect(treatment.manifest.includedCaseIds).toEqual(control.manifest.includedCaseIds);
    expect(treatment.manifest.includedCaseIds).toEqual(["VUL4J-2", "VUL4J-1"]);
    expect(treatment.manifest.droppedCases).toEqual(control.manifest.droppedCases);
  });

  it("臂不变式（处理臂未超界）：填充档位使合成 MR 仍在域内 → HARNESS_ARM_INVALID（含臂名与实际规模）", () => {
    const result = composeShardingArms(
      {
        ...specOf("g1"),
        // 案例部分 2 文件恰域内、零填充 → 未触发切分：处理臂档位配错
        treatmentFill: { targetFiles: 2, targetDiffLines: 6 },
      },
      SMALL_BOUNDARY,
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("HARNESS_ARM_INVALID");
    expect(result.error.message).toContain("treatment");
    expect(result.error.message).toContain("2");
  });

  it("臂不变式（控制臂超界）：填充档位使合成 MR 超出域内 → HARNESS_ARM_INVALID（含臂名）", () => {
    const result = composeShardingArms(
      {
        ...specOf("g1"),
        // 填充 2 个文件 → 控制臂 4 文件 > 边界 2：控制臂档位配错
        controlFill: { targetFiles: 4, targetDiffLines: 20 },
      },
      SMALL_BOUNDARY,
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("HARNESS_ARM_INVALID");
    expect(result.error.message).toContain("control");
  });

  it("构造器错误原样透传：填充候选耗尽（COMPOSITE_FILL_EXHAUSTED）不吞不改", () => {
    const result = composeShardingArms(
      {
        ...specOf("g1"),
        // 快照只有 4 个填充候选，处理臂要 10 文件（8 填充）必耗尽
        treatmentFill: { targetFiles: 10, targetDiffLines: 40 },
      },
      SMALL_BOUNDARY,
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("COMPOSITE_FILL_EXHAUSTED");
  });

  it("生产缺省边界同款判定：6 文件合成 MR 未超缺省域（10 文件 / 2000 行）→ 处理臂不变式拒绝", () => {
    const result = composeShardingArms(specOf("g1"), DEFAULT_SHARD_CONFIG);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("HARNESS_ARM_INVALID");
    expect(result.error.message).toContain("treatment");
  });
});
