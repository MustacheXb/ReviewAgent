/**
 * 本地 stub LLM 端点（零网络进程级烟测共用）：127.0.0.1 HTTP 服务器按序回放
 * chat/completions 响应体。消费方：review-dsh 包的进程级测试（CLI 烟测 /
 * kernel-host 测试，经 4 级相对引用）与根的 DSH 内核 e2e——被测代码运行在
 * 独立进程里，进程内 fetch stub 不可达，故必须真端口。
 *
 * 脚本耗尽后若有 fallback 则持续供给（上界截断剧本）；无 fallback 时 500——
 * 成功路径以此兜住「多发了未脚本化的请求」。
 */

import { createServer, type Server } from "node:http";

export interface StubLlmServer {
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
}

export interface StubLlmServerOptions {
  /**
   * 首个响应前的延迟（毫秒）：模拟真实 LLM 延迟（thinking 单 turn 分钟级）
   * 超过被测缺省 turn 超时的场景——驱动「真实 API 级 turn 预算转发」的
   * 回归断言（延迟只加在首响应，控制慢测试成本）。
   */
  readonly firstResponseDelayMs?: number;
}

export function startStubLlmServer(
  responses: string[],
  fallback?: string,
  options: StubLlmServerOptions = {},
): Promise<StubLlmServer> {
  const firstResponseDelayMs = options.firstResponseDelayMs ?? 0;
  let next = 0;
  const server = createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: `unexpected ${request.method} ${request.url}` }));
      return;
    }
    const body = next < responses.length ? responses[next] : fallback;
    const index = next;
    next += 1;
    if (body === undefined) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "script exhausted" }));
      return;
    }
    const send = (): void => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
    };
    if (index === 0 && firstResponseDelayMs > 0) {
      setTimeout(send, firstResponseDelayMs);
      return;
    }
    send();
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("stub server has no port");
      }
      resolvePromise({
        server,
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}
