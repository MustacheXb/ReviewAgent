import { type Result, DatasetError, err, ok } from "../../dataset/diff/types.js";
import { planShards, type ShardConfig } from "../../sharding/plan-shards.js";
import {
  type CompositeCandidate,
  type CompositeFillParams,
  type CompositeMr,
  composeComposite,
} from "../synthetic/compose-composite.js";

/**
 * 双臂调度（spec #48 用户故事 15–16，ticket #57）：同一组候选案例构造两个
 * 合成 MR——处理臂（填充档位超验证域 → 经编排切分 + 合并）与控制臂（同款
 * 填充、档位落域内 → 同一编排函数直通）。双臂对照把填充效应与切分合并
 * 效应分开归因：控制臂 vs 基线 = 填充 + 组合效应；处理臂 vs 控制臂 = 纯
 * 切分合并效应。
 *
 * 「同款填充」口径：同生成器 + 同候选集 + 同禁改集（锚快照）；填充流不逐
 * 字节嵌套——生成器的文件选择流依赖目标档位（benign-fill 的 pickFile 两档
 * 偏好：文件下限 / 密度打包），档位不同即选择流分叉。跨臂填充实例差异交由
 * 实验设计的 σ 带方法（#30 对称 max σ 带，spec 用户故事 19）在判定层处理。
 *
 * 臂不变式（预检零 LLM 成本）：处理臂必须超界（否则切分路径未被验证）、
 * 控制臂必须域内（否则对照被切分污染）。档位配错 = 实验设计错误，启动即
 * 拒绝——静默跑错臂会烧钱产出无效结论。
 */

/** 一个合成组的双臂构造规格（候选共享；填充档位按臂配置） */
export interface ShardingGroupSpec {
  /** 组 id：两臂 compositeId（亦是填充种子与落盘键）由其派生 */
  readonly groupId: string;
  /** 候选案例（≥2，与 composeComposite 同校验；输入序即非锚案例尝试序） */
  readonly candidates: readonly CompositeCandidate[];
  /** 处理臂填充目标：须使合成 MR 超出验证域（触发切分） */
  readonly treatmentFill: CompositeFillParams;
  /** 控制臂填充目标：须使合成 MR 落域内（直通） */
  readonly controlFill: CompositeFillParams;
}

/** 双臂构造产出：处理臂与控制臂的合成 MR + 构造 manifest */
export interface ShardingArms {
  readonly treatment: CompositeMr;
  readonly control: CompositeMr;
}

/** 合成 MR 的规模描述（臂不变式错误消息用；口径 = composeComposite manifest） */
function describeScale(composite: CompositeMr): string {
  return `${composite.manifest.composite.files} 文件 / ${composite.manifest.composite.diffLines} 行`;
}

/** 构造双臂并校验臂不变式（切分判定与编排同源——planShards 同款配置） */
export function composeShardingArms(
  spec: ShardingGroupSpec,
  shard: ShardConfig,
): Result<ShardingArms> {
  const treatment = composeComposite({
    compositeId: `${spec.groupId}-treatment`,
    candidates: spec.candidates,
    fill: spec.treatmentFill,
  });
  if (!treatment.ok) {
    return treatment;
  }
  const control = composeComposite({
    compositeId: `${spec.groupId}-control`,
    candidates: spec.candidates,
    fill: spec.controlFill,
  });
  if (!control.ok) {
    return control;
  }

  // 臂不变式预检（零运行成本）：用编排将用的同款切分配置判定
  const treatmentPlan = planShards(treatment.value.mrCase, shard);
  if (!treatmentPlan.ok) {
    return treatmentPlan;
  }
  if (!treatmentPlan.value.sharded) {
    return err(
      new DatasetError(
        "HARNESS_ARM_INVALID",
        `处理臂（treatment）填充档位未使合成 MR 超出验证域（${describeScale(treatment.value)} ≤ 边界 ${shard.boundary.maxFiles} 文件 / ${shard.boundary.maxDiffLines} 行）——处理臂必须触发切分，请上调 treatmentFill 档位`,
      ),
    );
  }
  const controlPlan = planShards(control.value.mrCase, shard);
  if (!controlPlan.ok) {
    return controlPlan;
  }
  if (controlPlan.value.sharded) {
    return err(
      new DatasetError(
        "HARNESS_ARM_INVALID",
        `控制臂（control）填充档位使合成 MR 超出验证域（${describeScale(control.value)} > 边界 ${shard.boundary.maxFiles} 文件 / ${shard.boundary.maxDiffLines} 行）——控制臂必须落域内直通，请下调 controlFill 档位（案例部分自身超界时该组控制臂不可构造）`,
      ),
    );
  }
  return ok({ treatment: treatment.value, control: control.value });
}
