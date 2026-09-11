/**
 * #28 零网络强制自检：出站尝试必须被门拦截（AC2 的运行时证据）。
 *
 * 纪律门断言套件在断网环境下必须全绿——「断网」不是口头约定，而是
 * no-network-setup 的出站拦截（Socket#connect / fetch 双收口）。本自检
 * 主动尝试三类出站路径，断言全部以拦截错误失败：若未来任何入选测试意外
 * 依赖网络，同样会以本文件锁定的错误形态变红，而不是静默放行。
 */

import http from "node:http";
import net from "node:net";
import { expect, it } from "vitest";

const FORBIDDEN = /discipline-gate: network access is forbidden/;

it("net 直连：Socket#connect 收口同步抛拦截错误", () => {
  expect(() => net.connect({ host: "127.0.0.1", port: 1 })).toThrow(FORBIDDEN);
});

it("fetch：全局收口以拦截错误拒绝", async () => {
  await expect(fetch("http://127.0.0.1:1/")).rejects.toThrow(FORBIDDEN);
});

it("http.request：请求以拦截错误收场（同步抛或 error 事件）", async () => {
  // IP 字面量在 Node 24 上于 http.request 调用内同步建连（拦截错误直接
  // 同步冒出）；延迟建连的形态则走 error 事件——两种表现都算拦截成功
  const failure = new Promise<Error>((resolveFailure) => {
    let request: http.ClientRequest;
    try {
      request = http.request("http://127.0.0.1:1/");
    } catch (error) {
      resolveFailure(error as Error);
      return;
    }
    request.on("error", (error: Error) => {
      resolveFailure(error);
    });
    request.end();
  });
  const error = await failure;
  expect(error.message).toMatch(FORBIDDEN);
});
