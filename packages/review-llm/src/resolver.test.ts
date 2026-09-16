import { describe, expect, it } from "vitest";

import { nonNegativeIntOption, positiveIntOption, resolveApiKey, resolveEndpointUrl } from "./resolver.js";

/** 注入的错误工厂打标记：验证抛出的确是调用方工厂的产物（而非内部 new Error） */
const clientError = (message: string): Error => {
  const error = new Error(message);
  (error as Error & { factory: string }).factory = "client";
  return error;
};

const thrownBy = (run: () => unknown): Error => {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected run() to throw");
};

describe("resolveApiKey", () => {
  it("显式非空 key 优先于环境变量，trim 后返回", () => {
    expect(
      resolveApiKey({
        explicit: "  sk-explicit  ",
        envVarNames: ["DEEPSEEK_API_KEY"],
        serviceLabel: "DeepSeek API",
        clientError,
        env: { DEEPSEEK_API_KEY: "sk-env" },
      }),
    ).toBe("sk-explicit");
  });

  it("显式为空串或纯空白时回落到环境变量（trim 后返回）", () => {
    expect(
      resolveApiKey({
        explicit: "",
        envVarNames: ["DEEPSEEK_API_KEY"],
        serviceLabel: "DeepSeek API",
        clientError,
        env: { DEEPSEEK_API_KEY: "  sk-env  " },
      }),
    ).toBe("sk-env");
    expect(
      resolveApiKey({
        explicit: "   ",
        envVarNames: ["DEEPSEEK_API_KEY"],
        serviceLabel: "DeepSeek API",
        clientError,
        env: { DEEPSEEK_API_KEY: "sk-env" },
      }),
    ).toBe("sk-env");
  });

  it("环境变量按序探测，跳过未设/空白项，首个非空者胜出", () => {
    expect(
      resolveApiKey({
        envVarNames: ["REVIEWER_API_KEY", "DEEPSEEK_API_KEY"],
        serviceLabel: "DeepSeek API",
        clientError,
        env: { REVIEWER_API_KEY: "  ", DEEPSEEK_API_KEY: "sk-legacy" },
      }),
    ).toBe("sk-legacy");
    expect(
      resolveApiKey({
        envVarNames: ["REVIEWER_API_KEY", "DEEPSEEK_API_KEY"],
        serviceLabel: "DeepSeek API",
        clientError,
        env: { REVIEWER_API_KEY: "sk-role" },
      }),
    ).toBe("sk-role");
  });

  it("缺失时抛注入工厂的错误，消息逐字节锚定单名形态", () => {
    const error = thrownBy(() =>
      resolveApiKey({
        envVarNames: ["DEEPSEEK_API_KEY"],
        serviceLabel: "DeepSeek API",
        clientError,
        env: { DEEPSEEK_API_KEY: "   " },
      }),
    );
    expect((error as Error & { factory: string }).factory).toBe("client");
    expect(error.message).toBe(
      "DeepSeek API key is missing: set the DEEPSEEK_API_KEY environment variable or pass the apiKey option. The key is only read from the environment/options and is never logged or persisted.",
    );
  });

  it("缺失且多别名时消息改述 set one of the A, B environment variables", () => {
    const error = thrownBy(() =>
      resolveApiKey({
        envVarNames: ["REVIEWER_API_KEY", "DEEPSEEK_API_KEY"],
        serviceLabel: "DeepSeek API",
        clientError,
        env: {},
      }),
    );
    expect(error.message).toBe(
      "DeepSeek API key is missing: set one of the REVIEWER_API_KEY, DEEPSEEK_API_KEY environment variables or pass the apiKey option. The key is only read from the environment/options and is never logged or persisted.",
    );
  });

  it("未注入 env 时读 process.env", () => {
    const name = "REVIEW_LLM_TEST_API_KEY";
    const previous = process.env[name];
    process.env[name] = "sk-process-env";
    try {
      expect(
        resolveApiKey({
          envVarNames: [name],
          serviceLabel: "DeepSeek API",
          clientError,
        }),
      ).toBe("sk-process-env");
    } finally {
      if (previous === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous;
      }
    }
  });
});

describe("resolveEndpointUrl", () => {
  it("显式 baseUrl 优先（trim + 去尾斜杠 + 拼 /chat/completions，保留路径）", () => {
    expect(
      resolveEndpointUrl({
        baseUrl: "  https://api.example.com/v1/  ",
        defaultBaseUrl: "https://api.deepseek.com",
        envVarNames: ["DEEPSEEK_URL"],
        clientError,
        env: { DEEPSEEK_URL: "https://env.example.com" },
      }),
    ).toBe("https://api.example.com/v1/chat/completions");
  });

  it("http:// 亦合法；多尾斜杠一并剥除", () => {
    expect(
      resolveEndpointUrl({
        baseUrl: "http://localhost:8000///",
        defaultBaseUrl: "https://api.deepseek.com",
        clientError,
      }),
    ).toBe("http://localhost:8000/chat/completions");
  });

  it("显式为空串/空白时回落环境变量（按序探测，胜出名进错误来源）", () => {
    expect(
      resolveEndpointUrl({
        baseUrl: "   ",
        defaultBaseUrl: "https://api.deepseek.com",
        envVarNames: ["REVIEWER_API_BASE_URL", "DEEPSEEK_URL"],
        clientError,
        env: { DEEPSEEK_URL: "https://legacy.example.com/" },
      }),
    ).toBe("https://legacy.example.com/chat/completions");
    const error = thrownBy(() =>
      resolveEndpointUrl({
        defaultBaseUrl: "https://api.deepseek.com",
        envVarNames: ["REVIEWER_API_BASE_URL", "DEEPSEEK_URL"],
        clientError,
        env: { REVIEWER_API_BASE_URL: "ftp://bad.example.com" },
      }),
    );
    expect(error.message).toBe(
      'baseUrl must start with http:// or https:// (from REVIEWER_API_BASE_URL environment variable: "ftp://bad.example.com")',
    );
  });

  it("缺省兜底：base + /chat/completions；未给 envVarNames 则完全不读环境变量", () => {
    expect(
      resolveEndpointUrl({
        defaultBaseUrl: "https://api.deepseek.com",
        clientError,
        env: { DEEPSEEK_URL: "https://should-not-be-read.example.com" },
      }),
    ).toBe("https://api.deepseek.com/chat/completions");
  });

  it("协议非法时抛注入工厂的错误，来源三态锚定（option/env/default）", () => {
    const optionError = thrownBy(() =>
      resolveEndpointUrl({
        baseUrl: "ftp://option.example.com",
        defaultBaseUrl: "https://api.deepseek.com",
        clientError,
      }),
    );
    expect((optionError as Error & { factory: string }).factory).toBe("client");
    expect(optionError.message).toBe(
      'baseUrl must start with http:// or https:// (from baseUrl option: "ftp://option.example.com")',
    );

    const envError = thrownBy(() =>
      resolveEndpointUrl({
        defaultBaseUrl: "https://api.deepseek.com",
        envVarNames: ["DEEPSEEK_URL"],
        clientError,
        env: { DEEPSEEK_URL: "  ftp://env.example.com  " },
      }),
    );
    expect(envError.message).toBe(
      'baseUrl must start with http:// or https:// (from DEEPSEEK_URL environment variable: "ftp://env.example.com")',
    );

    const defaultError = thrownBy(() =>
      resolveEndpointUrl({
        defaultBaseUrl: "example.com",
        clientError,
      }),
    );
    expect(defaultError.message).toBe(
      'baseUrl must start with http:// or https:// (from default: "example.com")',
    );
  });
});

describe("positiveIntOption", () => {
  it("undefined 取 fallback；合法正整数原样返回", () => {
    expect(positiveIntOption(undefined, 600_000, "timeoutMs", clientError)).toBe(600_000);
    expect(positiveIntOption(30, 600_000, "timeoutMs", clientError)).toBe(30);
  });

  it("0/负数/非整数抛注入工厂的错误，消息逐字节锚定", () => {
    expect(thrownBy(() => positiveIntOption(0, 600_000, "timeoutMs", clientError)).message).toBe(
      'timeoutMs must be a positive integer (got 0)',
    );
    expect(thrownBy(() => positiveIntOption(-1, 600_000, "timeoutMs", clientError)).message).toBe(
      'timeoutMs must be a positive integer (got -1)',
    );
    expect(thrownBy(() => positiveIntOption(1.5, 600_000, "timeoutMs", clientError)).message).toBe(
      'timeoutMs must be a positive integer (got 1.5)',
    );
  });
});

describe("nonNegativeIntOption", () => {
  it("undefined 取 fallback；0 合法", () => {
    expect(nonNegativeIntOption(undefined, 3, "maxRetries", clientError)).toBe(3);
    expect(nonNegativeIntOption(0, 3, "maxRetries", clientError)).toBe(0);
  });

  it("负数/非整数抛注入工厂的错误，消息逐字节锚定", () => {
    expect(thrownBy(() => nonNegativeIntOption(-1, 3, "maxRetries", clientError)).message).toBe(
      "maxRetries must be a non-negative integer (got -1)",
    );
    expect(thrownBy(() => nonNegativeIntOption(2.5, 3, "maxRetries", clientError)).message).toBe(
      "maxRetries must be a non-negative integer (got 2.5)",
    );
  });
});
