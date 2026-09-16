/**
 * #46 网关冒烟自检：reviewer 端点的一次性连通性与能力面诊断。
 *
 * 对目标端点发两个最小探针（先 1 次补全、后 1 次最小工具调用），把
 * failureOf 的稳定 code + 服务端 message 折叠为人话诊断（通过 / 鉴权失败 /
 * 模型不存在 / 不支持 function calling / 画像不匹配 / ……），配处置建议。
 * 票面的「1-token 补全 + 1-tool 调用」按最小探针意图落地：提示词极小化
 * （回复一个词 / 调一次探针工具），但请求体走生产画像序列化
 * （buildChatCompletionsBody，与检视路径同一单源）——冒烟即生产路径的
 * 缩影，不是旁路简化，画像不匹配这类问题在冒烟即可暴露。
 *
 * 实现选择：直接用 DeepSeekLlmAdapter（maxRetries: 0——冒烟要快反馈，
 * 429/5xx 一次即诊断；timeoutMs 收紧到 120s）。凭据/端点解析与生产完全
 * 同路径（REVIEWER_* > DEEPSEEK_* > 官方缺省），CLI 侧先装 .env.local。
 * 诊断只消费 finish error 的 LlmFailure（code 稳定）与本地抛错文本，
 * 不触碰 key（存在性探测单源 hasReviewerApiKey，值绝不回显）。
 */

import {
  createUserMessage,
  type GenerateOptions,
  type LlmFailure,
  type StreamChunk,
  type TokenUsage,
  type ToolSchema,
} from "@deepseek-ai/dsh-llm";

import { hasReviewerApiKey } from "review-llm";

import { DeepSeekLlmAdapter } from "../llm/deepseek-adapter.js";

/** 单探针超时上界（生产 600s 是给六阶段检视循环的；冒烟要快反馈） */
const SMOKE_TIMEOUT_MS = 120_000;

const PROBE_SYSTEM_PROMPT = "You are a gateway connectivity probe. Follow the user's instruction exactly.";
const COMPLETION_PROBE_PROMPT = "Reply with exactly one word: pong";
const TOOL_PROBE_PROMPT = 'Call the review_smoke_ping tool with message "pong". Do not answer in plain text.';

/** 探针工具（名字已是 wire 合法形式，无点号映射） */
const SMOKE_TOOL: ToolSchema = {
  name: "review_smoke_ping",
  description: "Smoke test probe tool: call it with the requested message.",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string", description: "The message to echo back." },
    },
    required: ["message"],
  },
};

/** 人话报告里的 reason 截断上界 */
const REASON_SNIPPET_LENGTH = 200;

export type SmokeProbeName = "completion" | "tool";

/** 诊断分类（票面四支 + 实际网关问题面的实用补充支） */
export type SmokeDiagnosis =
  | "missing-credentials"
  | "auth-failed"
  | "model-not-found"
  | "function-calling-unsupported"
  | "profile-mismatch"
  | "rate-limited"
  | "server-error"
  | "network-error"
  | "malformed-response"
  | "no-tool-call"
  | "invalid-model"
  | "http-error"
  | "unknown";

export type SmokeVerdict =
  | {
      readonly kind: "pass";
      readonly model: string;
      readonly endpointUrl: string;
      readonly completion: { readonly text: string; readonly usage: TokenUsage | undefined };
      readonly tool: { readonly names: readonly string[]; readonly usage: TokenUsage | undefined };
    }
  | {
      readonly kind: "fail";
      readonly diagnosis: SmokeDiagnosis;
      readonly probe: SmokeProbeName;
      readonly reason: string;
      readonly suggestion: string;
    };

export interface GatewaySmokeOptions {
  readonly model: string;
  /** fetch 注入（单元测试零网络） */
  readonly fetchFn?: typeof fetch;
}

const DIAGNOSIS_LABELS: Record<SmokeDiagnosis, string> = {
  "missing-credentials": "凭据缺失",
  "auth-failed": "鉴权失败",
  "model-not-found": "模型不存在",
  "function-calling-unsupported": "不支持 function calling",
  "profile-mismatch": "画像不匹配",
  "rate-limited": "限流",
  "server-error": "网关服务端错误",
  "network-error": "网络不通（含超时）",
  "malformed-response": "响应形状异常",
  "no-tool-call": "模型未调用工具",
  "invalid-model": "非法模型 id",
  "http-error": "网关拒绝",
  "unknown": "未知错误",
};

const SUGGESTIONS: Record<SmokeDiagnosis, string> = {
  "missing-credentials":
    "设置 REVIEWER_API_KEY（或别名 DEEPSEEK_API_KEY）；也可写入仓库根 .env.local（review-agent 与实验 CLI 都会自动装载，已有环境变量优先）",
  "auth-failed": "key 无效或无权访问该模型：核对 REVIEWER_API_KEY / DEEPSEEK_API_KEY 的值与网关侧权限",
  "model-not-found": "模型 id 不被该网关认识：核对 --model 与网关的模型清单（自定义网关的可用模型以其文档为准）",
  "function-calling-unsupported":
    "该模型/网关不支持 tools（function calling）：reviewer 路径需要工具调用，请换支持工具调用的模型",
  "profile-mismatch":
    "请求体的画像字段（thinking / reasoning_effort / max_tokens）被网关拒绝：模型 id 前缀与提供方可能不符（如 glm-* 画像打到了非 glm 网关）——核对模型 id 写法",
  "rate-limited": "限流（429）：稍后重试或检查配额",
  "server-error": "网关侧 5xx：稍后重试；持续失败联系网关方",
  "network-error": "网络不通或超时：核对 REVIEWER_URL 指向的端点与出网代理（自定义网关常见于内网地址）",
  "malformed-response": "响应不是 OpenAI 兼容的 chat/completions 形状：该端点可能不是兼容网关",
  "no-tool-call": "模型 200 返回但未调用工具（回了文本）：工具调用在该模型上不可用或不可靠，不适合作为 reviewer",
  "invalid-model": "模型 id 被本地拒绝（退役 id）：换在役模型 id（deepseek-chat / deepseek-reasoner 已于 2026-07-24 退役）",
  "http-error": "网关返回非预期状态：见上方原因原文",
  "unknown": "未知错误：见上方原因原文",
};

const PROBE_LABELS: Record<SmokeProbeName, string> = {
  completion: "补全",
  tool: "工具调用",
};

/** 服务端 message 里的「模型不存在」文案族（404 之外，400 也常这么回；模型名可插在中间） */
const MODEL_NOT_FOUND_PATTERN =
  /\bmodel\b[^\n]*\bnot\b[^\n]*\b(found|exist|available)\b|no such model|unknown model|invalid model/iu;

/** LlmFailure（稳定 code + 服务端 message）→ 诊断分类 */
function diagnoseFailure(failure: LlmFailure): SmokeDiagnosis {
  switch (failure.code) {
    case "AUTH":
      return "auth-failed";
    case "RATE_LIMIT":
      return "rate-limited";
    case "SERVER":
      return "server-error";
    case "TIMEOUT":
    case "TRANSPORT":
      return "network-error";
    case "MALFORMED_RESPONSE":
      return "malformed-response";
    default:
      break;
  }
  // 模型不存在优先于其余 400 细分（鉴权已在上面的 code 分支拦截）
  if (failure.status === 404 || MODEL_NOT_FOUND_PATTERN.test(failure.message)) {
    return "model-not-found";
  }
  if (failure.status === 400) {
    if (/tool|function/iu.test(failure.message)) {
      return "function-calling-unsupported";
    }
    if (/thinking|reasoning_effort|max_tokens/iu.test(failure.message)) {
      return "profile-mismatch";
    }
  }
  return "http-error";
}

/** 本地抛错（validateRoute 退役 id / 构造期校验）→ 诊断分类 */
function diagnoseThrown(error: Error): SmokeDiagnosis {
  if (/retired/u.test(error.message)) {
    return "invalid-model";
  }
  return "unknown";
}

function failVerdict(diagnosis: SmokeDiagnosis, probe: SmokeProbeName, reason: string): SmokeVerdict {
  return { kind: "fail", diagnosis, probe, reason, suggestion: SUGGESTIONS[diagnosis] };
}

/** reason 截断（人话报告不让服务端长文案淹没诊断） */
function snippet(text: string): string {
  return text.length <= REASON_SNIPPET_LENGTH ? text : `${text.slice(0, REASON_SNIPPET_LENGTH)}…`;
}

function failureToVerdict(failure: LlmFailure, probe: SmokeProbeName): SmokeVerdict {
  const diagnosis = diagnoseFailure(failure);
  return failVerdict(diagnosis, probe, failure.message);
}

function thrownToVerdict(error: Error, probe: SmokeProbeName): SmokeVerdict {
  return failVerdict(diagnoseThrown(error), probe, snippet(error.message));
}

/** 单探针执行：收集 text / 工具名 / usage；错误终态（thrown / error finish）就地折叠为 fail verdict */
interface ProbeRun {
  readonly text: string;
  readonly toolNames: readonly string[];
  readonly usage: TokenUsage | undefined;
}

async function runProbe(
  adapter: DeepSeekLlmAdapter,
  options: GenerateOptions,
  probe: SmokeProbeName,
): Promise<ProbeRun | SmokeVerdict> {
  const textParts: string[] = [];
  const toolNames: string[] = [];
  let usage: TokenUsage | undefined;
  let failure: LlmFailure | undefined;
  try {
    for await (const chunk of adapter.stream(options) as AsyncIterable<StreamChunk>) {
      switch (chunk.type) {
        case "text-delta":
          textParts.push(chunk.text);
          break;
        case "tool-call-delta":
          // 非流式适配器恒带 name；流式形状里 name 只在首片段（此处仅 type 层可选）
          if (chunk.name !== undefined) {
            toolNames.push(chunk.name);
          }
          break;
        case "usage":
          usage = chunk.usage;
          break;
        case "finish":
          if ("failure" in chunk.reason) {
            failure = chunk.reason.failure;
          }
          break;
        default:
          break;
      }
    }
  } catch (error) {
    return thrownToVerdict(error instanceof Error ? error : new Error(String(error)), probe);
  }
  if (failure !== undefined) {
    return failureToVerdict(failure, probe);
  }
  return { text: textParts.join(""), toolNames, usage };
}

export async function runGatewaySmoke(options: GatewaySmokeOptions): Promise<SmokeVerdict> {
  // key 存在性单源探测（不读值）：缺席即人话指引，不发探针
  if (!hasReviewerApiKey()) {
    return failVerdict(
      "missing-credentials",
      "completion",
      "未配置 reviewer key：REVIEWER_API_KEY / DEEPSEEK_API_KEY 均缺席（探针未发出）",
    );
  }

  let adapter: DeepSeekLlmAdapter;
  try {
    adapter = new DeepSeekLlmAdapter({
      timeoutMs: SMOKE_TIMEOUT_MS,
      // 冒烟要快反馈：一次尝试即诊断（429/5xx/网络错不重试）
      maxRetries: 0,
      ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
    });
  } catch (error) {
    return thrownToVerdict(error instanceof Error ? error : new Error(String(error)), "completion");
  }

  const completionOptions: GenerateOptions = {
    provider: "deepseek",
    model: options.model,
    system: PROBE_SYSTEM_PROMPT,
    messages: [
      createUserMessage({ content: [{ type: "text", text: COMPLETION_PROBE_PROMPT }], source: { kind: "user" } }),
    ],
  };
  const toolOptions: GenerateOptions = {
    ...completionOptions,
    messages: [createUserMessage({ content: [{ type: "text", text: TOOL_PROBE_PROMPT }], source: { kind: "user" } })],
    tools: [SMOKE_TOOL],
  };

  // 探针错误就地折叠（"kind" 判别 ProbeRun 与 fail verdict）；补全探针过了才发工具探针
  const completion = await runProbe(adapter, completionOptions, "completion");
  if ("kind" in completion) {
    return completion;
  }
  const tool = await runProbe(adapter, toolOptions, "tool");
  if ("kind" in tool) {
    return tool;
  }
  if (tool.toolNames.length === 0) {
    return failVerdict(
      "no-tool-call",
      "tool",
      `工具探针 200 返回但模型未调用工具（回复文本：${JSON.stringify(snippet(tool.text))}）`,
    );
  }

  return {
    kind: "pass",
    model: options.model,
    endpointUrl: adapter.endpointUrl,
    completion: { text: completion.text, usage: completion.usage },
    tool: { names: tool.toolNames, usage: tool.usage },
  };
}

function usageSuffix(usage: TokenUsage | undefined): string {
  return usage === undefined ? "" : `（输入 ${usage.inputTokens} / 输出 ${usage.outputTokens} tokens）`;
}

/** verdict → 人话报告（stdout 用；含中文诊断、探针、原因与处置建议） */
export function renderSmokeReport(verdict: SmokeVerdict): string {
  if (verdict.kind === "pass") {
    return [
      "review-agent smoke: 通过",
      `  端点:     ${verdict.endpointUrl}`,
      `  模型:     ${verdict.model}`,
      `  补全探针: ok — 回复 ${JSON.stringify(verdict.completion.text)}${usageSuffix(verdict.completion.usage)}`,
      `  工具探针: ok — 调用 ${verdict.tool.names.join(", ")}${usageSuffix(verdict.tool.usage)}`,
      "",
    ].join("\n");
  }
  return [
    `review-agent smoke: 失败 —— ${DIAGNOSIS_LABELS[verdict.diagnosis]}`,
    `  探针: ${PROBE_LABELS[verdict.probe]}`,
    `  原因: ${snippet(verdict.reason)}`,
    `  处置: ${verdict.suggestion}`,
    "",
  ].join("\n");
}
