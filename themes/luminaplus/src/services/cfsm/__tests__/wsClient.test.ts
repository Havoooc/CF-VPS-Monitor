// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildWsUrl, createWsConnection, type WsSample } from "@/services/cfsm/wsClient";

/**
 * 票据是跨域建连前异步换的。这里把它固定成「换不到」，让用例走 Cookie 回落路径；
 * 需要验证票据行为的用例再单独改写返回值。
 */
const mocks = vi.hoisted(() => ({ requestWsTicket: vi.fn() }));

vi.mock("@/services/cfsm/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/cfsm/http")>()),
  requestWsTicket: mocks.requestWsTicket,
}));

/** 排空微任务，等换票流程走完。 */
async function flushAsync() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;

  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  emit(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  mocks.requestWsTicket.mockReset();
  mocks.requestWsTicket.mockRejectedValue(new Error("ticket endpoint down"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function connect(ids: string[]) {
  const batches: WsSample[][] = [];
  const availability: boolean[] = [];
  const connection = createWsConnection("https://status.example.com", ids, {
    onBatch: (samples) => batches.push(samples),
    onAvailabilityChange: (available) => availability.push(available),
  });
  // 建连前要先把票据流程走完（本套用例里它会失败并回落到 Cookie 鉴权）。
  await flushAsync();
  return { connection, batches, availability, socket: () => FakeSocket.instances.at(-1)! };
}

describe("createWsConnection", () => {
  it("connects to the wss endpoint and subscribes after open", async () => {
    const { socket } = await connect(["node-a", "node-b"]);

    expect(socket().url).toBe("wss://status.example.com/api/ws?subscribe=all");
    socket().open();

    expect(JSON.parse(socket().sent[0]!)).toEqual({
      type: "subscribe",
      scope: "all",
      ids: ["node-a", "node-b"],
    });
  });

  it("reports availability only once the socket is open", async () => {
    const { availability, socket } = await connect(["node-a"]);

    expect(availability).toEqual([]);
    socket().open();
    expect(availability).toEqual([true]);
  });

  it("extracts samples from data, payload and metrics alike", async () => {
    const { batches, socket } = await connect(["node-a"]);
    socket().open();

    socket().emit({
      type: "batchUpdate",
      updates: [
        { serverId: "node-a", samples: [{ ts: 1, data: { cpu: 10 } }] },
        { serverId: "node-b", samples: [{ ts: 2, payload: { cpu: 20 } }] },
        { serverId: "node-c", samples: [{ ts: 3, metrics: { cpu: 30 } }] },
      ],
    });

    expect(batches[0]).toEqual([
      { serverId: "node-a", ts: 1, data: { cpu: 10 } },
      { serverId: "node-b", ts: 2, data: { cpu: 20 } },
      { serverId: "node-c", ts: 3, data: { cpu: 30 } },
    ]);
  });

  it("ignores non-batchUpdate frames", async () => {
    const { batches, socket } = await connect(["node-a"]);
    socket().open();

    socket().emit({ type: "hello", ts: 1, subscribed: "all" });
    socket().emit({ type: "pong", ts: 2 });

    expect(batches).toEqual([]);
  });

  it("drops ids the backend would reject instead of sending them", async () => {
    const { socket } = await connect(["node-a", "bad id!", "x".repeat(65)]);
    socket().open();

    expect(JSON.parse(socket().sent[0]!).ids).toEqual(["node-a"]);
  });

  it("caps the subscription at 500 ids", async () => {
    const ids = Array.from({ length: 600 }, (_, index) => `node-${index}`);
    const { socket } = await connect(ids);
    socket().open();

    expect(JSON.parse(socket().sent[0]!).ids).toHaveLength(500);
  });

  it("resends the subscription when the node list changes", async () => {
    const { connection, socket } = await connect(["node-a"]);
    socket().open();

    connection.updateIds(["node-a", "node-b"]);
    expect(JSON.parse(socket().sent.at(-1)!).ids).toEqual(["node-a", "node-b"]);

    // 内容相同则不重复发送。
    connection.updateIds(["node-a", "node-b"]);
    expect(socket().sent).toHaveLength(2);
  });

  it("sends a keepalive ping on the interval", async () => {
    const { socket } = await connect(["node-a"]);
    socket().open();
    socket().sent.length = 0;

    vi.advanceTimersByTime(30_000);

    expect(JSON.parse(socket().sent[0]!).type).toBe("ping");
  });

  it("reconnects with backoff after an unexpected close", async () => {
    const { socket } = await connect(["node-a"]);
    socket().open();
    socket().onclose?.({ code: 1006 });

    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1_500);
    await flushAsync();
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("stops retrying when the server rejects the subscription (1008)", async () => {
    const { availability, socket } = await connect(["node-a"]);
    socket().open();
    socket().onclose?.({ code: 1008 });

    vi.advanceTimersByTime(60_000);
    await flushAsync();

    expect(FakeSocket.instances).toHaveLength(1);
    expect(availability.at(-1)).toBe(false);
  });

  it("reconnects when an open connection stops receiving messages", async () => {
    const { connection, socket, availability } = await connect(["node-a"]);
    socket().open();
    vi.advanceTimersByTime(97_000);
    await flushAsync();
    expect(availability).toContain(false);
    expect(FakeSocket.instances.length).toBeGreaterThan(1);
    connection.close();
  });

  it("closes a connection that never opens", async () => {
    const { connection } = await connect(["node-a"]);
    vi.advanceTimersByTime(22_000);
    await flushAsync();
    expect(FakeSocket.instances.length).toBeGreaterThan(1);
    connection.close();
  });

  it("does not reconnect after an explicit close", async () => {
    const { connection, socket } = await connect(["node-a"]);
    socket().open();
    connection.close();

    vi.advanceTimersByTime(60_000);
    await flushAsync();

    expect(FakeSocket.instances).toHaveLength(1);
  });
});

describe("buildWsUrl", () => {
  it("同域不带任何凭证：Cookie 自己会跟着握手走", () => {
    expect(buildWsUrl("https://status.example.com")).toBe(
      "wss://status.example.com/api/ws?subscribe=all",
    );
    expect(buildWsUrl("http://127.0.0.1:8787")).toBe(
      "ws://127.0.0.1:8787/api/ws?subscribe=all",
    );
  });

  it("跨域带的是短期一次性票据，而不是长期 JWT", () => {
    expect(buildWsUrl("https://status.example.com", "tkt-1")).toBe(
      "wss://status.example.com/api/ws?subscribe=all&ticket=tkt-1",
    );
  });
});

describe("跨域建连前的票据换取", () => {
  it("换到票据就用票据建连", async () => {
    mocks.requestWsTicket.mockResolvedValue({ ticket: "tkt-9", expiresIn: 60 });

    const { socket } = await connect(["node-a"]);

    expect(String(socket().url)).toContain("ticket=tkt-9");
  });

  it("换不到票据时回落到 Cookie 鉴权，不把实时推送整条掐掉", async () => {
    // beforeEach 里已经把 requestWsTicket 设成 reject。
    const { socket } = await connect(["node-a"]);

    expect(String(socket().url)).toBe("wss://status.example.com/api/ws?subscribe=all");
  });
});
