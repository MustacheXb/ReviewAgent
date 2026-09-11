/**
 * #28 零网络强制（纪律门 setup）：出站连接在测试进程内被拦截。
 *
 * 两个收口点覆盖 node 生态的全部出站路径：
 * - `Socket#connect`——net.connect / createConnection / http(s).request（默认
 *   Agent）/ undici（global fetch）最终都经此方法建立 TCP；
 * - `globalThis.fetch`——独立收口，给出比 socket 层更直白的错误。
 *
 * 拦截是「断网模拟」也是「断言放大器」：任何入选测试若意外依赖网络，
 * 会以 net-guard.test.ts 锁定的错误形态当场变红，而非静默放行。
 * 不放行 loopback——门内断言全部 fake LLM（进程内替身），连 127.0.0.1
 * stub（产品面烟测的既定零网络形态）都不需要。
 */

import net from "node:net";

const FORBIDDEN = "discipline-gate: network access is forbidden (zero-network gate)";

const socketPrototype = net.Socket.prototype as unknown as Record<string, unknown>;
socketPrototype.connect = function blockedConnect(): net.Socket {
  throw new Error(`${FORBIDDEN} — outbound socket connect`);
};

globalThis.fetch = (): Promise<never> => {
  return Promise.reject(new Error(`${FORBIDDEN} — fetch`));
};
