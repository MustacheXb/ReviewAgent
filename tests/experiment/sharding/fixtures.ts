import type { Finding } from "../../../src/contracts/finding.js";
import { type ShardingGroupSpec } from "../../../src/experiment/sharding/arms.js";
import { type ShardConfig } from "../../../src/sharding/plan-shards.js";
import {
  FIX_PATCH_PARSER,
  FIX_PATCH_SERVICE,
  PARSER_PATH,
  SERVICE_PATH,
  makeCandidate,
  snapshotV2,
} from "../synthetic/fixtures.js";

/**
 * #57 切分验证 harness 测试共享夹具（arms / criteria / harness 三套测试的
 * 公共构造）：双案例候选组、小边界切分配置、finding 工厂、标准组规格。
 *
 * 真值性质用共享词表成员（DEFECT_NATURES 的 "NULL_SAFETY"）——不误并判据
 * 经 screenFindings 校验真值，词表外性质会被 fail-fast 拒绝。
 */

/** 小边界（便于小夹具触发切分）：2 文件上限——案例部分恰域内，加填充即超界 */
export const SMALL_BOUNDARY: ShardConfig = {
  boundary: { maxFiles: 2, maxDiffLines: 2000 },
  maxShards: 20,
};

/** 双案例候选组：VUL4J-1（Parser）+ VUL4J-2（Service，锚）；文件不相交、各自带真值 */
export function twoCaseCandidates() {
  const snap = snapshotV2();
  return [
    makeCandidate(
      "VUL4J-1",
      "2024-01-10T00:00:00Z",
      FIX_PATCH_PARSER,
      {
        locations: [{ file: PARSER_PATH, lineStart: 5, lineEnd: 5, defectNature: "NULL_SAFETY" }],
        fixPatch: FIX_PATCH_PARSER,
      },
      snap,
    ),
    makeCandidate(
      "VUL4J-2",
      "2024-06-15T00:00:00Z",
      FIX_PATCH_SERVICE,
      {
        locations: [{ file: SERVICE_PATH, lineStart: 5, lineEnd: 5, defectNature: "NULL_SAFETY" }],
        fixPatch: FIX_PATCH_SERVICE,
      },
      snap,
    ),
  ];
}

/** 标准组规格：处理臂 6 文件（2 案例 + 4 填充候选）超 2 文件边界；控制臂零填充恰域内 */
export function specOf(groupId: string): ShardingGroupSpec {
  return {
    groupId,
    candidates: twoCaseCandidates(),
    treatmentFill: { targetFiles: 6, targetDiffLines: 20 },
    controlFill: { targetFiles: 2, targetDiffLines: 6 },
  };
}

/** finding 工厂：词表内性质 + Parser 默认锚位（按需 override） */
export function finding(id: string, overrides: Partial<Finding> = {}): Finding {
  return {
    id,
    severity: "P2",
    category: "NULL_SAFETY",
    file: PARSER_PATH,
    line: 5,
    title: `title ${id}`,
    description: `description ${id}`,
    evidence: [`${id} evidence`],
    rule: "null-safety",
    confidence: 0.9,
    ...overrides,
  };
}
