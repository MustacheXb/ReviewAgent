/**
 * A–E 五 preset（#25）：configId → 政策开关的注册表 + 矩阵推导。
 *
 * 配置矩阵的真源 = 冻结 CONFIGS（spec #1 配置表）：deriveConfigId 逐字段对照
 * 冻结表回环 configId，非矩阵组合组装期拒绝（review-policy apply 调用）——
 * 内核只装 A–E 五形态，「无法诚实标注 configId」的组合不进入运行时。
 * stablePrefix（D/E）是纯声明开关（POC1 实测无行为读取它；DSH 原生前缀
 * 机制按 ADR-0005 后置为独立消融票），存在意义是让 D/E 可被诚实标注。
 */

import type { ConfigId, ReviewConfig } from "../../../../src/contracts/config.js";
import { CONFIGS } from "../../../../src/contracts/config.js";

/** 矩阵判定子集（ReviewPolicyConfig / ReviewPolicyService 均结构满足） */
export interface PresetSwitches {
  readonly toolsEnabled?: boolean;
  readonly prefetch?: boolean;
  readonly fullRepo?: boolean;
  readonly stablePrefix?: boolean;
  readonly ledger?: boolean;
}

/** 五 preset（组装级差异收敛为政策开关面；对照面 = 冻结 CONFIGS，测试逐字段锁定） */
export const REVIEW_PRESETS: Readonly<Record<ConfigId, PresetSwitches>> = {
  A: {},
  B: { prefetch: true },
  C: { toolsEnabled: true, fullRepo: true },
  D: { toolsEnabled: true, stablePrefix: true },
  E: { toolsEnabled: true, stablePrefix: true, ledger: true },
};

/** 开关组合 → configId（逐字段对照冻结 CONFIGS；非矩阵组合显式拒绝） */
export function deriveConfigId(switches: PresetSwitches): ConfigId {
  const normalized = normalizeSwitches(switches);
  for (const config of Object.values(CONFIGS)) {
    if (matchesMatrix(config, normalized)) {
      return config.configId;
    }
  }
  throw new Error(
    `review-presets: switch combination is outside the A-E matrix (toolsEnabled=${normalized.toolsEnabled}, prefetch=${normalized.prefetch}, fullRepo=${normalized.fullRepo}, stablePrefix=${normalized.stablePrefix}, ledger=${normalized.ledger}); the kernel assembles only the five spec #1 configurations — start from a REVIEW_PRESETS entry`,
  );
}

/** 五开关的归一形态（optional boolean → 恰好 on/off；矩阵对照的唯一输入形状） */
interface NormalizedSwitches {
  readonly toolsEnabled: boolean;
  readonly prefetch: boolean;
  readonly fullRepo: boolean;
  readonly stablePrefix: boolean;
  readonly ledger: boolean;
}

function normalizeSwitches(switches: PresetSwitches): NormalizedSwitches {
  return {
    toolsEnabled: switches.toolsEnabled === true,
    prefetch: switches.prefetch === true,
    fullRepo: switches.fullRepo === true,
    stablePrefix: switches.stablePrefix === true,
    ledger: switches.ledger === true,
  };
}

function matchesMatrix(config: ReviewConfig, normalized: NormalizedSwitches): boolean {
  return (
    config.toolsEnabled === normalized.toolsEnabled &&
    config.prefetch === normalized.prefetch &&
    config.fullRepo === normalized.fullRepo &&
    config.stablePrefix === normalized.stablePrefix &&
    config.ledger === normalized.ledger
  );
}
