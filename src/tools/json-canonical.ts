/**
 * 字节稳定 JSON 序列化（工具 schema 专用，spec #1 工单 #6）。
 *
 * 注册表层纪律：同一 schema 结构永远序列化为同一字节串——
 * - 对象键按固定优先序输出（JSON Schema 常用键在前，其余按字典序）；
 * - 数组保持元素顺序；字符串/数字/布尔/null 用标准 JSON 序列化。
 *
 * 由此保证 ToolSchema.parametersJson 跨构造、跨配置（C/D/E）零字节漂移。
 */

const CANONICAL_KEY_ORDER: readonly string[] = [
  "type",
  "description",
  "enum",
  "items",
  "properties",
  "required",
  "additionalProperties",
];

/** 与构造键序无关的规范化序列化（同构输入 → 同一字节串） */
export function toCanonicalJson(value: unknown): string {
  return serializeValue(value);
}

function serializeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((element) => serializeValue(element)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareCanonicalKeys);
    const body = keys
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${serializeValue(record[key])}`)
      .join(",");
    return `{${body}}`;
  }
  throw new Error(`toCanonicalJson: cannot serialize value of type ${typeof value}`);
}

function compareCanonicalKeys(a: string, b: string): number {
  const rankA = CANONICAL_KEY_ORDER.indexOf(a);
  const rankB = CANONICAL_KEY_ORDER.indexOf(b);
  const orderA = rankA >= 0 ? rankA : CANONICAL_KEY_ORDER.length;
  const orderB = rankB >= 0 ? rankB : CANONICAL_KEY_ORDER.length;
  if (orderA !== orderB) {
    return orderA - orderB;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
