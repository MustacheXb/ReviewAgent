import type { MRCase } from "../contracts/mr-case.js";
import type { DefectRecord } from "./defect-record.js";
import {
  type SourceSnapshot,
  applyUnifiedDiff,
} from "./diff/apply-unified-diff.js";
import { type Result, DatasetError, err, ok } from "./diff/types.js";

/**
 * 逆补丁法语义自检（Ticket 02 验收标准 1 的可执行形式）：
 * 「MR 合入后代码状态等于历史真实 buggy 版本」。
 *
 * 三重校验（全为纯函数）：
 * 1. applyOk：逆 diff（MR diff）可严格应用于 fixedSources（无上下文失配）；
 * 2. buggyMatches（当 defectRecord 提供 buggySources）：合入后全量快照 === 历史 buggy 快照；
 * 3. roundTripOk：对合入结果重新应用最小修复补丁，还原出 fixedSources
 *    （无论是否提供 buggySources 都执行——这是逆 diff 正确性的内证）。
 */
export interface InverseVerification {
  readonly caseId: string;
  readonly applyOk: boolean;
  readonly buggyMatches: boolean | null;
  readonly roundTripOk: boolean;
  readonly detail: string;
}

export function verifyInverseSemantics(
  record: DefectRecord,
  mrCase: MRCase,
): Result<InverseVerification> {
  if (mrCase.caseId !== record.recordId) {
    return err(new DatasetError("MISMATCH", `caseId ${mrCase.caseId} 与 recordId ${record.recordId} 不一致`));
  }
  const merged = applyUnifiedDiff(record.fixedSources, mrCase.diff);
  if (!merged.ok) {
    return ok({
      caseId: record.recordId,
      applyOk: false,
      buggyMatches: null,
      roundTripOk: false,
      detail: `MR diff 无法应用于 fixed 快照: ${merged.error.message}`,
    });
  }
  const buggySnapshot = mergeSnapshot(record.fixedSources, merged.value.sources, merged.value.deletedPaths);
  const buggyMatches = record.buggySources === undefined ? null : snapshotsEqual(buggySnapshot, record.buggySources);
  const roundTrip = applyUnifiedDiff(buggySnapshot, record.fixPatch);
  const roundTripOk = roundTrip.ok
    ? snapshotsEqual(
        mergeSnapshot(buggySnapshot, roundTrip.value.sources, roundTrip.value.deletedPaths),
        record.fixedSources,
      )
    : false;
  const detail = describe(merged.ok, buggyMatches, roundTripOk, roundTrip);
  return ok({
    caseId: record.recordId,
    applyOk: true,
    buggyMatches,
    roundTripOk,
    detail,
  });
}

function mergeSnapshot(
  base: SourceSnapshot,
  changed: Readonly<Record<string, string>>,
  deletedPaths: readonly string[],
): SourceSnapshot {
  const out: Record<string, string> = { ...base, ...changed };
  for (const path of deletedPaths) {
    delete out[path];
  }
  return out;
}

function snapshotsEqual(a: SourceSnapshot, b: SourceSnapshot): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) {
    return false;
  }
  return aKeys.every((k) => a[k] === b[k]);
}

function describe(
  _applyOk: boolean,
  buggyMatches: boolean | null,
  roundTripOk: boolean,
  roundTrip: Result<{ sources: Readonly<Record<string, string>>; deletedPaths: readonly string[] }>,
): string {
  if (!roundTripOk && !roundTrip.ok) {
    return `修复补丁无法回放于合入结果: ${roundTrip.error.message}`;
  }
  const parts = [
    buggyMatches === null ? "未提供 buggy 快照（仅回环校验）" : `buggy 快照比对: ${buggyMatches ? "一致" : "不一致"}`,
    `修复补丁回环: ${roundTripOk ? "还原成功" : "还原失败"}`,
  ];
  return parts.join("；");
}
