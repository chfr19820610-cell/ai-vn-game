/**
 * LLMClient.js — DeepSeek API Client + SSE Streaming
 * ===================================================
 *
 * 封装 DeepSeek Chat Completions API 调用，支持:
 *   1. 流式 SSE 响应
 *   2. 超时与重试
 *   3. 跨平台 ReadableStream 兼容 (Web / Node.js)
 *
 * 设计依据（DISTILLATION.md 第 31-32 行）:
 *   "LLM自回归放大+Lost-in-the-Middle效应 → 必须多层 Guardrail"
 *   本模块提供底层 API 管道，Guardrail.js 在其上构建三层护栏。
 */

// =============================================================================
// 配置
// =============================================================================

const CONFIG = {
  baseURL:      process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
  apiKey:       process.env.DEEPSEEK_API_KEY  || "",
  model:        process.env.DEEPSEEK_MODEL    || "deepseek-chat",
  timeoutMs:    3000,
  maxRetries:   1,
  cacheMaxSize: 200,
  cacheTTLMs:   5 * 60 * 1000,  // 5 分钟

  // ═══ v3: 多Provider自动降级 (路线图1.3 + D5) ═══
  fallbacks: [
    {
      name: "zhipu-free",
      baseURL: "https://open.bigmodel.cn/api/paas/v4",
      apiKey: process.env.GLM_API_KEY || "",
      model: "glm-4-flash",
    },
    {
      name: "deepseek-fallback",
      baseURL: "https://api.deepseek.com/v1",
      apiKey: process.env.DEEPSEEK_API_KEY || "",
      model: "deepseek-chat",
    }
  ],
};

// =============================================================================
// 1. apiCall — 原始 API 调用
// =============================================================================

/**
 * 调用 DeepSeek Chat Completions API（流式）。
 * 返回 ReadableStream&lt;Uint8Array&gt;，调用方用 parseSSEStream 解析。
 *
 * @param {Array<{role:string, content:string}>} messages
 * @param {Object}                      [opts]
 * @param {AbortSignal}                 [opts.signal]      - 用于取消请求
 * @param {string}                      [opts.model]        - 模型名
 * @param {number}                      [opts.temperature]  - 温度 (0-2)
 * @param {number}                      [opts.maxTokens]    - 最大 token 数
 * @returns {Promise<ReadableStream>} SSE 原始字节流
 */
async function apiCall(messages, { signal, model, temperature, maxTokens } = {}) {
  const url = `${CONFIG.baseURL}/v1/chat/completions`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${CONFIG.apiKey}`,
    },
    body: JSON.stringify({
      model:       model || CONFIG.model,
      messages,
      temperature: temperature ?? 0.8,
      max_tokens:  maxTokens ?? 1024,
      stream:      true,
    }),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`DeepSeek API ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.body;  // ReadableStream<Uint8Array>
}

// =============================================================================
// 2. apiCallWithTimeout — 带超时与重试
// =============================================================================

/**
 * 带超时与重试的 API 调用。
 * 超时或 5xx 错误时重试一次，仍失败则抛出异常。
 *
 * @param {Array<{role:string, content:string}>} messages
 * @param {Object}   [opts]
 * @param {number}   [opts.timeoutMs] - 超时毫秒 (默认 CONFIG.timeoutMs)
 * @param {string}   [opts.model]     - 透传给 apiCall
 * @param {number}   [opts.temperature]
 * @param {number}   [opts.maxTokens]
 * @returns {Promise<ReadableStream>}
 */
async function apiCallWithTimeout(messages, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? CONFIG.timeoutMs;

  for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const stream = await apiCall(messages, {
        ...opts,
        signal: controller.signal,
      });
      clearTimeout(timer);
      return stream;
    } catch (err) {
      clearTimeout(timer);

      const isTimeout =
        err.name === "AbortError" || controller.signal.aborted;

      // 仅超时或 5xx 可重试
      if (attempt < CONFIG.maxRetries && (isTimeout || err.message.includes("5"))) {
        continue;
      }
      throw err;
    }
  }
}

// =============================================================================
// 3. SSE 流式解析
// =============================================================================

/**
 * 将 SSE 字节流解析为 AsyncGenerator，每次 yield 一个 content delta。
 * 兼容 Web ReadableStream 和 Node.js Readable（async iterable）。
 *
 * @param {ReadableStream|NodeJS.ReadableStream} stream
 * @yields {string} content delta 片段
 */
async function* parseSSEStream(stream) {
  let buffer = "";

  if (typeof stream.getReader === "function") {
    // ── Web ReadableStream ──
    const reader  = stream.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          yield* _parseSSELine(line);
        }
      }
    } finally {
      reader.releaseLock?.();
    }
  } else {
    // ── Node.js Readable (async iterable) ──
    for await (const chunk of stream) {
      const text = typeof chunk === "string"
        ? chunk
        : new TextDecoder().decode(chunk);

      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        yield* _parseSSELine(line);
      }
    }
  }
}

/**
 * 从单行 SSE 文本提取 delta（可能为空）。
 * 忽略注释行（: 开头）、空行、[DONE] 标记、无效 JSON。
 */
function* _parseSSELine(line) {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("data:")) return;

  const data = trimmed.slice(5).trim();
  if (data === "[DONE]") return;

  try {
    const json  = JSON.parse(data);
    const delta = json.choices?.[0]?.delta?.content;
    if (delta) yield delta;
  } catch {
    // 非 JSON 行，静默忽略
  }
}

// =============================================================================
// 4. streamChat — 流式聊天便捷方法
// =============================================================================

/**
 * 流式对话：调用 API → 解析 SSE → 逐 token 回调 → 返回完整文本。
 *
 * @param {Array<{role:string, content:string}>} messages
 * @param {Object}   [opts]
 * @param {Function} [opts.onToken]  - 流式 token 回调
 * @param {number}   [opts.timeoutMs] - 透传给 apiCallWithTimeout
 * @param {string}   [opts.model]
 * @param {number}   [opts.temperature]
 * @param {number}   [opts.maxTokens]
 * @returns {Promise<string>} 完整回复文本
 */
async function streamChat(messages, { onToken, ...opts } = {}) {
  const stream = await apiCallWithTimeout(messages, opts);
  let full = "";

  for await (const token of parseSSEStream(stream)) {
    full += token;
    onToken?.(token);
  }

  return full;
}

// =============================================================================
// 5. smartChat — 多Provider自动降级 (v3)
// =============================================================================

/**
 * 智能对话：主provider失败时自动降级到备用。
 * 按 CONFIG.fallbacks 顺序尝试，全部失败则抛出异常。
 *
 * @param {Array<{role:string, content:string}>} messages
 * @param {Object}   [opts]
 * @param {Function} [opts.onToken]  - 流式 token 回调
 * @param {number}   [opts.timeoutMs]
 * @returns {Promise<{text: string, provider: string}>}
 */
async function smartChat(messages, opts = {}) {
  const providers = [
    { name: "deepseek-primary", baseURL: CONFIG.baseURL, apiKey: CONFIG.apiKey, model: CONFIG.model },
    ...CONFIG.fallbacks.filter(p => p.apiKey), // 只保留有key的
  ];

  let lastError = null;
  for (const p of providers) {
    try {
      const stream = await apiCall(messages, {
        ...opts,
        model: p.model,
        signal: AbortSignal.timeout?.(opts.timeoutMs ?? CONFIG.timeoutMs),
      });

      // 需要支持自定义baseURL
      let full = "";
      const baseApi = p.baseURL !== CONFIG.baseURL
        ? await _apiCallWithBase(messages, { ...opts, model: p.model, baseURL: p.baseURL, apiKey: p.apiKey })
        : null;

      if (baseApi) {
        for await (const token of parseSSEStream(baseApi)) {
          full += token;
          opts.onToken?.(token);
        }
      } else {
        for await (const token of parseSSEStream(stream)) {
          full += token;
          opts.onToken?.(token);
        }
      }

      return { text: full, provider: p.name };
    } catch (err) {
      lastError = err;
      continue;
    }
  }

  throw new Error(`All providers failed. Last error: ${lastError?.message || "unknown"}`);
}

/**
 * 用自定义baseURL调用API
 */
async function _apiCallWithBase(messages, { baseURL, apiKey, model, temperature, maxTokens, signal } = {}) {
  const url = `${baseURL}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || CONFIG.model,
      messages,
      temperature: temperature ?? 0.8,
      max_tokens: maxTokens ?? 1024,
      stream: true,
    }),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.body;
}

// =============================================================================
// 导出
// =============================================================================

export {
  CONFIG,
  apiCall,
  apiCallWithTimeout,
  parseSSEStream,
  streamChat,
  smartChat,
};
