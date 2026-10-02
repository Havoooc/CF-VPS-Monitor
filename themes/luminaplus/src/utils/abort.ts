interface ManagedTimeoutSignal {
  signal: AbortSignal;
  cleanup: () => void;
}

function createTimeoutSignal(
  sources: readonly (AbortSignal | null | undefined)[],
  ms: number,
): ManagedTimeoutSignal {
  const controller = new AbortController();
  const upstreams = [...new Set(sources.filter((source): source is AbortSignal => Boolean(source)))];
  const delay = Math.max(0, Number.isFinite(ms) ? ms : 0);
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (timer !== undefined) globalThis.clearTimeout(timer);
    for (const upstream of upstreams) {
      upstream.removeEventListener("abort", onUpstreamAbort);
    }
  };

  function onUpstreamAbort(event: Event) {
    const upstream = event.currentTarget as AbortSignal;
    cleanup();
    if (!controller.signal.aborted) controller.abort(upstream.reason);
  }

  const abortedSource = upstreams.find((upstream) => upstream.aborted);
  if (abortedSource) {
    controller.abort(abortedSource.reason);
  } else {
    timer = globalThis.setTimeout(() => {
      cleanup();
      if (!controller.signal.aborted) controller.abort();
    }, delay);
    for (const upstream of upstreams) {
      upstream.addEventListener("abort", onUpstreamAbort, { once: true });
    }
  }

  return { signal: controller.signal, cleanup };
}

export async function withTimeoutSignal<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  ms: number,
  upstream?: AbortSignal,
): Promise<T> {
  const managed = createTimeoutSignal([upstream], ms);
  try {
    return await operation(managed.signal);
  } finally {
    managed.cleanup();
  }
}

/**
 * 单个响应体允许缓冲的默认上限。
 *
 * 线上实测：`/api/history/all` 24 小时档约 65 KB，最长 168 小时档在几百 KB 量级；版本检查与
 * 汇率接口都是几 KB 的 JSON。4 MiB 对现有调用绰绰有余，但能挡住「后端抽风吐出一个无限
 * 流」或异常大的响应把瞬时内存拉爆。要更大就显式传 `maxBytes`。
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** 响应体超过上限时抛出。调用方按普通请求失败处理即可。 */
export class ResponseTooLargeError extends Error {
  constructor(
    public readonly limit: number,
    public readonly received: number,
  ) {
    super(`Response body exceeds ${limit} bytes (read ${received})`);
    this.name = "ResponseTooLargeError";
  }
}

function readContentLength(response: Response): number | null {
  const raw = response.headers?.get?.("content-length");
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * 按流读取并在超限时立刻中止，而不是把整包读完再判断 —— 上限存在的意义就是别读进来。
 */
async function readBodyWithLimit(response: Response, limit: number): Promise<ArrayBuffer> {
  const declared = readContentLength(response);
  if (declared !== null && declared > limit) {
    // 已经知道超限，连读都不用读。
    if (response.body) await response.body.cancel().catch(() => {});
    throw new ResponseTooLargeError(limit, declared);
  }

  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new ResponseTooLargeError(limit, total);
      }
      chunks.push(value);
    }
  } finally {
    // 已经 cancel 过的流再 releaseLock 会抛，忽略即可。
    try {
      reader.releaseLock();
    } catch {
      /* 流已释放 */
    }
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  ms: number,
  upstream?: AbortSignal,
  maxBytes: number = DEFAULT_MAX_RESPONSE_BYTES,
): Promise<Response> {
  const requestSignal =
    typeof Request !== "undefined" && input instanceof Request ? input.signal : undefined;
  const effectiveRequestSignal =
    init?.signal !== undefined ? init.signal : requestSignal;
  const { signal, cleanup } = createTimeoutSignal([upstream, effectiveRequestSignal], ms);
  try {
    const response = await fetch(input, { ...init, signal });
    if (!response.body) return response;
    const body = await readBodyWithLimit(response, Math.max(0, maxBytes));
    const buffered = new Response(body, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
    Object.defineProperties(buffered, {
      url: { value: response.url }, redirected: { value: response.redirected },
      type: { value: response.type },
    });
    return buffered;
  } finally {
    cleanup();
  }
}
