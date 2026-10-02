import { afterEach, describe, expect, it, vi } from "vitest";
import { ResponseTooLargeError, fetchWithTimeout, withTimeoutSignal } from "@/utils/abort";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("fetchWithTimeout", () => {
  it("clears the timeout the moment the request settles", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true }) as Response));

    await fetchWithTimeout("/x", undefined, 10_000);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timeout even when the request rejects", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));

    await expect(fetchWithTimeout("/x", undefined, 10_000)).rejects.toThrow("network down");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes an unaborted combined signal to fetch", async () => {
    let seen: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        seen = init?.signal ?? undefined;
        return { ok: true } as Response;
      }),
    );

    await fetchWithTimeout("/x", undefined, 10_000);
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
  });

  it("propagates an already-aborted upstream signal to fetch", async () => {
    const upstream = new AbortController();
    upstream.abort();
    let seen: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        seen = init?.signal ?? undefined;
        return { ok: true } as Response;
      }),
    );

    await fetchWithTimeout("/x", undefined, 10_000, upstream.signal);
    expect(seen?.aborted).toBe(true);
  });

  it("preserves the signal supplied through RequestInit", async () => {
    const request = new AbortController();
    let seen: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        seen = init?.signal ?? undefined;
        return { ok: true } as Response;
      }),
    );

    request.abort("cancelled");
    await fetchWithTimeout("/x", { signal: request.signal }, 10_000);
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toBe("cancelled");
  });

  it("combines explicit and RequestInit cancellation sources", async () => {
    const explicit = new AbortController();
    const request = new AbortController();
    let seen: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        seen = init?.signal ?? undefined;
        return { ok: true } as Response;
      }),
    );

    explicit.abort("explicit");
    await fetchWithTimeout("/x", { signal: request.signal }, 10_000, explicit.signal);
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toBe("explicit");
  });

  it("preserves cancellation from a Request input", async () => {
    const requestController = new AbortController();
    const request = new Request("https://example.test/x", {
      signal: requestController.signal,
    });
    let seen: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        seen = init?.signal ?? undefined;
        return { ok: true } as Response;
      }),
    );

    requestController.abort("request");
    await fetchWithTimeout(request, undefined, 10_000);
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toBe("request");
  });

  it("lets RequestInit.signal override the signal on a Request input", async () => {
    const requestController = new AbortController();
    const initController = new AbortController();
    const request = new Request("https://example.test/x", {
      signal: requestController.signal,
    });
    requestController.abort("request");
    let seen: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        seen = init?.signal ?? undefined;
        return { ok: true } as Response;
      }),
    );

    await fetchWithTimeout(request, { signal: initController.signal }, 10_000);
    expect(seen?.aborted).toBe(false);
  });
});

describe("withTimeoutSignal", () => {
  it("cleans its timer as soon as the operation settles", async () => {
    vi.useFakeTimers();

    await expect(
      withTimeoutSignal(async (signal) => {
        expect(signal.aborted).toBe(false);
        return "ok";
      }, 5_000),
    ).resolves.toBe("ok");

    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes the upstream listener after an early rejection", async () => {
    vi.useFakeTimers();
    const upstream = new AbortController();
    const removeEventListener = vi.spyOn(upstream.signal, "removeEventListener");

    await expect(
      withTimeoutSignal(
        async () => {
          throw new Error("failed early");
        },
        5_000,
        upstream.signal,
      ),
    ).rejects.toThrow("failed early");

    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("response body timeout", () => {
  it("aborts a stalled response body after headers have arrived", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (_: unknown, init: RequestInit) => {
      const stream = new ReadableStream({
        start(controller) {
          init.signal!.addEventListener("abort", () => controller.error(new Error("body aborted")));
        },
      });
      return new Response(stream);
    }));
    const pending = fetchWithTimeout("https://example.test/x", {}, 50);
    const assertion = expect(pending).rejects.toThrow("body aborted");
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("response body size limit", () => {
  it("reads the body back when it stays under the limit", async () => {
    const payload = JSON.stringify([{ a: 1 }]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(payload)));

    const response = await fetchWithTimeout("https://example.test/x", {}, 10_000, undefined, 1024);

    await expect(response.text()).resolves.toBe(payload);
  });

  it("rejects from Content-Length alone, without draining the stream", async () => {
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(64));
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(stream, { headers: { "Content-Length": "2000" } }),
      ),
    );

    const error = await fetchWithTimeout(
      "https://example.test/x",
      {},
      10_000,
      undefined,
      100,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ResponseTooLargeError);
    // received 必须等于声明值 2000。若真去读了流，分片是 64 字节的倍数，不可能是 2000。
    expect((error as ResponseTooLargeError).received).toBe(2000);
  });

  it("stops mid-stream once the running total passes the limit", async () => {
    let pulls = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls > 50) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(64));
      },
    });
    // 没有 Content-Length，只能边读边判。
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream)));

    const error = await fetchWithTimeout(
      "https://example.test/x",
      {},
      10_000,
      undefined,
      200,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ResponseTooLargeError);
    // 200 字节上限：最多读到第 4 个 64 字节分片就该停，不该把 50 片读完。
    expect(pulls).toBeLessThan(10);
  });

  it.each([
    ["undefined", undefined],
    ["0", "0"],
  ])("treats a %s Content-Length as unknown rather than a violation", async (_label, header) => {
    const headers = header === undefined ? undefined : { "Content-Length": header };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { headers })));

    const response = await fetchWithTimeout("https://example.test/x", {}, 10_000, undefined, 16);

    await expect(response.text()).resolves.toBe("ok");
  });
});
