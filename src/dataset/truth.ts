import type { TruthLocation } from "../contracts/mr-case.js";
import { type FileDiff, type Hunk, type Result, DatasetError, err, ok } from "./diff/types.js";
import { parseUnifiedDiff } from "./diff/parse-unified-diff.js";
import { DEFAULT_DEFECT_NATURE, isDefectNature } from "./defect-nature.js";

/**
 * 从最小修复补丁构造真值位置（Ticket 02 验收标准：真值精确到
 * 最小修复补丁的行位与性质）。
 *
 * 坐标系约定：TruthLocation 使用 **buggy 版本文件坐标**（= MR 合入后的文件坐标），
 * 与 Finding.file/line 直接可比。行位 = 修复补丁 remove 行的旧侧行号
 * （即逆 diff 新增回 buggy 文件的行，检视者应在 MR 新增行上命中真值）。
 *
 * 锚定规则（按 hunk 内连续变更段）：
 * - 含 remove 行的段：lineStart..lineEnd = 段内 remove 行旧侧行号的最小/最大值；
 * - 纯新增段（修复是「补代码」，buggy 文件缺少这些行）：
 *   - 段后有 context：锚定插入点后的第一条现存 buggy 行；
 *   - 段在 hunk 末尾（如文件末尾追加）：锚定插入点前的最后一行；
 *   - 修复新建整个文件（旧侧计数 0 且 oldStart=0）：锚定 (0,0) 表示「buggy 中该文件不存在」。
 */
export function buildTruthLocations(
  fixPatch: string,
  defectNatures?: Readonly<Record<string, string>>,
): Result<readonly TruthLocation[]> {
  const parsed = parseUnifiedDiff(fixPatch);
  if (!parsed.ok) {
    return err(new DatasetError("INVALID_FIX_PATCH", `fixPatch 解析失败: ${parsed.error.message}`));
  }
  const locations: TruthLocation[] = [];
  for (const file of parsed.value) {
    const nature = resolveNature(file, defectNatures);
    if (nature instanceof DatasetError) {
      return err(nature);
    }
    locations.push(...fileLocations(file, nature));
  }
  return ok(locations);
}

function resolveNature(
  file: FileDiff,
  defectNatures: Readonly<Record<string, string>> | undefined,
): string | DatasetError {
  if (defectNatures === undefined) {
    return DEFAULT_DEFECT_NATURE;
  }
  const path = file.newPath ?? file.oldPath ?? "";
  const nature = defectNatures[path];
  if (nature === undefined) {
    return DEFAULT_DEFECT_NATURE;
  }
  if (!isDefectNature(nature)) {
    return new DatasetError(
      "INVALID_NATURE",
      `文件 ${path} 的缺陷性质 ${JSON.stringify(nature)} 不在词表内`,
    );
  }
  return nature;
}

/** 单文件真值位置：逐 hunk → 连续变更段 → TruthLocation（保持出现顺序） */
function fileLocations(file: FileDiff, nature: string): TruthLocation[] {
  const filePath = file.oldPath ?? file.newPath!;
  return file.hunks.flatMap((hunk) => hunkLocations(hunk, filePath, nature));
}

interface ChangeRun {
  /** 段内 remove 行的旧侧行号（纯新增段为空数组） */
  readonly removedOldLines: readonly number[];
  /** 段开始时旧侧游标（下一条 context/remove 行的旧侧行号） */
  readonly oldCursorAtStart: number;
  /** 段是否位于 hunk 末尾（其后无 context 行） */
  readonly atHunkEnd: boolean;
}

/** 单遍游走 hunk 行，切分连续变更段并定位 */
function hunkLocations(hunk: Hunk, filePath: string, nature: string): TruthLocation[] {
  // oldCount === 0（纯插入 hunk）时 oldStart 指插入点之前的行，故游标从 oldStart+1 起
  let cursor = hunk.oldCount === 0 ? hunk.oldStart + 1 : hunk.oldStart;
  let run: { removed: number[]; start: number } | null = null;
  const out: TruthLocation[] = [];
  const closeRun = (atHunkEnd: boolean): void => {
    if (run === null) {
      return;
    }
    out.push(runLocation({ removedOldLines: run.removed, oldCursorAtStart: run.start, atHunkEnd }, filePath, nature));
    run = null;
  };
  for (const line of hunk.lines) {
    if (line.type === "context") {
      closeRun(false);
      cursor += 1;
      continue;
    }
    if (run === null) {
      run = { removed: [], start: cursor };
    }
    if (line.type === "remove") {
      run = { ...run, removed: [...run.removed, cursor] };
      cursor += 1;
    }
  }
  closeRun(true);
  return out;
}

function runLocation(run: ChangeRun, filePath: string, nature: string): TruthLocation {
  if (run.removedOldLines.length > 0) {
    return {
      file: filePath,
      lineStart: Math.min(...run.removedOldLines),
      lineEnd: Math.max(...run.removedOldLines),
      defectNature: nature,
    };
  }
  const anchor = run.atHunkEnd ? Math.max(run.oldCursorAtStart - 1, 0) : run.oldCursorAtStart;
  return { file: filePath, lineStart: anchor, lineEnd: anchor, defectNature: nature };
}
