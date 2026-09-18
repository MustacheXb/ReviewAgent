import type { SourceSnapshot } from "../../dataset/diff/apply-unified-diff.js";
import {
  type DiffLine,
  type FileDiff,
  type Hunk,
  type Result,
  DatasetError,
  err,
  ok,
} from "../../dataset/diff/types.js";
import { serializeUnifiedDiff } from "../../dataset/diff/serialize-unified-diff.js";

/**
 * 良性填充生成器（spec #48 实现决策 14，ticket #52）：对快照内与全部案例
 * 文件不相交的文件做确定性机械编辑（注释 / javadoc / 局部重命名 / 日志语句），
 * 撑到目标规模档位（目标文件数与变更行数双维）。
 *
 * - 确定性：无时钟无随机源——种子（字符串）经 FNV-1a → mulberry32 驱动
 *   全部选择；同参数（快照 + 禁改集 + 目标 + 种子）必同输出。
 * - 良性（不引入缺陷、不污染真值）：只触碰与案例文件不相交的文件；
 *   四类编辑均为行级机械变换——整行注释可插入任意行间（token 边界空白），
 *   日志语句只插在语句边界前，javadoc 只挂在方法 / 类声明前，局部重命名
 *   只改「全快照仅本文件出现」的标识符（文件内全量一致替换）。
 * - 保守排除：非 .java、含文本块（"""）、不以换行收尾的文件不参与。
 * - 留痕：每条编辑（文件 / 行 / 类型）进 FillResult.edits，可入 manifest 重放。
 * - 性能（输出等价的缓存层，仓库级快照必须）：全快照标识符 → 文件计数一次
 *   构建（重命名唯一性 O(1) 判定，替代逐候选全快照扫描的 O(files²)）；逐文件
 *   原始锚行缓存（正则命中不随占用变化，占用过滤取用时做）；逐文件重命名
 *   候选缓存（该文件被放置编辑即失效）。rng 消耗序列与池构造不变 ⇒ 同输入
 *   逐字节同输出。
 */

/**
 * 语句边界锚（日志语句可插在前的新语句起点）。不含 `}` / else / catch——
 * 它们前面的位置可能是类体或紧贴块语法结构，插语句不安全。
 */
const STATEMENT_ANCHOR_RE =
  /^\s*(?:return\b|throw\b|break\b|continue\b|if\s*\(|for\s*\(|while\s*\(|switch\s*\(|try\b)/;
/** javadoc 锚（方法 / 构造器 / 类声明行） */
const JAVADOC_ANCHOR_RE =
  /^\s*(?:public|private|protected|static|final|abstract)\b.*\(|^\s*(?:class|interface|enum)\b/;
/** 局部变量声明（带初始化；捕获标识符） */
const RENAME_DECL_RE =
  /^\s*(?:final\s+)?(?:[A-Z][\w]*(?:\.[A-Z][\w]*)*(?:<[^>]*>)?(?:\[\])?|(?:int|long|double|float|boolean|char|byte|short|var))\s+([a-z][A-Za-z0-9_]*)\s*=[^=]/;

/** 四类机械编辑（spec 决策 14 词表；round-robin 起点轮转保证容量充足时四类均被尝试——某类锚耗尽时跳过该类，不保证齐备） */
export type FillEditKind = "comment" | "javadoc" | "rename" | "log";

const FILL_EDIT_KINDS: readonly FillEditKind[] = ["comment", "javadoc", "rename", "log"];

/** 插入类编辑描述子：锚正则 + 插入文本模板（kind 级联收拢为单表） */
interface InsertionSpec {
  /** 锚行正则（null = 任意行） */
  readonly anchorRe: RegExp | null;
  /** 由缩进与编辑序号生成插入行 */
  readonly buildLines: (indent: string, sequenceNo: number) => readonly string[];
}

const INSERTION_SPECS: Readonly<Record<"comment" | "javadoc" | "log", InsertionSpec>> = Object.freeze({
  comment: {
    anchorRe: null,
    buildLines: (indent, sequenceNo) => [`${indent}// benign note ${sequenceNo}`],
  },
  javadoc: {
    anchorRe: JAVADOC_ANCHOR_RE,
    buildLines: (indent, sequenceNo) => [
      `${indent}/**`,
      `${indent} * benign documentation note ${sequenceNo}`,
      `${indent} */`,
    ],
  },
  log: {
    anchorRe: STATEMENT_ANCHOR_RE,
    buildLines: (indent, sequenceNo) => [`${indent}System.err.println("benign log ${sequenceNo}");`],
  },
});

/** 单条机械编辑留痕（旧坐标行号） */
export interface FillEdit {
  readonly file: string;
  readonly line: number;
  readonly kind: FillEditKind;
}

/** 目标规模档位（双维都达标或候选耗尽） */
export interface FillTargets {
  /** 填充需触碰的文件数下限 */
  readonly targetFiles: number;
  /** 填充需产生的变更行数（新增 + 删除口径）下限 */
  readonly targetDiffLines: number;
}

export interface FillResult {
  /** 填充 diff（unified；零目标时为空串） */
  readonly diff: string;
  /** 全部机械编辑留痕（确定性序） */
  readonly edits: readonly FillEdit[];
  readonly filesTouched: readonly string[];
  readonly diffLines: number;
}

/** 候选文件（行数组 + 已占用旧行区间；编辑互不侵扰保证 hunk 上下文不交叠） */
interface FillFile {
  readonly path: string;
  readonly lines: readonly string[];
  readonly occupied: Array<readonly [number, number]>;
}

/** 已放置的编辑：留痕 + 构造好的 hunk（按放置序） */
interface PlacedEdit {
  readonly edit: FillEdit;
  readonly file: FillFile;
  readonly hunks: readonly Hunk[];
  /** 本编辑贡献的变更行数（新增 + 删除） */
  readonly diffLines: number;
}

/** 放置会话（放置函数共享的状态：候选文件 / 快照 / 随机源 / 目标 / 已触碰集） */
interface PlacementSession {
  readonly files: readonly FillFile[];
  readonly base: SourceSnapshot;
  readonly rng: () => number;
  readonly targets: FillTargets;
  readonly touched: ReadonlySet<string>;
  /** 性能层（输出等价缓存；见模块头「性能」节） */
  readonly index: FillIndex;
}

/**
 * 性能层缓存（不承载语义——删掉即回退到逐次重算，输出不变）：
 * 仓库级快照（数千文件）下，逐编辑重算全文件锚 / 重命名候选、逐候选全快照
 * 扫描唯一性是 O(files²)，#59 干跑实测 45 分钟无产出。三层缓存把它压回
 * 一次线性预热 + 逐编辑 O(files) 池构造。
 */
interface FillIndex {
  /** 标识符 → 含它的快照文件数（全快照一次 tokenize；唯一 ⟺ 计数 1——本文件必含候选标识符） */
  readonly identifierFileCounts: ReadonlyMap<string, number>;
  /** 文件路径 → kind → 原始锚行（正则命中，升序；不含占用过滤——取用时过滤） */
  readonly rawAnchors: Map<string, Map<FillEditKind, readonly number[]>>;
  /** 文件路径 → 重命名候选（依赖占用状态 ⇒ 该文件被放置编辑即失效删除） */
  readonly renameCandidates: Map<string, readonly RenameCandidate[]>;
}

export function generateBenignFill(
  base: SourceSnapshot,
  forbiddenFiles: ReadonlySet<string>,
  targets: FillTargets,
  seed: string,
): Result<FillResult> {
  const targetError = validateFillTargets(targets);
  if (targetError !== undefined) {
    return err(targetError);
  }
  if (targets.targetFiles === 0 && targets.targetDiffLines === 0) {
    return ok({ diff: "", edits: [], filesTouched: [], diffLines: 0 });
  }
  const files = buildFillFiles(base, forbiddenFiles);
  if (files.length === 0) {
    return err(
      new DatasetError(
        "COMPOSITE_FILL_EXHAUSTED",
        "填充候选文件耗尽：快照内无与案例文件不相交的可机械编辑 .java 文件",
      ),
    );
  }
  const touched = new Set<string>();
  const session: PlacementSession = {
    files,
    base,
    rng: makeRng(seed),
    targets,
    touched,
    index: {
      identifierFileCounts: buildIdentifierFileCounts(base),
      rawAnchors: new Map(),
      renameCandidates: new Map(),
    },
  };
  const placed: PlacedEdit[] = [];
  let diffLines = 0;
  // round-robin 起点轮转 + 其余三类依序兜底：一轮四类全放不下即候选耗尽
  for (let editIndex = 0; touched.size < targets.targetFiles || diffLines < targets.targetDiffLines; editIndex += 1) {
    let placedThisRound: PlacedEdit | null = null;
    for (let attempt = 0; attempt < FILL_EDIT_KINDS.length && placedThisRound === null; attempt += 1) {
      const kind = FILL_EDIT_KINDS[(editIndex + attempt) % FILL_EDIT_KINDS.length]!;
      placedThisRound =
        kind === "rename" ? placeRename(session) : placeInsertion(session, kind, editIndex + 1);
    }
    if (placedThisRound === null) {
      return err(
        new DatasetError(
          "COMPOSITE_FILL_EXHAUSTED",
          `填充候选耗尽：已触碰 ${touched.size} 文件 / ${diffLines} 变更行，未达目标 ${targets.targetFiles} 文件 / ${targets.targetDiffLines} 行`,
        ),
      );
    }
    placed.push(placedThisRound);
    touched.add(placedThisRound.edit.file);
    diffLines += placedThisRound.diffLines;
    // 占用状态变化 ⇒ 该文件的重命名候选缓存失效（原始锚缓存不依赖占用，保留）
    session.index.renameCandidates.delete(placedThisRound.edit.file);
  }
  const diff = buildFillDiff(placed);
  if (!diff.ok) {
    return diff;
  }
  return ok({
    diff: diff.value,
    edits: placed.map((item) => item.edit),
    filesTouched: [...touched],
    diffLines,
  });
}

/** 填充目标校验（导出供合成组合构造器复用）：两维均须为非负整数 */
export function validateFillTargets(targets: FillTargets): DatasetError | undefined {
  if (
    !Number.isInteger(targets.targetFiles) ||
    targets.targetFiles < 0 ||
    !Number.isInteger(targets.targetDiffLines) ||
    targets.targetDiffLines < 0
  ) {
    return new DatasetError(
      "COMPOSITE_INPUT_INVALID",
      `填充目标必须为非负整数（got files=${targets.targetFiles}, lines=${targets.targetDiffLines}）`,
    );
  }
  return undefined;
}

/** 候选文件：.java、非禁改、无文本块、换行收尾、非空；按路径字典序（确定性） */
function buildFillFiles(base: SourceSnapshot, forbiddenFiles: ReadonlySet<string>): FillFile[] {
  const files: FillFile[] = [];
  for (const path of Object.keys(base).sort()) {
    if (forbiddenFiles.has(path) || !path.endsWith(".java")) {
      continue;
    }
    const content = base[path]!;
    if (content.length === 0 || content.includes('"""') || !content.endsWith("\n")) {
      continue;
    }
    files.push({ path, lines: content.slice(0, -1).split("\n"), occupied: [] });
  }
  return files;
}

// ---------- 编辑放置 ----------

/**
 * 选文件：payloadOf 单次计算每文件的可用容量（锚行 / 重命名候选），null = 无容量；
 * 文件数未达标时优先未触碰的文件（保证 targetFiles 可达，无可选时回退全体可用）。
 * 返回随机命中的 {file, payload}；可用集为空返回 null。
 */
function pickFile<T>(
  session: PlacementSession,
  payloadOf: (file: FillFile) => T | null,
): { readonly file: FillFile; readonly payload: T } | null {
  const usable = session.files
    .map((file) => ({ file, payload: payloadOf(file) }))
    .filter((entry): entry is { readonly file: FillFile; readonly payload: T } => entry.payload !== null);
  let pool = usable;
  if (session.touched.size < session.targets.targetFiles) {
    const untouched = usable.filter((entry) => !session.touched.has(entry.file.path));
    if (untouched.length > 0) {
      pool = untouched;
    }
  }
  if (pool.length === 0) {
    return null;
  }
  return pool[Math.floor(session.rng() * pool.length)]!;
}

/** 插入类（comment / javadoc / log）：选文件 → 选锚行 → 构造 hunk（行为查 INSERTION_SPECS） */
function placeInsertion(
  session: PlacementSession,
  kind: "comment" | "javadoc" | "log",
  sequenceNo: number,
): PlacedEdit | null {
  const spec = INSERTION_SPECS[kind];
  const picked = pickFile(session, (file) => {
    const anchors = anchorLines(session, file, kind);
    return anchors.length > 0 ? anchors : null;
  });
  if (picked === null) {
    return null;
  }
  const anchorLine = picked.payload[Math.floor(session.rng() * picked.payload.length)]!;
  const indent = leadingWhitespace(picked.file.lines[anchorLine - 1]!);
  const added = spec.buildLines(indent, sequenceNo);
  const hunks = [buildInsertionHunk(picked.file, anchorLine, added)];
  // 插入 hunk 旧区间 = [anchorLine-3, anchorLine+2]（3 行上文 + 锚行起 3 行下文）
  markOccupied(picked.file, anchorLine - 3, anchorLine + 2);
  return {
    edit: { file: picked.file.path, line: anchorLine, kind },
    file: picked.file,
    hunks,
    diffLines: added.length,
  };
}

/** 重命名：候选标识符 = 声明行捕获 + 全快照唯一出现 + 无冲突后缀；簇状 hunk */
function placeRename(session: PlacementSession): PlacedEdit | null {
  const picked = pickFile(session, (file) => {
    const candidates = renameCandidates(session, file);
    return candidates.length > 0 ? candidates : null;
  });
  if (picked === null) {
    return null;
  }
  for (const candidate of picked.payload) {
    const hunks = buildRenameHunks(picked.file, candidate, candidate.occurrenceLines);
    if (hunks === null) {
      continue;
    }
    for (const group of groupRenameLines(candidate.occurrenceLines)) {
      // 组 hunk 旧区间 = [first-3, last+3]（组内间隔行作 context）
      markOccupied(picked.file, group[0]! - 3, group[group.length - 1]! + 3);
    }
    return {
      edit: { file: picked.file.path, line: candidate.declLine, kind: "rename" },
      file: picked.file,
      hunks,
      diffLines: candidate.occurrenceLines.length * 2,
    };
  }
  return null;
}

/** 锚行（1 起始）：类型正则命中且未被占用（原始命中走缓存，占用过滤取用时做） */
function anchorLines(
  session: PlacementSession,
  file: FillFile,
  kind: "comment" | "javadoc" | "log",
): readonly number[] {
  const raw = rawAnchorLines(session, file, kind);
  // 无占用区间 ⇒ 过滤是恒等变换，直接复用缓存引用（绝大多数文件的快路径）
  if (file.occupied.length === 0) {
    return raw;
  }
  return raw.filter((lineNo) => !isOccupied(file, lineNo));
}

/**
 * 原始锚行（忽略占用，正则命中升序）：逐 (文件, kind) 缓存——正则命中不随
 * 占用状态变化，一次计算终身有效。comment 无锚正则 = 全部行。
 */
function rawAnchorLines(
  session: PlacementSession,
  file: FillFile,
  kind: "comment" | "javadoc" | "log",
): readonly number[] {
  let byKind = session.index.rawAnchors.get(file.path);
  if (byKind === undefined) {
    byKind = new Map();
    session.index.rawAnchors.set(file.path, byKind);
  }
  const cached = byKind.get(kind);
  if (cached !== undefined) {
    return cached;
  }
  const anchorRe = INSERTION_SPECS[kind].anchorRe;
  const lines: number[] = [];
  if (anchorRe === null) {
    for (let lineNo = 1; lineNo <= file.lines.length; lineNo += 1) {
      lines.push(lineNo);
    }
  } else {
    for (let index = 0; index < file.lines.length; index += 1) {
      if (anchorRe.test(file.lines[index]!)) {
        lines.push(index + 1);
      }
    }
  }
  byKind.set(kind, lines);
  return lines;
}

interface RenameCandidate {
  readonly identifier: string;
  readonly renamed: string;
  /** 声明行（1 起始，留痕用） */
  readonly declLine: number;
  /** 全部出现行（1 起始，升序；每行做整体替换） */
  readonly occurrenceLines: readonly number[];
}

/** 词边界正则（\b 对 \w 标识符即整词匹配；替换场景传 "g"，test 场景缺省） */
function wordBoundaryRe(identifier: string, flags?: string): RegExp {
  return new RegExp(`\\b${identifier}\\b`, flags);
}

/** 重命名候选（逐文件缓存，文件被放置编辑即失效）：标识符只在快照本文件出现、出现行不含引号、重命名后缀无冲突 */
function renameCandidates(session: PlacementSession, file: FillFile): readonly RenameCandidate[] {
  const cached = session.index.renameCandidates.get(file.path);
  if (cached !== undefined) {
    return cached;
  }
  const computed = computeRenameCandidates(session, file);
  session.index.renameCandidates.set(file.path, computed);
  return computed;
}

function computeRenameCandidates(session: PlacementSession, file: FillFile): RenameCandidate[] {
  const candidates: RenameCandidate[] = [];
  for (let index = 0; index < file.lines.length; index += 1) {
    const match = RENAME_DECL_RE.exec(file.lines[index]!);
    if (match === null) {
      continue;
    }
    const identifier = match[1]!;
    const occurrenceLines = occurrenceLineNumbers(file, identifier);
    if (occurrenceLines.length === 0 || occurrenceLines.some((line) => isOccupied(file, line))) {
      continue;
    }
    // 行含引号 → 可能落在字符串字面量里，机械替换不安全：保守跳过
    if (occurrenceLines.some((line) => file.lines[line - 1]!.includes('"'))) {
      continue;
    }
    // 全快照唯一性：含它的文件数恰为 1（本文件必含——声明行已命中）
    if ((session.index.identifierFileCounts.get(identifier) ?? 0) !== 1) {
      continue;
    }
    const renamed = `${identifier}Filled`;
    if (wordBoundaryRe(renamed).test(session.base[file.path]!)) {
      continue;
    }
    candidates.push({ identifier, renamed, declLine: index + 1, occurrenceLines });
  }
  return candidates;
}

function occurrenceLineNumbers(file: FillFile, identifier: string): number[] {
  const re = wordBoundaryRe(identifier);
  const lines: number[] = [];
  for (let index = 0; index < file.lines.length; index += 1) {
    if (re.test(file.lines[index]!)) {
      lines.push(index + 1);
    }
  }
  return lines;
}

/**
 * 全快照标识符 → 文件计数（一次 tokenize 线性构建）：identifierFileCounts.get(id) === 1
 * ⟺ 含它的文件恰一个 ⟺ 旧逐候选扫描「其他文件均不含」的等价 O(1) 判定。
 * 计数覆盖 base 全部文件（含禁改 / 被排除文件）——与旧扫描的遍历面一致。
 */
function buildIdentifierFileCounts(base: SourceSnapshot): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  const tokenRe = /\w+/g;
  for (const path of Object.keys(base)) {
    const distinct = new Set<string>();
    for (const match of base[path]!.matchAll(tokenRe)) {
      distinct.add(match[0]!);
    }
    for (const identifier of distinct) {
      counts.set(identifier, (counts.get(identifier) ?? 0) + 1);
    }
  }
  return counts;
}

// ---------- hunk 构造 ----------

/** 插入 hunk：锚行前插 added（3 行上下文；锚行计入下文） */
function buildInsertionHunk(file: FillFile, anchorLine: number, added: readonly string[]): Hunk {
  const before = file.lines.slice(Math.max(0, anchorLine - 4), anchorLine - 1);
  const after = file.lines.slice(anchorLine - 1, Math.min(file.lines.length, anchorLine + 2));
  const oldStart = Math.max(1, anchorLine - 3);
  return {
    oldStart,
    oldCount: before.length + after.length,
    newStart: oldStart,
    newCount: before.length + added.length + after.length,
    lines: [
      ...before.map((text) => contextLine(text)),
      ...added.map((text) => ({ type: "add" as const, text })),
      ...after.map((text) => contextLine(text)),
    ],
  };
}

/**
 * 重命名 hunks：出现行分组后逐组一 hunk（remove + add 对，组间行作 context，
 * 3 行上下文）。分组规则：连续行成簇；簇间隔 ≤6 行时并入同组——两簇各自的
 * 3 行上下文会交叠（且一簇的上下文可能是另一簇的已改行），拆成多 hunk 则
 * 后序 hunk 的 context 与前序 hunk 的改动冲突，严格套用必失败。
 */
function buildRenameHunks(
  file: FillFile,
  candidate: RenameCandidate,
  occurrenceLines: readonly number[],
): readonly Hunk[] | null {
  const hunks: Hunk[] = [];
  for (const group of groupRenameLines(occurrenceLines)) {
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const oldStart = Math.max(1, first - 3);
    const oldEnd = Math.min(file.lines.length, last + 3);
    const lines: DiffLine[] = [];
    for (let line = oldStart; line <= oldEnd; line += 1) {
      const text = file.lines[line - 1]!;
      if (group.includes(line)) {
        lines.push({ type: "remove", text }, { type: "add", text: renameInLine(text, candidate.identifier, candidate.renamed) });
      } else {
        lines.push(contextLine(text));
      }
    }
    hunks.push({
      oldStart,
      oldCount: oldEnd - oldStart + 1,
      newStart: oldStart,
      newCount: oldEnd - oldStart + 1,
      lines,
    });
  }
  return hunks;
}

/** 连续行成簇 → 簇间隔 ≤6 行并入同组（上下文不交叠的最小间隔为 7） */
function groupRenameLines(lines: readonly number[]): number[][] {
  const groups: number[][] = [];
  for (const line of lines) {
    const lastGroup = groups[groups.length - 1];
    if (lastGroup !== undefined && line - lastGroup[lastGroup.length - 1]! <= 6) {
      lastGroup.push(line);
    } else {
      groups.push([line]);
    }
  }
  return groups;
}

/** 行内词边界替换（\b 对 \w 标识符即整词替换） */
function renameInLine(text: string, identifier: string, renamed: string): string {
  return text.replace(wordBoundaryRe(identifier, "g"), renamed);
}

/**
 * 占用登记（hunk 旧区间坐标）：登记 [start-4, end+4]。后续编辑的锚 / 出现
 * 行落在区间外 ⇒ 其 hunk（自身 ±3 上下文）与已放置 hunk 的旧区间必不交叠。
 */
function markOccupied(file: FillFile, start: number, end: number): void {
  file.occupied.push([start - 4, end + 4]);
  // 小文件（<10 行）一旦有编辑即全文件占用（上下文截断风险）
  if (file.lines.length < 10) {
    file.occupied.push([1, file.lines.length]);
  }
}

function isOccupied(file: FillFile, line: number): boolean {
  return file.occupied.some(([start, end]) => line >= start && line <= end);
}

function contextLine(text: string): DiffLine {
  return { type: "context", text };
}

/** 汇总填充 diff：编辑按文件归组（字典序）× 文件内按锚行升序，newStart 补偿前序偏移 */
function buildFillDiff(placed: readonly PlacedEdit[]): Result<string> {
  const byFile = new Map<string, { readonly file: FillFile; hunks: Hunk[] }>();
  for (const item of placed) {
    const entry = byFile.get(item.edit.file);
    if (entry === undefined) {
      byFile.set(item.edit.file, { file: item.file, hunks: [...item.hunks] });
    } else {
      entry.hunks.push(...item.hunks);
    }
  }
  const fileDiffs: FileDiff[] = [];
  for (const path of [...byFile.keys()].sort()) {
    const entry = byFile.get(path)!;
    entry.hunks.sort((a, b) => a.oldStart - b.oldStart);
    let delta = 0;
    const hunks = entry.hunks.map((hunk) => {
      const shifted = { ...hunk, newStart: hunk.newStart + delta };
      delta += hunk.newCount - hunk.oldCount;
      return shifted;
    });
    fileDiffs.push({
      oldPath: path,
      newPath: path,
      hunks,
      oldNoNewlineAtEnd: false,
      newNoNewlineAtEnd: false,
    });
  }
  if (fileDiffs.length === 0) {
    return ok("");
  }
  return serializeUnifiedDiff(fileDiffs);
}

// ---------- 确定性随机（FNV-1a 种子 → mulberry32） ----------

function makeRng(seed: string): () => number {
  let state = fnv1a(seed) || 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function leadingWhitespace(line: string): string {
  const match = /^[ \t]*/.exec(line);
  return match === null ? "" : match[0];
}
