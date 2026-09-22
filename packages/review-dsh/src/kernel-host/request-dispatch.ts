/**
 * #61 Q9：服务端请求分发的 host 接管（SDK transport 无自定义错误帧路径）。
 *
 * 事实（已核验 @deepseek-ai/dsh-sdk-protocol 全部已发布版本 0.1.2-rc.1 →
 * 0.1.6-alpha.2）：onRequest 的 handler 拿不到请求 id（客户端 id 形如
 * req_<uuid> 不可推测），handler throw 恒映射 -32603，writeError 只写
 * {code, message} 无 data 参数——计划类拒绝（超限）的专用错误帧
 * （-32000 + error.data）无法经公开面产生。
 *
 * 本模块在 transport 实例上替换 handleIncomingRequest 为 host 自家分发：
 * - 正常返回 → result 帧（复刻 SDK 原逻辑；字节等价——JSON.stringify + \n）
 * - 一般 throw → -32603 帧（message 提取同款）
 * - ShardLimitRejection → -32000 + error.data 帧（本模块存在的唯一理由）
 *
 * 私有 API 依赖收敛到 1 个方法名（handleIncomingRequest 的名字与签名
 * (id, method, params)，已核验全版本稳定）；组帧 / 行解析 / 响应匹配 / notify
 * 仍归 SDK（#27「wire 层 100% SDK 件」字面破一角、精神保真——见 #61 Q9 注记）。
 * 裸 wire 测试（#61 AC2）锁帧形状——SDK 升级破坏此接管会响亮失败，非静默漂移。
 */

import type { Writable } from "node:stream";

import type { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";

/** #61 Q1/Q9：分片数超限拒绝的专用错误码（-32000..-32099 = JSON-RPC 实现定义服务端错误区） */
export const SHARD_LIMIT_ERROR_CODE = -32000;

/** 分片数超限拒绝（计划类）：上抛经分发层映射为 -32000 + error.data 帧——CLI 退出码 2 的 RPC 对应物 */
export class ShardLimitRejection extends Error {
  /** 结构化拒绝参数（error.data）：rejectReason / requiredShards / shardLimit */
  readonly data: Readonly<Record<string, number | string>>;

  constructor(message: string, data: Readonly<Record<string, number | string>>) {
    super(message);
    this.name = "ShardLimitRejection";
    this.data = data;
  }
}

/** host 侧方法分发（与 transport.onRequest 的 handler 同形） */
export type HostMethodHandler = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

/**
 * 接管 transport 的服务端请求分发（install 后不再使用 onRequest——requestHandler
 * 路径成为死代码，本替换是请求帧的唯一入口）。
 */
export function installHostRequestDispatch(
  transport: JsonRpcLineTransport,
  output: Writable,
  handle: HostMethodHandler,
): void {
  const internals = transport as unknown as {
    handleIncomingRequest: (
      id: string | number,
      method: string,
      params: Record<string, unknown>,
    ) => Promise<void>;
  };
  internals.handleIncomingRequest = async (id, method, params) => {
    try {
      writeFrame(output, { jsonrpc: "2.0", id, result: await handle(method, params) });
    } catch (error) {
      if (error instanceof ShardLimitRejection) {
        writeFrame(output, {
          jsonrpc: "2.0",
          id,
          error: { code: SHARD_LIMIT_ERROR_CODE, message: error.message, data: error.data },
        });
        return;
      }
      writeFrame(output, {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      });
    }
  };
}

/** 帧写出（与 transport.write 字节等价：JSON.stringify + 换行单次 write——同流顺序写不交错） */
function writeFrame(output: Writable, frame: unknown): void {
  output.write(`${JSON.stringify(frame)}\n`);
}
