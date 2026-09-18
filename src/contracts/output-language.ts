/**
 * 输出语言契约（spec #49 / ADR-0010，ticket #53）：产品配置，与 A–E 实验
 * 矩阵正交——不参与 configId 推导（同 configId 可任选语言），manifest 按
 * 语言分口径、指标不跨语言混比。
 *
 * Zone A 仅 Output language 节按语言渲染（每语言一条冻结字节序列）；
 * Evidence Gate 语言门按语言对称参数化（#55）。只切换 Finding 的自然语言
 * 字段（title / description / evidence 连接文本）；代码摘录、文件路径、
 * 标识符、枚举值与字段名不随语言变化。
 */
export type OutputLanguage = "en" | "zh";

/**
 * 成员判定（类型守卫，#58）：CLI 旗标 / JSON-RPC 参数 / 实验计划 / 内核
 * 回传四类入口的枚举校验单源——各入口的错误消息自带语境前缀（--language /
 * review/run / plan.outputLanguage / dsh-kernel），枚举面只在此定义一次。
 */
export function isOutputLanguage(value: unknown): value is OutputLanguage {
  return value === "en" || value === "zh";
}

/**
 * 语言值解析：缺席归一 en（旧记录 / 旧结果的锚定语义）；非法值 fail fast
 * （人话错误——配置错误在启动期暴露，不产出语言错乱的结果，spec #49
 * 用户故事 9）。Zone A 渲染与运行记录写入共用本解析。
 */
export function resolveOutputLanguage(value: unknown): OutputLanguage {
  if (value === undefined) {
    return "en";
  }
  if (!isOutputLanguage(value)) {
    throw new Error(`outputLanguage must be "en" or "zh" (got ${JSON.stringify(value)})`);
  }
  return value;
}
