import type { ConfigId } from "./config.js";

/**
 * MRCase 契约：一次检视的完整输入（spec #1）。
 *
 * T02（逆补丁法构造器）生产本类型；T01（harness）消费本类型。
 * 逆补丁法（Inverse-Patch）：base 为修复后版本，MR diff 为修复补丁的逆 diff，
 * 真值为最小修复补丁的行位与性质。
 * T08（Vul4J / Multi-SWE-bench Java 接入）扩展：新增可选 extensions 字段
 * （数据源私有元数据，向下兼容——harness 不消费、不校验其内容）。
 */

export interface MRCase {
  readonly caseId: string;
  /** 本地 git 仓库路径（base = MR 前版本；逆补丁法下为修复后版本） */
  readonly repoPath: string;
  /** MR 的 unified diff（检视对象本体） */
  readonly diff: string;
  /** issue 描述（真值上下文；clean MR 为空串） */
  readonly issueDescription: string;
  /** 真值；clean MR（阴性对照）为 null */
  readonly truth: MRTruth | null;
  readonly labels: CaseLabels;
  /**
   * 数据源扩展字段（T08 新增，可选）：数据集适配层写入的数据源私有元数据
   * （如 MSB 的 baseSha/org/repo/number，Vul4J 的 cveId/cweId/fixCommitUrl）。
   * 全部为 string 值（可序列化、可入清单）；harness 不消费、不校验其内容，
   * 仅供 T09 判定链与 T12 数据管线溯源。
   */
  readonly extensions?: Readonly<Record<string, string>>;
}

export interface MRTruth {
  /** 最小修复补丁的精确行位与性质 */
  readonly locations: readonly TruthLocation[];
  /** 最小修复补丁原文 */
  readonly fixPatch: string;
}

export interface TruthLocation {
  readonly file: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  /** 缺陷性质类别（与 Finding.category 同词表） */
  readonly defectNature: string;
}

export interface CaseLabels {
  /** 数据来源：defects4j | vul4j | msb-java | clean-mr */
  readonly source: string;
  /** 风险分级 */
  readonly riskClass: "Low" | "Medium" | "High";
  /** 允许跑的配置（MSB-Java 真实 PR 形态仅 C/E；默认全部） */
  readonly allowedConfigs: readonly ConfigId[];
}
