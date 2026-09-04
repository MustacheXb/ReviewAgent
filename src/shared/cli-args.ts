/**
 * CLI 参数解析共享骨架（experiment / reference 双 CLI 去重）。
 *
 * 表驱动：布尔 flag 表 + 值参数表 + 收尾装配；取值形式统一支持
 * --flag value 与 --flag=value；跨 CLI 错误消息语义一致（--help requested /
 * flag requires a value / unknown flag + usage 附文）。
 *
 * 各 CLI 只声明：缺省值、两张 flag 表、收尾校验与只读装配。
 */

/** 解析结果：ok=true 给出装配完成的只读 options；ok=false 给出错误消息与 usage */
export type CliParseResult<T> =
  | { readonly ok: true; readonly options: T }
  | { readonly ok: false; readonly message: string; readonly usage: string };

/** 单个 flag 的应用结果：ok=true 给出待合并的值补丁，ok=false 给出错误消息 */
export type FlagApplyResult<T> =
  | { readonly ok: true; readonly patch: Partial<T> }
  | { readonly ok: false; readonly message: string };

/** 值参数解析器：(取值, 当前累加值) → 补丁 | 错误 */
export type ValueFlagParser<T> = (value: string, current: T) => FlagApplyResult<T>;

/** CLI 解析声明（缺省值 / flag 表 / 收尾装配）。V = 解析期可变值类型，O = 收尾后的只读 options 类型（V → O 的必填校验与类型收窄发生在 finalize） */
export interface CliArgSpec<V, O> {
  readonly usage: string;
  /** 解析起点：全部字段取缺省值 */
  readonly defaultValues: () => V;
  /** 布尔 flag 表：命中即合并补丁（内联 =value 忽略不校验，与历史行为一致） */
  readonly booleanFlags: Readonly<Record<string, Partial<V>>>;
  /** 值参数表：参数名 → 解析器 */
  readonly valueFlags: Readonly<Record<string, ValueFlagParser<V>>>;
  /** 收尾：必填校验 + 占位补全 + 只读 options 装配（undefined 键省略） */
  readonly finalize: (
    values: V,
    fail: (message: string) => CliParseResult<O>,
  ) => CliParseResult<O>;
}

export function parseCliArgs<V, O>(argv: readonly string[], spec: CliArgSpec<V, O>): CliParseResult<O> {
  const fail = (message: string): CliParseResult<O> => ({ ok: false, message, usage: spec.usage });
  let values = spec.defaultValues();
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined) {
      break;
    }
    if (token === "--help" || token === "-h") {
      return fail("--help requested");
    }
    const [name, inlineValue] = splitFlag(token);
    const booleanPatch = spec.booleanFlags[name];
    if (booleanPatch !== undefined) {
      values = { ...values, ...booleanPatch };
      index += 1;
      continue;
    }
    const parser = spec.valueFlags[name];
    if (parser === undefined) {
      return fail(`unknown flag ${JSON.stringify(token)}\n${spec.usage}`);
    }
    const fetched = nextValue(argv, index, name, inlineValue);
    if (!fetched.ok) {
      return fail(fetched.message);
    }
    const applied = parser(fetched.value, values);
    if (!applied.ok) {
      return fail(applied.message);
    }
    values = { ...values, ...applied.patch };
    index = fetched.nextIndex;
  }
  return spec.finalize(values, fail);
}

export function flagOk<T>(patch: Partial<T>): FlagApplyResult<T> {
  return { ok: true, patch };
}

export function flagFail<T>(message: string): FlagApplyResult<T> {
  return { ok: false, message };
}

/** 取 flag 的值：内联 --flag=value 原样返回；空格形式消费下一个 token（不得是 flag 或结尾） */
export function nextValue(
  argv: readonly string[],
  index: number,
  name: string,
  inlineValue: string | undefined,
):
  | { readonly ok: true; readonly value: string; readonly nextIndex: number }
  | { readonly ok: false; readonly message: string } {
  if (inlineValue !== undefined) {
    return { ok: true, value: inlineValue, nextIndex: index + 1 };
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    return { ok: false, message: `flag ${name} requires a value` };
  }
  return { ok: true, value, nextIndex: index + 2 };
}

/** 拆 --flag=value：返回 [参数名, 内联值]（无 = 或非 -- 前缀时内联值为 undefined） */
export function splitFlag(token: string): readonly [string, string | undefined] {
  const eq = token.indexOf("=");
  if (token.startsWith("--") && eq > 0) {
    return [token.slice(0, eq), token.slice(eq + 1)];
  }
  return [token, undefined];
}

/** 逗号列表校验：空列表 / 未知项 / 重复项逐一报错（消息含允许清单） */
export function parseList<T extends string>(
  value: string,
  universe: readonly T[],
  kind: string,
): { readonly ok: true; readonly value: T[] } | { readonly ok: false; readonly message: string } {
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (items.length === 0) {
    return { ok: false, message: `expected a comma list of ${kind} names (got ${JSON.stringify(value)})` };
  }
  const known = new Set<string>(universe);
  const unknown = items.filter((item) => !known.has(item));
  if (unknown.length > 0) {
    return {
      ok: false,
      message: `unknown ${kind} name(s): ${unknown.join(", ")} (allowed: ${universe.join(", ")})`,
    };
  }
  if (new Set(items).size !== items.length) {
    return { ok: false, message: `${kind} list must not contain duplicates (got ${JSON.stringify(value)})` };
  }
  return { ok: true, value: items as T[] };
}

/** 逗号列表参数 → 补丁（parseList 的错误消息原样透传） */
export function applyListFlag<T, L extends string>(
  value: string,
  universe: readonly L[],
  kind: string,
  assign: (list: L[]) => Partial<T>,
): FlagApplyResult<T> {
  const parsed = parseList(value, universe, kind);
  return parsed.ok ? flagOk(assign(parsed.value)) : flagFail(parsed.message);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
