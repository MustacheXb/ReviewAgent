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

export function startStubLlmServer(responses: string[], fallback?: string): Promise<StubLlmServer> {
  let next = 0;
  const server = createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: `unexpected ${request.method} ${request.url}` }));
      return;
    }
    const body = next < responses.length ? responses[next] : fallback;
    next += 1;
    if (body === undefined) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "script exhausted" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
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
