/**
 * 报告/运行器共享的 JSON 落盘、读取与统计原语（experiment / reference 双侧去重）。
 *
 * - writeJsonFile / readJsonFile：目录自动创建、2 空格缩进 + 尾随换行；
 * - readJsonArrayFile：损坏/缺失/非数组一律视同空（失败留痕文件的容错口径）；
 * - groupAndSortByRep：记录按键分组、组内 rep 升序（续跑与报告的固定口径）；
 * - meanOf：算术均值（阴性对照等跨 rep/跨 case 聚合口径）。
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** JSON 落盘：父目录自动创建，2 空格缩进 + 尾随换行（git diff 友好） */
export async function writeJsonFile(filePath: string, content: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(content, null, 2)}\n`, "utf8");
}

/** JSON 读取：文件缺失返回 null；解析失败抛错（含文件路径与原因） */
export async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    await stat(filePath);
  } catch {
    return null;
  }
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to parse ${filePath}: ${message}`, { cause: error });
  }
}

/** 数组型 JSON 读取：缺失/解析失败/非数组一律返回空数组（失败留痕的容错口径） */
export async function readJsonArrayFile<T>(filePath: string): Promise<readonly T[]> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** 记录按键分组，组内 rep 升序（插入序保留；报告与续跑对账的固定口径） */
export function groupAndSortByRep<T extends { readonly rep: number }, K extends string>(
  records: readonly T[],
  keyOf: (record: T) => K,
): ReadonlyMap<K, readonly T[]> {
  const byKey = new Map<K, T[]>();
  for (const record of records) {
    byKey.set(keyOf(record), [...(byKey.get(keyOf(record)) ?? []), record]);
  }
  for (const [key, runs] of byKey) {
    byKey.set(key, [...runs].sort((a, b) => a.rep - b.rep));
  }
  return byKey;
}

/** 算术均值（空数组 → NaN，与历史行为一致；调用方保证非空） */
export function meanOf(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}
