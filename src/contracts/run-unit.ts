/**
 * 运行单元键组（source, caseId, configId, rep）——断点续跑、审计落盘、报告分组与
 * 进度展示共用的稳定键。收敛此前散落在 experiment/runner、experiment/report、
 * experiment/cli、experiment/dashboard 的同构键函数。
 *
 * 键的字符串形式 = 产物目录骨架 runs/<source>/<caseId>/<configId>/rep-<rep>。
 *
 * 注：外部参照（reference）为单列域，键组只有 (source, caseId, rep) 三段，不适用
 * 本契约（保留其模块内局部键函数）。
 */

/** 运行单元键组（结构化：RunUnit / RunRecord / RunFailure 等同形对象均可直接代入） */
export interface RunUnitKey {
  readonly source: string;
  readonly caseId: string;
  readonly configId: string;
  readonly rep: number;
}

/** 键的稳定字符串形式（目录骨架 / 报告单元标识 / 续跑对账键） */
export function runUnitKeyString(key: RunUnitKey): string {
  return `${key.source}/${key.caseId}/${key.configId}/rep-${key.rep}`;
}
