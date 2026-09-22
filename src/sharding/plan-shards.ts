import type { MRCase } from "../contracts/mr-case.js";
import {
  type MrBoundary,
  DEFAULT_MR_BOUNDARY,
  checkBoundary,
  measureDiffBoundary,
} from "../dataset/mr-boundary-filter.js";
import { type FileDiff, type Result, DatasetError, err, ok } from "../dataset/diff/types.js";
import { parseUnifiedDiff } from "../dataset/diff/parse-unified-diff.js";
import { serializeUnifiedDiff } from "../dataset/diff/serialize-unified-diff.js";

/**
 * 切分器纯函数（spec #48 实现决策 3–7，ticket #50）：
 * 给定任意规模的 MRCase 与边界配置，产出分片清单——同仓同 base 的子 diff，
 * 每片严格落回验证域内（文件数与行数双维都不超界）。
 *
 * - 触发判定：任一维度超界即切（文件数 > maxFiles 或变更行数 > maxDiffLines，
 *   与数据集边界过滤同口径同源）；域内 MR 直通（不携带任何分片）。
 * - 装箱：包亲和贪心——按变更文件的目录分组，同组优先同片，贪心装填至域内上限。
 * - 单文件自身超界：无法再切，单片执行并标注 outOfDomain（不拒绝）。
 * - 所需分片数超上限：整单拒绝（SHARD_LIMIT_EXCEEDED，含所需片数与上限）。
 * - 纯函数零 IO：同输入必同分片（全部顺序来自输入 diff 的文件出现序）。
 */
export type ShardReason = "files" | "lines";

export interface ShardConfig {
  /** 验证域边界（与数据集边界过滤同源） */
  readonly boundary: MrBoundary;
  /** 分片数上限（缺省 20） */
  readonly maxShards: number;
}

export const DEFAULT_SHARD_CONFIG: Readonly<ShardConfig> = Object.freeze({
  boundary: DEFAULT_MR_BOUNDARY,
  maxShards: 20,
});

export interface Shard {
  /** 派生分片 id（兼作分片 caseId）：<caseId>#shard-NNN（NNN 3 位零填充） */
  readonly shardId: string;
  /** 片内文件数 */
  readonly files: number;
  /** 片内变更行数（新增 + 删除，与边界口径同源） */
  readonly diffLines: number;
  /** 单文件自身超界：该片为无法再切的单片执行 */
  readonly outOfDomain: boolean;
  /** 片内文件路径（保持原 diff 出现序） */
  readonly filePaths: readonly string[];
  /** 子 diff 文本（原 diff 的文件级子集，同仓同 base） */
  readonly diff: string;
  /** 派生分片 MRCase（caseId = shardId，可直接下发单 MR 运行器） */
  readonly mrCase: MRCase;
}

export interface ShardPlan {
  /** 域内 MR 为 false（直通，shards 为空） */
  readonly sharded: boolean;
  /** 首个超界维度；直通时为 null */
  readonly reason: ShardReason | null;
  readonly boundary: MrBoundary;
  readonly maxShards: number;
  readonly shards: readonly Shard[];
}

export function planShards(
  mrCase: MRCase,
  config: ShardConfig = DEFAULT_SHARD_CONFIG,
): Result<ShardPlan> {
  const configError = validateShardConfig(config);
  if (configError !== undefined) {
    return err(configError);
  }
  const metrics = measureDiffBoundary(mrCase.diff);
  if (!metrics.ok) {
    return err(metrics.error);
  }
  // 触发判定与数据集边界过滤构造上同源（checkBoundary 同函数同判定序）；
  // reason 词表按 spec #48 实现决策 11 映射为 shards 节的 "files" | "lines"
  const outcome = checkBoundary(metrics.value, config.boundary);
  if (outcome.accepted) {
    return ok({
      sharded: false,
      reason: null,
      boundary: config.boundary,
      maxShards: config.maxShards,
      shards: [],
    });
  }
  const reason: ShardReason = outcome.reason === "too-many-files" ? "files" : "lines";
  const parsed = parseUnifiedDiff(mrCase.diff);
  if (!parsed.ok) {
    return err(new DatasetError("MALFORMED_DIFF", `diff 解析失败: ${parsed.error.message}`));
  }
  const packingFiles = parsed.value.map((fileDiff) => ({
    path: filePathOf(fileDiff),
    fileDiff,
    changedLines: fileChangedLines(fileDiff),
  }));
  const packed = packShards(packingFiles, config.boundary);
  if (packed.length > config.maxShards) {
    return err(
      new DatasetError(
        "SHARD_LIMIT_EXCEEDED",
        `所需分片数 ${packed.length} 超过上限 ${config.maxShards}`,
        // 结构化拒绝参数（#61）：RPC 错误帧 error.data / 平台侧可编程区分的源
        { requiredShards: packed.length, shardLimit: config.maxShards },
      ),
    );
  }
  const shards: Shard[] = [];
  for (let index = 0; index < packed.length; index += 1) {
    const shard = buildShard(mrCase, packed[index]!, index);
    if (!shard.ok) {
      return err(shard.error);
    }
    shards.push(shard.value);
  }
  return ok({
    sharded: true,
    reason,
    boundary: config.boundary,
    maxShards: config.maxShards,
    shards,
  });
}

interface PackingFile {
  readonly path: string;
  readonly fileDiff: FileDiff;
  readonly changedLines: number;
}

interface PackedGroup {
  readonly files: readonly PackingFile[];
  readonly diffLines: number;
  readonly outOfDomain: boolean;
}

function validateShardConfig(config: ShardConfig): DatasetError | undefined {
  const { maxFiles, maxDiffLines } = config.boundary;
  if (!Number.isInteger(maxFiles) || maxFiles < 1) {
    return new DatasetError("SHARD_CONFIG_INVALID", `maxFiles 必须为正整数（got ${maxFiles}）`);
  }
  if (!Number.isInteger(maxDiffLines) || maxDiffLines < 1) {
    return new DatasetError(
      "SHARD_CONFIG_INVALID",
      `maxDiffLines 必须为正整数（got ${maxDiffLines}）`,
    );
  }
  if (!Number.isInteger(config.maxShards) || config.maxShards < 1) {
    return new DatasetError(
      "SHARD_CONFIG_INVALID",
      `maxShards 必须为正整数（got ${config.maxShards}）`,
    );
  }
  return undefined;
}

/**
 * 装箱入口：单文件自身超界（行数 > maxDiffLines）无法与任何文件同片，
 * 先行分离——正常文件按包亲和装箱不受其干扰（同目录正常文件仍聚片），
 * 超界单文件各自成片（outOfDomain）按出现序追加末尾。
 */
function packShards(files: readonly PackingFile[], boundary: MrBoundary): PackedGroup[] {
  const normal: PackingFile[] = [];
  const oversized: PackingFile[] = [];
  for (const file of files) {
    if (file.changedLines > boundary.maxDiffLines) {
      oversized.push(file);
    } else {
      normal.push(file);
    }
  }
  return [
    ...packByAffinity(normal, boundary),
    ...oversized.map((file) => ({
      files: [file] as const,
      diffLines: file.changedLines,
      outOfDomain: true,
    })),
  ];
}

/**
 * 包亲和贪心装箱：按变更文件的目录分组（包亲和），组为单位 next-fit——
 * 当前片装得下整组（文件数与行数双维）则装入，装不下则开新片装整组；
 * 组自身超界（双维任一）无法整装时开新片、组内顺序填满（同组文件不与
 * 前面组的片混装，保证组内文件尽量同片）。全部顺序来自输入出现序（确定性）。
 */
function packByAffinity(files: readonly PackingFile[], boundary: MrBoundary): PackedGroup[] {
  const shards: { files: PackingFile[]; diffLines: number }[] = [];
  for (const groupFiles of groupByDirectory(files)) {
    const groupLines = groupFiles.reduce((sum, file) => sum + file.changedLines, 0);
    const groupFitsWhole =
      groupFiles.length <= boundary.maxFiles && groupLines <= boundary.maxDiffLines;
    if (groupFitsWhole) {
      const current = shards.at(-1);
      if (
        current !== undefined &&
        current.files.length + groupFiles.length <= boundary.maxFiles &&
        current.diffLines + groupLines <= boundary.maxDiffLines
      ) {
        shards[shards.length - 1] = {
          files: [...current.files, ...groupFiles],
          diffLines: current.diffLines + groupLines,
        };
        continue;
      }
      shards.push({ files: [...groupFiles], diffLines: groupLines });
      continue;
    }
    let current: { files: PackingFile[]; diffLines: number } | null = null;
    for (const file of groupFiles) {
      const fits =
        current !== null &&
        current.files.length + 1 <= boundary.maxFiles &&
        current.diffLines + file.changedLines <= boundary.maxDiffLines;
      if (fits && current !== null) {
        current = {
          files: [...current.files, file],
          diffLines: current.diffLines + file.changedLines,
        };
      } else {
        if (current !== null) {
          shards.push(current);
        }
        current = { files: [file], diffLines: file.changedLines };
      }
    }
    if (current !== null) {
      shards.push(current);
    }
  }
  return shards.map((shard) => ({
    files: shard.files,
    diffLines: shard.diffLines,
    outOfDomain: false,
  }));
}

/** 目录分组：保序 Map（组按首文件出现序、组内按出现序） */
function groupByDirectory(files: readonly PackingFile[]): PackingFile[][] {
  const byDir = new Map<string, PackingFile[]>();
  for (const file of files) {
    const dir = directoryOf(file.path);
    const existing = byDir.get(dir);
    byDir.set(dir, existing === undefined ? [file] : [...existing, file]);
  }
  return [...byDir.values()];
}

/** 文件路径的目录部分（包亲和键）；根目录文件归入空串组 */
function directoryOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

function buildShard(mrCase: MRCase, group: PackedGroup, index: number): Result<Shard> {
  const shardId = `${mrCase.caseId}#shard-${String(index + 1).padStart(3, "0")}`;
  const diffResult = serializeUnifiedDiff(group.files.map((file) => file.fileDiff));
  if (!diffResult.ok) {
    // 不可达：分片文件来自已解析的原 diff，序列化必成功
    return err(diffResult.error);
  }
  const filePaths = group.files.map((file) => file.path);
  let truth = mrCase.truth;
  if (mrCase.truth !== null) {
    const filtered = filterTruth(mrCase.truth, filePaths);
    if (!filtered.ok) {
      return err(filtered.error);
    }
    truth = filtered.value;
  }
  return ok({
    shardId,
    files: group.files.length,
    diffLines: group.diffLines,
    outOfDomain: group.outOfDomain,
    filePaths,
    diff: diffResult.value,
    mrCase: {
      ...mrCase,
      caseId: shardId,
      diff: diffResult.value,
      truth,
    },
  });
}

/**
 * 真值片内过滤：locations 只保留片内文件的条目；fixPatch 过滤为片内文件的
 * 块（文件级子集不改行号）。片内无真值文件时返回 null（该分片对判定链
 * 而言即阴性片，且兼容运行输入校验对 truth 的非空约束）。
 */
function filterTruth(
  truth: NonNullable<MRCase["truth"]>,
  filePaths: readonly string[],
): Result<NonNullable<MRCase["truth"]> | null> {
  const fileSet = new Set(filePaths);
  const locations = truth.locations.filter((location) => fileSet.has(location.file));
  if (locations.length === 0) {
    return ok(null);
  }
  const parsed = parseUnifiedDiff(truth.fixPatch);
  if (!parsed.ok) {
    return err(
      new DatasetError("INVALID_FIX_PATCH", `truth.fixPatch 解析失败: ${parsed.error.message}`),
    );
  }
  const kept = parsed.value.filter((file) => fileSet.has(filePathOf(file)));
  if (kept.length === 0) {
    return err(
      new DatasetError(
        "INVALID_FIX_PATCH",
        "truth.fixPatch 不含片内真值 locations 指向的文件（真值与 diff 文件集不一致）",
      ),
    );
  }
  const serialized = serializeUnifiedDiff(kept);
  if (!serialized.ok) {
    return err(
      new DatasetError(
        "INVALID_FIX_PATCH",
        `truth.fixPatch 片内过滤后序列化失败: ${serialized.error.message}`,
      ),
    );
  }
  return ok({ locations, fixPatch: serialized.value });
}

function filePathOf(file: FileDiff): string {
  // parseUnifiedDiff 保证新旧路径至少一侧非 null（双侧 /dev/null 显式报错）
  return file.newPath ?? file.oldPath!;
}

/** 单文件变更行数（新增 + 删除，与边界口径同源） */
function fileChangedLines(file: FileDiff): number {
  let count = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.type === "add" || line.type === "remove") {
        count += 1;
      }
    }
  }
  return count;
}
