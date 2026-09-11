/**
 * 优雅退出：置 exitCode 后等事件循环自然排干再退，而非立刻 process.exit。
 *
 * 为什么：Windows 上立即 process.exit 与仍在飞的线程池操作（响应帧管道写、
 * 审计/会话落盘、undici socket teardown）竞争——满载复现 ~2/54 触发 libuv
 * 断言 fail-fast 0xC0000409（`Assertion failed: !(handle->flags &
 * UV_HANDLE_CLOSING), file src\win\async.c, line 76`），静置 ≥50ms 后
 * 0/36（#29 冒烟现场：kernel-host 裸 wire 测试在满套件并发下退出码
 * 3221226505）。自然排干是因果解：循环空 = 在飞操作全部落定（undici
 * keep-alive socket 为 unref 句柄，不保活）。
 *
 * 协议宿主（kernel-host）需先停读 stdin——传输层读是主要保活句柄，客户端
 * 在等进程退出、进程在等输入抵达会死锁，destroyStdin 承担。兜底强退定时器
 * unref（不自身保活）：泄漏句柄时不无限挂起；8s 上界落在驱动器 close 阶梯
 * （EOF 宽限 6s + SIGTERM 3s）之内，兜底先于阶梯升级点火。
 */

/** 兜底强退上界（毫秒）：自然排干的正常路径毫秒级完成，此定时器不点火 */
const GRACEFUL_EXIT_FALLBACK_MS = 8_000;

export interface GracefulExitOptions {
  /** 自毁 stdin 停读（协议宿主的传输层读保活时必选；一次性命令进程缺省即可） */
  readonly destroyStdin?: boolean;
}

export function exitGracefully(code: number, options: GracefulExitOptions = {}): void {
  process.exitCode = code;
  if (options.destroyStdin === true) {
    process.stdin.destroy();
  }
  setTimeout(() => process.exit(code), GRACEFUL_EXIT_FALLBACK_MS).unref();
}
