import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { SourceSnapshot } from "../../dataset/diff/apply-unified-diff.js";
import type { ConfigId } from "../../contracts/config.js";
import type { MRCase } from "../../contracts/mr-case.js";
import type { CompositeFillParams } from "../synthetic/compose-composite.js";
import type { RunRecord } from "../run-store.js";
import type { ShardingGroupInput, ShardingValidationConfig } from "./harness.js";
import { runShardingValidation, writeShardingValidationReport, type GroupFailure, type ShardingHarnessDeps } from "./harness.js";

/**
 * 验证跑驱动层（#59，实验设计 §2.1–2.5）：真跑矩阵的组装与执行编排。
 *
 * 组装（buildGroupInputs）：同 slug 案例各自是独立 clone（不同 fix commit 快照），
 * 组内统一到锚——锚 = fix commit 最新者（与 composeComposite 同规则），全部候选
 * 的 repoPath / snapshot 改写 / 取自锚 clone；非锚案例的逆补丁在锚快照上干净
 * 套用由 composeComposite 硬校验兜底（套不上即弃留痕，#52 语义）。基线记录
 * 逐案 × rep 装载（Phase 2 main 侧直跑），缺失记录不在此拦——harness 阶段 2
 * 按口径匹配拦（HARNESS_BASELINE_MISSING）。
 *
 * 执行（runValidationGroups）：断点粒度 = 组 × rep——逐组逐 rep 独立调用
 * runShardingValidation 并落盘 report.json（存在即跳过，零重烧）；失败组无
 * report 产物，重跑自然重试（暂时性 LLM 失败可恢复）。组优先 × rep 内层：
 * 一组全部 rep 完成即有完整组级结论。
 */

/** 驱动层组配置：案例 id 清单 + 双臂填充档位（真跑矩阵的输入面，#59 设计 §2.2） */
export interface ShardingDriverGroup {
  readonly groupId: string;
  readonly caseIds: readonly string[];
  readonly treatmentFill: CompositeFillParams;
  readonly controlFill: CompositeFillParams;
}

/** 组装参数（装载面全部注入：真跑 = clone 目录快照 + RunStore；测试 fake） */
export interface BuildGroupInputsParams {
  readonly groups: readonly ShardingDriverGroup[];
  readonly cases: readonly MRCase[];
  /** caseId → fix commit 时间（ISO 8601；真跑从 GitHub API 一次性取数落盘） */
  readonly fixCommitDates: ReadonlyMap<string, string>;
  /** 锚 clone → SourceSnapshot（真跑 = loadRepoSnapshot；驱动层按 repoPath memo） */
  readonly loadSnapshot: (repoPath: string) => Promise<SourceSnapshot>;
  /** 基线记录读取（真跑 = RunStore over phase2-dsh；unit 含 caseId + rep） */
  readonly readBaseline: (unit: { readonly caseId: string; readonly rep: number }) => Promise<RunRecord | null>;
  readonly baselineReps: readonly number[];
  readonly configId: ConfigId;
  readonly model: string;
}

/** 组装产出：可直接喂 runValidationGroups 的组输入 + 锚留痕 */
export interface BuiltGroup {
  readonly input: ShardingGroupInput;
  readonly anchorCaseId: string;
}

export interface BuildGroupInputsOutcome {
  readonly groups: readonly BuiltGroup[];
}

/**
 * clone 目录 → SourceSnapshot：递归收 .java 文件，键 = 相对路径（posix 分隔、
 * 路径排序确定性——快照键序是填充选择流的输入），值 = 文件内容。
 *
 * 读取并发化：争用磁盘下串行逐文件 await 的往返延迟是主导项（#59 干跑实测
 * 27KB/s，45 分钟未读完 143MB）——子目录并行遍历 + 内容有界并发读；产出按
 * 路径序物化，与串行实现同键同值同键序（确定性不依赖完成顺序）。
 */
export async function loadRepoSnapshot(repoPath: string): Promise<SourceSnapshot> {
  const files: string[] = [];
  await collectJavaFiles(repoPath, "", files);
  files.sort();
  const contents = new Map<string, string>();
  await readFilesBounded(repoPath, files, contents, 64);
  const snapshot: Record<string, string> = {};
  for (const file of files) {
    snapshot[file] = contents.get(file)!;
  }
  return snapshot;
}

/** 有界并发读（worker 池共享游标；readFile 错误原样上抛——与串行同错误面） */
async function readFilesBounded(
  repoPath: string,
  files: readonly string[],
  into: Map<string, string>,
  concurrency: number,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const file = files[next]!;
      next += 1;
      into.set(file, await readFile(join(repoPath, file), "utf8"));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
}

/** 递归收集 .java 相对路径（子目录并行遍历；收集序不确定 → 统一排序兜底） */
async function collectJavaFiles(root: string, relative: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(join(root, relative), { withFileTypes: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`loadRepoSnapshot: failed to read ${join(root, relative)}: ${message}`, { cause: error });
  }
  const subdirectories: string[] = [];
  for (const entry of entries) {
    const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      subdirectories.push(child);
    } else if (entry.isFile() && entry.name.endsWith(".java")) {
      out.push(child);
    }
  }
  await Promise.all(subdirectories.map((child) => collectJavaFiles(root, child, out)));
}

/** 锚判定（与 composeComposite isAnchorAfter 同规则）：fix commit 最新者，同刻 caseId 码元序大者 */
function isAnchorAfter(
  candidate: { readonly mrCase: { readonly caseId: string }; readonly fixCommitAt: string },
  best: { readonly mrCase: { readonly caseId: string }; readonly fixCommitAt: string },
): boolean {
  const candidateAt = Date.parse(candidate.fixCommitAt);
  const bestAt = Date.parse(best.fixCommitAt);
  if (candidateAt !== bestAt) {
    return candidateAt > bestAt;
  }
  return candidate.mrCase.caseId > best.mrCase.caseId;
}

/** 组装真跑矩阵的组输入（锚统一 + 基线装载；组装输入错误 fail fast） */
export async function buildGroupInputs(params: BuildGroupInputsParams): Promise<BuildGroupInputsOutcome> {
  const caseById = new Map(params.cases.map((mrCase) => [mrCase.caseId, mrCase]));
  const snapshotByRepo = new Map<string, SourceSnapshot>();
  const built: BuiltGroup[] = [];

  for (const group of params.groups) {
    if (group.caseIds.length === 0) {
      throw new Error(`group "${group.groupId}" has no caseIds (a composite needs >= 2 candidates)`);
    }
    // 尝试序 = caseId 升序（确定性；锚判定与尝试序无关——composeComposite 自行锚定）
    const orderedIds = [...group.caseIds].sort();
    const mrCases = orderedIds.map((caseId) => {
      const mrCase = caseById.get(caseId);
      if (mrCase === undefined) {
        throw new Error(`group "${group.groupId}" references unknown caseId "${caseId}" (not in the loaded cases)`);
      }
      const fixCommitAt = params.fixCommitDates.get(caseId);
      if (fixCommitAt === undefined) {
        throw new Error(`group "${group.groupId}" case "${caseId}" has no fixCommitAt (fetch dates for every candidate before assembling)`);
      }
      return { mrCase, fixCommitAt };
    });

    // 锚 = fix commit 最新者；组内 repoPath / snapshot 统一到锚 clone
    const anchor = mrCases.reduce((best, candidate) =>
      isAnchorAfter(candidate, best) ? candidate : best,
    );
    let snapshot = snapshotByRepo.get(anchor.mrCase.repoPath);
    if (snapshot === undefined) {
      snapshot = await params.loadSnapshot(anchor.mrCase.repoPath);
      snapshotByRepo.set(anchor.mrCase.repoPath, snapshot);
    }

    const candidates = mrCases.map(({ mrCase, fixCommitAt }) => ({
      mrCase:
        mrCase === anchor.mrCase
          ? mrCase
          : { ...mrCase, repoPath: anchor.mrCase.repoPath },
      fixCommitAt,
      snapshot,
    }));

    const baseline: RunRecord[] = [];
    for (const caseId of orderedIds) {
      for (const rep of params.baselineReps) {
        const record = await params.readBaseline({ caseId, rep });
        if (record !== null) {
          baseline.push(record);
        }
      }
    }

    built.push({
      input: {
        spec: {
          groupId: group.groupId,
          candidates,
          treatmentFill: group.treatmentFill,
          controlFill: group.controlFill,
        },
        baseline,
      },
      anchorCaseId: anchor.mrCase.caseId,
    });
  }
  return { groups: built };
}

/** 执行参数（config / deps 与 runShardingValidation 同面；auditRoot 按 rep 分目录） */
export interface RunValidationGroupsParams {
  readonly groups: readonly ShardingGroupInput[];
  readonly config: ShardingValidationConfig;
  readonly deps: Omit<ShardingHarnessDeps, "auditRoot">;
  /** 审计根目录：每 rep 落 <auditRoot>/rep-<N>/<groupId>/<arm>/<unit>/ */
  readonly auditRoot: string;
  /** 报告根目录：产物落 <reportRoot>/<groupId>/rep-<N>/report.json */
  readonly reportRoot: string;
  readonly reps: readonly number[];
}

export interface RunValidationGroupsOutcome {
  /** 本次成功落盘的组 × rep（断点产物新增面） */
  readonly executed: readonly string[];
  /** 断点跳过的组 × rep（report.json 已存在，零重烧） */
  readonly skipped: readonly string[];
  /** 本次失败的组 × rep（无断点产物，重跑自然重试） */
  readonly failures: readonly GroupFailure[];
}

/** 逐组 × 逐 rep 执行验证 harness，独立落盘（断点粒度 = 组 × rep） */
export async function runValidationGroups(params: RunValidationGroupsParams): Promise<RunValidationGroupsOutcome> {
  const executed: string[] = [];
  const skipped: string[] = [];
  const failures: GroupFailure[] = [];

  for (const group of params.groups) {
    for (const rep of params.reps) {
      const runKey = `${group.spec.groupId}/rep-${rep}`;
      const reportDir = join(params.reportRoot, group.spec.groupId, `rep-${rep}`);
      if (await exists(join(reportDir, "report.json"))) {
        skipped.push(runKey);
        continue;
      }
      const outcome = await runShardingValidation({
        config: params.config,
        deps: { ...params.deps, auditRoot: join(params.auditRoot, `rep-${rep}`) },
        groups: [group],
      });
      if (outcome.groups.length > 0) {
        writeShardingValidationReport(reportDir, outcome);
        executed.push(runKey);
      } else {
        failures.push(...outcome.failures);
      }
    }
  }
  return { executed, skipped, failures };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
