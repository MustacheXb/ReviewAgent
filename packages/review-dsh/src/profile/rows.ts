/**
 * review profile 显式最小树（ADR-0006：sdk-minimal 式，不继承 dsh-base）。
 *
 * 行集 = DSH npm 行 + 核内插件行。session-projection 不在 ADR-0006 原始行集内：
 * 0.1.2-rc.1 的 agent-loop 构造期硬注入 sessionProjections（ctx.sessionProjections.register），
 * 缺行无法挂载——登记于 npm 版偏差清单（ticket 1 spike 1）。
 *
 * 本数组是行集的**声明记录**（bundle/profile 声明的雏形，ADR-0006「单包 bundle 声明」票消费）；
 * 可执行挂载在 assemble.ts（各行带自身 config，非均匀挂载）——两处顺序需人工保持一致。
 */

/** 一行：DSH npm 包（packageName 记录 npm 消费线的锁定来源）或核内插件 */
export type ReviewProfileRow =
  | { readonly kind: "dsh"; readonly id: string; readonly packageName: string }
  | { readonly kind: "kernel"; readonly id: string };

/** 显式最小树（声明记录；挂载顺序即依赖顺序） */
export const REVIEW_PROFILE_ROWS: readonly ReviewProfileRow[] = [
  { kind: "dsh", id: "cmdline", packageName: "@deepseek-ai/dsh-cmdline" },
  { kind: "dsh", id: "llm", packageName: "@deepseek-ai/dsh-llm" },
  { kind: "dsh", id: "session", packageName: "@deepseek-ai/dsh-session" },
  { kind: "dsh", id: "session-persistence-jsonl", packageName: "@deepseek-ai/dsh-session-persistence-jsonl" },
  { kind: "dsh", id: "session-projection", packageName: "@deepseek-ai/dsh-session-projection" },
  { kind: "dsh", id: "system-prompt", packageName: "@deepseek-ai/dsh-system-prompt" },
  { kind: "dsh", id: "tools", packageName: "@deepseek-ai/dsh-tools" },
  { kind: "dsh", id: "agent", packageName: "@deepseek-ai/dsh-agent" },
  { kind: "dsh", id: "agent-loop", packageName: "@deepseek-ai/dsh-agent-loop" },
  { kind: "kernel", id: "review-policy" },
  { kind: "kernel", id: "review-context" },
  { kind: "kernel", id: "review-cache" },
  { kind: "kernel", id: "review-evidence" },
  { kind: "kernel", id: "review-runtime" },
];
