/**
 * DeepSeek 客户端测试替身：注入式 fetch stub（零真实网络）+ 线上响应构造器。
 */

export interface RecordedFetchRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export type StubHandler = (
  request: RecordedFetchRequest,
  index: number,
) => Response | Promise<Response>;

export interface FetchStub {
  readonly fetch: typeof fetch;
  readonly requests: readonly RecordedFetchRequest[];
}

type FetchInput = Parameters<typeof fetch>[0];

/** 可编程 fetch stub：按调用序号返回脚本化 Response；抛错即模拟网络失败 */
export function createFetchStub(handler: StubHandler): FetchStub {
  const requests: RecordedFetchRequest[] = [];
  const stub = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const request: RecordedFetchRequest = {
      url: typeof input === "string" ? input : String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : "",
    };
    requests.push(request);
    return handler(request, requests.length - 1);
  };
  return { fetch: stub, requests };
}

/** 记录退避延时的 sleep stub（零等待） */
export function createSleepRecorder(): {
  readonly sleep: (ms: number) => Promise<void>;
  readonly delays: readonly number[];
} {
  const delays: number[] = [];
  return {
    sleep: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
    delays,
  };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function textResponse(status: number, text: string): Response {
  return new Response(text, { status });
}

export interface WireUsageFields {
  readonly prompt_tokens?: number;
  readonly prompt_cache_hit_tokens?: number;
  readonly prompt_cache_miss_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
}

/** 构造一条 DeepSeek Chat Completions 成功响应（线上形状） */
export function wireChatCompletion(args: {
  readonly content?: string | undefined;
  readonly toolCalls?: readonly unknown[] | undefined;
  readonly finishReason?: string | undefined;
  readonly usage?: WireUsageFields | undefined;
}): unknown {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    model: "deepseek-v4-flash",
    system_fingerprint: "fp-test",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: args.content ?? "",
          ...(args.toolCalls !== undefined ? { tool_calls: args.toolCalls } : {}),
        },
        finish_reason: args.finishReason ?? "stop",
      },
    ],
    usage: args.usage ?? {},
  };
}

/** 构造一条 DeepSeek 错误响应体（OpenAI 风格 {"error":{...}}） */
export function httpErrorBody(message: string, code?: string): unknown {
  return { error: { message, ...(code !== undefined ? { code } : {}) } };
}
