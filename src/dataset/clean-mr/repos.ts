/**
 * clean MR 阴性对照（Ticket 09）的候选仓库清单。
 *
 * 口径：与 Multi-SWE-bench Java 子集完全相同的 9 个仓库
 * （HF `ByteDance-Seed/Multi-SWE-bench` 的 `java/` 目录，128 条正例的来源仓库，
 * 实测核对见 D:\xubao\code\AI4SE\.spec-notes\multi-swe-bench.md 第 3 节）。
 * 正例（issue 关联实例）与阴性对照（clean PR）取自同一仓库群，
 * 保证「主动检索是否推高无中生有率」对比（config A vs C）的同分布前提。
 */

export interface CleanMrRepo {
  readonly org: string;
  readonly repo: string;
  /** MSB Java 子集中该仓库的正例条数（分布参照，仅元数据） */
  readonly msbInstanceCount: number;
}

export const MSB_JAVA_REPOS: readonly CleanMrRepo[] = Object.freeze([
  { org: "fasterxml", repo: "jackson-databind", msbInstanceCount: 42 },
  { org: "elastic", repo: "logstash", msbInstanceCount: 38 },
  { org: "fasterxml", repo: "jackson-core", msbInstanceCount: 18 },
  { org: "alibaba", repo: "fastjson2", msbInstanceCount: 6 },
  { org: "mockito", repo: "mockito", msbInstanceCount: 6 },
  { org: "google", repo: "gson", msbInstanceCount: 5 },
  { org: "googlecontainertools", repo: "jib", msbInstanceCount: 5 },
  { org: "apache", repo: "dubbo", msbInstanceCount: 3 },
  { org: "fasterxml", repo: "jackson-dataformat-xml", msbInstanceCount: 5 },
]);

export function repoSlug(org: string, repo: string): string {
  return `${org}/${repo}`;
}

/** 清单内是否包含该仓库（去重校验用） */
export function isMsbJavaRepo(org: string, repo: string): boolean {
  return MSB_JAVA_REPOS.some((r) => r.org === org && r.repo === repo);
}
