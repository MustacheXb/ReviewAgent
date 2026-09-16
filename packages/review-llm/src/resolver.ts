/**
 * endpoint/key 解析纯函数（root POC1 与 packages/review-dsh 的单源收敛，#41）。
 *
 * 纪律：key 绝不出现在错误信息中；env 可注入（测试隔离），缺省读 process.env。
 * envVarNames 按序探测（首个非空胜出）——单名调用与旧实现逐字节等价，
 * 多名为 #42/#43 的角色别名预留缝。
 */

/** 环境变量只读视图（process.env 或测试注入的替身） */
export type EnvLookup = Readonly<Record<string, string | undefined>>;

export interface ResolveApiKeyInput {
  /** 显式传入的 key（trim 后非空则优先；undefined = 未设） */
  readonly explicit?: string | undefined;
  /** 按序探测的环境变量名，首个非空（trim 后）胜出 */
  readonly envVarNames: readonly string[];
  readonly serviceLabel: string;
  /** 错误工厂（各客户端注入自己的 ClientError 类型） */
  readonly clientError: (message: string) => Error;
  readonly env?: EnvLookup | undefined;
}

/** key 解析：显式参数（trim 后非空）优先，其次按序探测环境变量；缺失 fail fast（消息不回显 key 值） */
export function resolveApiKey(input: ResolveApiKeyInput): string {
  const fromOptions = input.explicit?.trim();
  if (fromOptions !== undefined && fromOptions.length > 0) {
    return fromOptions;
  }
  const env = input.env ?? process.env;
  for (const envVarName of input.envVarNames) {
    const fromEnv = env[envVarName]?.trim();
    if (fromEnv !== undefined && fromEnv.length > 0) {
      return fromEnv;
    }
  }
  throw input.clientError(
    `${input.serviceLabel} key is missing: ${envVarNamesHint(input.envVarNames)} or pass the apiKey option. ` +
      "The key is only read from the environment/options and is never logged or persisted.",
  );
}

/** 单名：set the X environment variable；多别名：set one of the A, B environment variables */
function envVarNamesHint(envVarNames: readonly string[]): string {
  const [firstName] = envVarNames;
  return firstName !== undefined && envVarNames.length === 1
    ? `set the ${firstName} environment variable`
    : `set one of the ${envVarNames.join(", ")} environment variables`;
}

const CHAT_COMPLETIONS_PATH = "/chat/completions";

export interface ResolveEndpointUrlInput {
  /** 显式传入的 base URL（trim 后非空则优先；undefined = 未设） */
  readonly baseUrl?: string | undefined;
  /** 兜底 base URL（provider 画像常量） */
  readonly defaultBaseUrl: string;
  /** 按序探测的环境变量名；缺省/为空则不读环境变量，直接走兜底 */
  readonly envVarNames?: readonly string[] | undefined;
  readonly clientError: (message: string) => Error;
  readonly env?: EnvLookup | undefined;
}

/** 端点解析：base URL + /chat/completions；优先级镜像 resolveApiKey（显式非空选项 > 环境变量非空 > 缺省），协议校验（http/https）并注明取值来源 */
export function resolveEndpointUrl(input: ResolveEndpointUrlInput): string {
  const fromOptions = input.baseUrl?.trim();
  if (fromOptions !== undefined && fromOptions.length > 0) {
    return endpointOf(fromOptions, "baseUrl option", input.clientError);
  }
  const env = input.env ?? process.env;
  for (const envVarName of input.envVarNames ?? []) {
    const fromEnv = env[envVarName]?.trim();
    if (fromEnv !== undefined && fromEnv.length > 0) {
      return endpointOf(fromEnv, `${envVarName} environment variable`, input.clientError);
    }
  }
  return endpointOf(input.defaultBaseUrl, "default", input.clientError);
}

function endpointOf(base: string, source: string, clientError: (message: string) => Error): string {
  const trimmed = base.trim();
  if (!/^https?:\/\//.test(trimmed)) {
    throw clientError(`baseUrl must start with http:// or https:// (from ${source}: ${JSON.stringify(trimmed)})`);
  }
  return `${trimmed.replace(/\/+$/, "")}${CHAT_COMPLETIONS_PATH}`;
}

/** 数值选项校验：undefined 取 fallback；非正整数 fail fast（JSON.stringify 序列化收到的原值） */
export function positiveIntOption(
  value: number | undefined,
  fallback: number,
  name: string,
  clientError: (message: string) => Error,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw clientError(`${name} must be a positive integer (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** 同 positiveIntOption，但 0 合法 */
export function nonNegativeIntOption(
  value: number | undefined,
  fallback: number,
  name: string,
  clientError: (message: string) => Error,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw clientError(`${name} must be a non-negative integer (got ${JSON.stringify(value)})`);
  }
  return value;
}
