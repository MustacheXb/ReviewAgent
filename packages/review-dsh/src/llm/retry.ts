/**
 * 有界重试循环（1:1 移植自冻结薄 harness 的 src/shared/openai-http-kernel.ts
 * runWithRetries/backoffDelayMs；DeepSeek 适配器内部消费）。
 *
 * 内核侧（npm 0.1.2-rc.1）的 providerRetryPolicy 仅供可选的 dsh-llm-retry
 * 插件在 agent failed-step 扩展点执行——本 profile 不挂载该插件，重试语义
 * 按 POC1 原样保留在适配器内部，无双重重试。
 */

/** 有界重试循环（总尝试 = 1 + maxRetries）；onError 在每次失败后、重试决策前回调 */
export async function runWithRetries<T>(options: {
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
  readonly sleepFn: (ms: number) => Promise<void>;
  readonly isRetryable: (error: unknown) => boolean;
  readonly onError?: (error: unknown) => void;
  readonly operation: () => Promise<T>;
}): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await options.operation();
    } catch (error) {
      options.onError?.(error);
      if (attempt >= options.maxRetries || !options.isRetryable(error)) {
        throw error;
      }
      await options.sleepFn(backoffDelayMs(options.retryBaseDelayMs, attempt));
      attempt++;
    }
  }
}

/** 指数退避：第 n 次重试等待 base * 2^n */
export function backoffDelayMs(base: number, attempt: number): number {
  return base * 2 ** attempt;
}

/** 缺省 sleep 注入（生产路径；测试注入零等待替身） */
export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
