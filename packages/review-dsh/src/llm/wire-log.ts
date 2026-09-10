/**
 * wire 请求字节捕获（POC1「可重放字节」契约的持有方）。
 *
 * 只有持有序列化的一方才知道最终请求字节——适配器在 JSON.stringify 处记录
 * 原文，一次逻辑调用一条（重试复用同一字节，不重复记账）。经 profile 组装
 * 挂到 review-cache 服务，随审计 requests 一同落盘。
 */

/** 一次模型调用的 wire 请求捕获 */
export interface CapturedWireRequest {
  /** JSON.stringify 原文（= 发往 provider 的请求体字节，可原样重放） */
  readonly text: string;
}

/** wire 请求日志：适配器在序列化点写入，审计源按调用序读取 */
export class WireRequestLog {
  private readonly entries: CapturedWireRequest[] = [];

  /** 序列化点记录（每逻辑调用一次；重试不重复记账） */
  record(text: string): void {
    this.entries.push({ text });
  }

  /** 按调用序的捕获快照（每次读取返回新数组） */
  get requests(): readonly CapturedWireRequest[] {
    return [...this.entries];
  }
}
