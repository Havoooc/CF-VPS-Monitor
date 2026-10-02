// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { cfsmGet, cfsmGetAll } from "@/services/cfsm/http";
import { resetApiBaseCache } from "@/services/cfsm/config";

const A = "https://a.example.com";
const B = "https://b.example.com";

const PayloadSchema = z.object({ value: z.number() });

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  document.head.innerHTML = `<meta name="apiBase" content="${A},${B}">`;
  resetApiBaseCache();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.head.innerHTML = "";
});

describe("cfsmGetAll", () => {
  it("返回数组与 getApiBases() 同序，哪怕完成顺序是反的", async () => {
    const slow = deferred<Response>();
    fetchMock.mockImplementation(async (url: string) =>
      String(url).startsWith(A) ? slow.promise : jsonResponse({ value: 2 }),
    );

    const pending = cfsmGetAll("/api/servers", PayloadSchema);

    // 等 B 先回来（A 还挂着）。
    await Promise.resolve();
    await Promise.resolve();
    slow.resolve(jsonResponse({ value: 1 }));
    const results = await pending;

    expect(results.map((result) => result.base)).toEqual([A, B]);
    expect(results[0]?.data).toEqual({ value: 1 });
    expect(results[1]?.data).toEqual({ value: 2 });
  });

  it("onResult 按完成顺序分阶段回调，慢站不拖着快站", async () => {
    const slow = deferred<Response>();
    const order: string[] = [];
    fetchMock.mockImplementation(async (url: string) =>
      String(url).startsWith(A) ? slow.promise : jsonResponse({ value: 2 }),
    );

    const pending = cfsmGetAll("/api/servers", PayloadSchema, {
      onResult: (result) => order.push(result.base),
    });

    // 让 B 的请求先落地 —— 此时 A 还没 settle，但 B 已经交付。
    await vi.waitFor(() => expect(order).toEqual([B]));

    slow.resolve(jsonResponse({ value: 1 }));
    await pending;

    expect(order).toEqual([B, A]);
  });

  it("单站失败也照样分阶段交付，并把错误挂在对应槽位", async () => {
    const order: string[] = [];
    fetchMock.mockImplementation(async (url: string) =>
      String(url).startsWith(A) ? jsonResponse({ error: "boom" }, 500) : jsonResponse({ value: 2 }),
    );

    const results = await cfsmGetAll("/api/servers", PayloadSchema, {
      onResult: (result) => order.push(result.base),
    });

    expect(order.sort()).toEqual([A, B]);
    expect(results[0]?.error).toBeInstanceOf(Error);
    expect(results[1]?.data).toEqual({ value: 2 });
  });

  it("回调抛错只打警告，不影响取数结果", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockImplementation(async () => jsonResponse({ value: 7 }));

    const results = await cfsmGetAll("/api/servers", PayloadSchema, {
      onResult: () => {
        throw new Error("consumer bug");
      },
    });

    expect(results.every((result) => result.data?.value === 7)).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it("单个后端的 GET 仍按 base 打点", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ value: 3 }));

    await cfsmGet("/api/servers", PayloadSchema, { base: B });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${B}/api/servers`);
  });
});
