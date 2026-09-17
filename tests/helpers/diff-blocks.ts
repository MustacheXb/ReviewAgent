/**
 * 单文件 diff 块构造器（切分器 / 编排 / CLI 进程级测试共用，不各抄一份）：
 * 1 context + N 新增行 + 1 context（变更行数 = N，边界口径与数据集过滤同源）。
 */

export function fileBlock(path: string, changedLineCount: number): string {
  const adds = Array.from({ length: changedLineCount }, (_, i) => `+line ${i + 1}`);
  return [
    `--- ${path}`,
    `+++ ${path}`,
    `@@ -1,2 +1,${2 + changedLineCount} @@`,
    " base",
    ...adds,
    " tail",
  ].join("\n") + "\n";
}
