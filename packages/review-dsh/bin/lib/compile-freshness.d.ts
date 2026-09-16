/**
 * 编译产物 mtime 判鲜（实现见同目录 compile-freshness.js，纯 node 内建零依赖，
 * 供产品面 bin 与单元测试共用）。
 */

/**
 * 产物是否陈旧：缺席 → true；任一源根的最新 mtime 严格晚于产物 mtime → true。
 * 等于视为新鲜（同刻产物不重编）。
 */
export declare function isCompileStale(outputPath: string, sourceRoots: readonly string[]): boolean;
