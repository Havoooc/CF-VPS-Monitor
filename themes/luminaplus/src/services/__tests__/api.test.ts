// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearHistoryCache,
  getHistoryCacheSize,
  getLoadRecords,
  getMe,
  getPingRecords,
  getPublic,
  getServersSnapshot,
  getServerApiBase,
  normalizeHistoryHours,
  refreshPingHistory,
  saveThemeOptions,
  type ServersSnapshot,
} from "@/services/api";
import { resetApiBaseCache } from "@/services/cfsm/config";
import { DEFAULT_CARRIER_NAMES } from "@/services/cfsm/mappers";
import { ApiRequestError } from "@/services/cfsm/http";
import { getPingHistorySnapshot } from "@/services/pingLiveStore";

const ORIGIN = "https://status.example.com";

// Response 的 body 只能读一次，因此每次调用都要新建一个。
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 让每次 fetch 都拿到独立的响应对象。 */
function jsonReply(body: unknown, status = 200) {
  return async () => jsonResponse(body, status);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 多站部署：两个后端地址。 */
function useTwoBases() {
  document.head.innerHTML =
    `<meta name="apiBase" content="${ORIGIN},https://backup.example.com">`;
  resetApiBaseCache();
}

function serverPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "node-a",
    name: "Node A",
    server_group: "prod",
    region: "JP",
    is_hidden: "0",
    sort_order: 10,
    cpu: 12.5,
    load_avg: "0.10 0.20 0.30",
    net_in_speed: 1024,
    net_out_speed: 512,
    net_rx: 100,
    net_tx: 200,
    net_rx_monthly: 50,
    net_tx_monthly: 60,
    ram_total: 8192,
    ram_used: 4096,
    swap_total: 1024,
    swap_used: 128,
    disk_total: 102400,
    disk_used: 51200,
    cpu_cores: 4,
    cpu_info: "Intel Xeon",
    arch: "x86_64",
    os: "Ubuntu 22.04",
    kernel_version: "6.8.0",
    ip_v4: "1",
    ip_v6: "0",
    boot_time: "1700000000000",
    last_updated: Date.now(),
    timestamp: Date.now(),
    price: "30.00",
    currency: "¥",
    billing_cycle: "month",
    auto_renewal: "0",
    expire_date: "2026-12-31",
    traffic_limit: "1024",
    traffic_calc_type: "total",
    reset_day: 1,
    report_interval: 60,
    tags: "prod,edge",
    ...overrides,
  };
}

function historyRow(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: Date.parse("2026-07-16T00:00:00Z"),
    cpu: 20,
    ram_total: 8192,
    ram_used: 2048,
    swap_total: 1024,
    swap_used: 64,
    disk_total: 102400,
    disk_used: 20480,
    processes: 120,
    net_in_speed: 2048,
    net_out_speed: 1024,
    tcp_conn: 30,
    udp_conn: 4,
    ping_ct: 23,
    ping_cu: 25,
    ping_cm: 30,
    ping_bd: 40,
    loss_ct: 0,
    loss_cu: 0,
    loss_cm: 0,
    loss_bd: 0,
    load_avg: "0.50 0.40 0.30",
    kernel_version: "6.8.0",
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetApiBaseCache();
  clearHistoryCache();
  window.localStorage.clear();
  document.head.innerHTML = "";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("normalizeHistoryHours", () => {
  it("snaps arbitrary durations to a supported step", () => {
    expect(normalizeHistoryHours(4)).toBe(6);
    expect(normalizeHistoryHours(0.2)).toBe(0.167);
    expect(normalizeHistoryHours(1000)).toBe(168);
    expect(normalizeHistoryHours(Number.NaN)).toBe(24);
  });
});

describe("getPublic", () => {
  it("maps /api/config into the theme's display model", async () => {
    fetchMock.mockImplementation(
      jsonReply({
        version: "2.7.12",
        is_public: false,
        authorization: true,
        turnstile_enabled: true,
        turnstile_site_key: "key",
        site_title: "My Monitor",
        theme_options: { showConnections: false },
        verified: true,
        long_history_points: 180,
      }),
    );

    const config = await getPublic();

    expect(config.sitename).toBe("My Monitor");
    expect(config.private_site).toBe(true);
    expect(config.theme_settings).toEqual({ showConnections: false });
    expect(config.sys.long_history_points).toBe(180);
  });

  it("carries latency_window through so cards can size the ping window", async () => {
    fetchMock.mockImplementation(
      jsonReply({ site_title: "S", latency_window: { points: 20, hours: 2 } }),
    );

    const config = await getPublic();

    expect(config.latencyWindow).toEqual({ points: 20, hours: 2 });
  });

  it("leaves latencyWindow undefined when the backend omits it (older backends)", async () => {
    fetchMock.mockImplementation(jsonReply({ site_title: "S" }));

    const config = await getPublic();

    expect(config.latencyWindow).toBeUndefined();
  });

  it("takes the carrier names the backend customised", async () => {
    fetchMock.mockImplementation(
      jsonReply({
        site_title: "S",
        custom_ct_name: "CT",
        custom_cu_name: "CU",
        custom_cm_name: "CM",
        custom_bd_name: "BGP",
      }),
    );

    const config = await getPublic();

    expect(config.carrierNames).toEqual({
      ...DEFAULT_CARRIER_NAMES,
      ct: "CT",
      cu: "CU",
      cm: "CM",
      bd: "BGP",
    });
  });

  it("takes the four extra line names the backend added (node_N_name)", async () => {
    // 后四条的键名风格和前四条不一样（node_N_name，不是 custom_*_name），别只接前四条。
    fetchMock.mockImplementation(
      jsonReply({
        site_title: "S",
        node_1_name: "东京",
        node_3_name: "法兰克福",
      }),
    );

    const config = await getPublic();

    expect(config.carrierNames).toEqual({
      ...DEFAULT_CARRIER_NAMES,
      node_1: "东京",
      node_3: "法兰克福",
    });
  });

  it("falls back per carrier when only some names are customised", async () => {
    // 老后端一个都不下发、新后端也可能只改一两条：没给的那几条必须留默认名，不能变空。
    fetchMock.mockImplementation(
      jsonReply({ site_title: "S", custom_bd_name: "BGP", custom_cm_name: "  " }),
    );

    const config = await getPublic();

    expect(config.carrierNames).toEqual({
      ...DEFAULT_CARRIER_NAMES,
      bd: "BGP",
    });
  });

  it("keeps the default carrier names when the backend omits the fields", async () => {
    fetchMock.mockImplementation(jsonReply({ site_title: "S" }));

    const config = await getPublic();

    expect(config.carrierNames).toEqual(DEFAULT_CARRIER_NAMES);
  });

  it("caches the encrypted turnstile credential for reuse", async () => {
    fetchMock.mockImplementation(
      jsonReply({ site_title: "S", turnstile_verified: "cred-1" }),
    );

    await getPublic();

    expect(window.localStorage.getItem("turnstile_verified")).toBe("cred-1");
  });

  it("surfaces the backend error message", async () => {
    fetchMock.mockImplementation(jsonReply({ error: "Missing ID", code: 400 }, 400));

    await expect(getPublic()).rejects.toBeInstanceOf(ApiRequestError);
  });
});

describe("getMe", () => {
  it("reports a logged-out visitor without hitting the network", async () => {
    const me = await getMe();

    expect(me.logged_in).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("derives the login state from config.authorization", async () => {
    window.localStorage.setItem("jwt_token", "token");
    fetchMock.mockImplementation(jsonReply({ authorization: true, site_title: "S" }));

    await expect(getMe()).resolves.toMatchObject({ logged_in: true });
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token");
  });

  it("drops an expired token on 401 so later requests go out anonymously", async () => {
    window.localStorage.setItem("jwt_token", "stale");
    fetchMock.mockImplementation(jsonReply({ error: "Unauthorized", code: 401 }, 401));

    await expect(getMe()).rejects.toBeInstanceOf(ApiRequestError);
    expect(window.localStorage.getItem("jwt_token")).toBeNull();
  });
});

describe("saveThemeOptions", () => {
  it("POSTs { theme_options } as JSON with the admin bearer + turnstile headers", async () => {
    window.localStorage.setItem("jwt_token", "token");
    window.localStorage.setItem("turnstile_verified", "cached-cred");
    fetchMock.mockImplementation(
      jsonReply({ success: true, theme_options: { accent: "green" }, message: "updateSuccess" }),
    );

    const res = await saveThemeOptions({ accent: "green" });

    expect(res).toMatchObject({ success: true, message: "updateSuccess" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/theme_options");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer token");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Turnstile-Verified"]).toBe("cached-cred");
    expect(JSON.parse(init.body as string)).toEqual({ theme_options: { accent: "green" } });
  });

  it("drops the expired token on 401 (writes have no anonymous fallback)", async () => {
    window.localStorage.setItem("jwt_token", "stale");
    fetchMock.mockImplementation(jsonReply({ error: "Unauthorized", code: 401 }, 401));

    await expect(saveThemeOptions({ accent: "green" })).rejects.toBeInstanceOf(ApiRequestError);
    expect(window.localStorage.getItem("jwt_token")).toBeNull();
  });

  it("clears turnstile credentials on 403 so the gate re-challenges", async () => {
    window.localStorage.setItem("jwt_token", "token");
    window.localStorage.setItem("turnstile_verified", "cached-cred");
    fetchMock.mockImplementation(jsonReply({ error: "forbidden", code: 403 }, 403));

    await expect(saveThemeOptions({ accent: "green" })).rejects.toBeInstanceOf(ApiRequestError);
    expect(window.localStorage.getItem("turnstile_verified")).toBeNull();
  });
});

describe("getServersSnapshot", () => {
  it("keeps duplicate IDs routed to the first backend and removes stale mappings", async () => {
    document.head.innerHTML = `<meta name="apiBase" content="${ORIGIN},https://backup.example.com">`;
    resetApiBaseCache();
    fetchMock.mockImplementation(jsonReply({servers:[serverPayload()], stats:{},regionStats:{},sysConfig:{}}));
    const snapshot = await getServersSnapshot();
    expect(snapshot.servers).toHaveLength(1);
    expect(snapshot.baseByServerId.get("node-a")).toBe(ORIGIN);
    expect(getServerApiBase("node-a")).toBe(ORIGIN);
    fetchMock.mockImplementation(jsonReply({servers:[],stats:{},regionStats:{},sysConfig:{}}));
    await getServersSnapshot();
    expect(getServerApiBase("node-a")).toBeUndefined();
  });

  it("returns the server list with its owning API base", async () => {
    fetchMock.mockImplementation(
      jsonReply({
        servers: [serverPayload()],
        stats: { total: 1, online: 1 },
        regionStats: { JP: 1 },
        sysConfig: { show_price: false, show_expire: true, show_tf: true, show_time: true },
      }),
    );

    const snapshot = await getServersSnapshot();

    expect(snapshot.servers).toHaveLength(1);
    expect(snapshot.baseByServerId.get("node-a")).toBe(window.location.origin);
    expect(snapshot.sysConfig.show_price).toBe(false);
    expect(snapshot.partial).toBe(false);
  });

  it("merges multiple api bases and marks a partial result when one fails", async () => {
    const meta = document.createElement("meta");
    meta.name = "apiBase";
    meta.content = `${ORIGIN},https://backup.example.com`;
    document.head.append(meta);
    resetApiBaseCache();

    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith(ORIGIN)) {
        return jsonResponse({
          servers: [serverPayload()],
          stats: { total: 1, online: 1 },
          regionStats: { JP: 1 },
          sysConfig: {},
        });
      }
      return jsonResponse({ error: "boom", code: 500 }, 500);
    });

    const snapshot = await getServersSnapshot();

    expect(snapshot.servers.map((server) => server.id)).toEqual(["node-a"]);
    expect(snapshot.baseByServerId.get("node-a")).toBe(ORIGIN);
    expect(snapshot.partial).toBe(true);
  });

  it("throws when every api base fails", async () => {
    fetchMock.mockImplementation(jsonReply({ error: "boom", code: 500 }, 500));

    await expect(getServersSnapshot()).rejects.toBeInstanceOf(Error);
  });
});

describe("getLoadRecords", () => {
  it("converts history rows into chart records with byte units", async () => {
    fetchMock.mockImplementation(jsonReply([historyRow()]));

    const { records } = await getLoadRecords("node-a", 6);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      cpu: 20,
      ram: 2048 * 1024 * 1024,
      ram_total: 8192 * 1024 * 1024,
      net_in: 2048,
      net_out: 1024,
      load: 0.5,
      client: "node-a",
    });
  });

  it("sorts rows ascending and infers the sampling interval", async () => {
    const base = Date.parse("2026-07-16T00:00:00Z");
    fetchMock.mockImplementation(
      jsonReply([
        historyRow({ timestamp: base + 120_000 }),
        historyRow({ timestamp: base }),
        historyRow({ timestamp: base + 60_000 }),
      ]),
    );

    const { records, intervalSeconds } = await getLoadRecords("node-a", 1);

    expect(records.map((record) => record.time)).toEqual([
      base,
      base + 60_000,
      base + 120_000,
    ]);
    expect(intervalSeconds).toBe(60);
  });

  it("requests a backend-supported hours value", async () => {
    fetchMock.mockImplementation(jsonReply([]));

    await getLoadRecords("node-a", 4);

    expect(String(fetchMock.mock.calls[0]![0])).toContain("hours=6");
  });
});

describe("getPingRecords", () => {
  it("splits each history row into the four carrier lines", async () => {
    fetchMock.mockImplementation(jsonReply([historyRow()]));

    const { records, tasks, stats } = await getPingRecords("node-a", 6);

    expect(records.map((record) => record.task_id)).toEqual([1, 2, 3, 4]);
    expect(records.map((record) => record.value)).toEqual([23, 25, 30, 40]);
    expect(tasks.map((task) => task.name)).toEqual(["电信", "联通", "移动", "BD"]);
    expect(stats?.find((stat) => stat.taskId === 1)?.avg).toBe(23);
  });

  it("skips carriers with no measurement, but keeps failed probes", async () => {
    fetchMock.mockImplementation(
      jsonReply([historyRow({ ping_cu: null, ping_bd: -1 })]),
    );

    const { records } = await getPingRecords("node-a", 6);

    // 联通 null 且丢包不是正数 = 没取样，跳过；BD 负值 = 探测失败，要留着（图表靠它画断点、算丢包）。
    expect(records.map((record) => record.task_id)).toEqual([1, 3, 4]);
    expect(records.find((record) => record.task_id === 4)?.value).toBe(-1);
  });

  it("drops lines the backend marks as unconfigured with false, new ones included", async () => {
    // 后端对没配探测目标的槽位下发 false（2026-09-09 实测，历史行与快照都是这样），
    // 站长的要求是「ping_x / loss_x 不存在就不展示」——包括老的 ping_bd。
    fetchMock.mockImplementation(
      jsonReply([
        historyRow({
          ping_bd: false as unknown as number,
          ping_node_1: 42,
          ping_node_2: false as unknown as number,
          ping_node_3: null,
        }),
      ]),
    );

    const { records, tasks } = await getPingRecords("node-a", 6);

    // 1/2/3 有值，5 = node_1 有值；4(bd) / 6(node_2) / 7(node_3) / 8(node_4) 都不产出点。
    expect([...new Set(records.map((record) => record.task_id))]).toEqual([1, 2, 3, 5]);
    // 详情页图表只画 tasks 里的线路，所以没数据的那几条根本不会出现在图例里。
    expect(tasks.map((task) => task.id)).toEqual([1, 2, 3, 5]);
  });
});

describe("refreshPingHistory", () => {
  it("查一次 hours=1 并把结果回灌延迟缓冲区", async () => {
    const now = Date.now();
    fetchMock.mockImplementation(
      jsonReply([
        historyRow({ timestamp: now - 120_000, ping_ct: 40 }),
        historyRow({ timestamp: now - 60_000, ping_ct: 41 }),
      ]),
    );

    const result = await refreshPingHistory(["node-a"]);

    expect(result).toEqual({ requested: 1, succeeded: 1, failed: 0 });
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/api/history/all");
    expect(url).toContain("hours=1");
    // 回灌走的是详情页那条通道，缓冲区里应该能读到刚拉回来的采样。
    expect(getPingHistorySnapshot("node-a").length).toBeGreaterThan(0);
  });

  it("去重节点 id，一台只发一次", async () => {
    fetchMock.mockImplementation(jsonReply([historyRow({ timestamp: Date.now() })]));

    const result = await refreshPingHistory(["node-a", "node-a", "node-b", ""]);

    expect(result.requested).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("单台失败不影响其余节点回灌", async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input).includes("id=node-b")) return jsonResponse({ error: "boom" }, 500);
      return jsonResponse([historyRow({ timestamp: Date.now() })]);
    });

    const result = await refreshPingHistory(["node-a", "node-b", "node-c"]);

    expect(result).toEqual({ requested: 3, succeeded: 2, failed: 1 });
  });

  it("并发有上限，节点多也不会一次全打出去", async () => {
    const ids = Array.from({ length: 12 }, (_, index) => `node-${index}`);
    let inFlight = 0;
    let peak = 0;
    const release: Array<() => void> = [];

    fetchMock.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => release.push(resolve));
      inFlight -= 1;
      return jsonResponse([historyRow({ timestamp: Date.now() })]);
    });

    const pending = refreshPingHistory(ids);
    // Drain each wave on event-loop turns: body streams also schedule tasks,
    // so a fixed number of microtask flushes is insufficient on Node 22.
    const drain = setInterval(() => {
      while (release.length > 0) release.shift()?.();
    }, 1);
    let result;
    try { result = await pending; } finally { clearInterval(drain); }

    expect(result.succeeded).toBe(12);
    expect(result.requested).toBe(12);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });
});

describe("历史响应的结构校验", () => {
  it("顶层不是数组时明确报错，而不是静默变成空数组", async () => {
    // 旧实现用 `.catch([])`，接口坏了和「这段时间没数据」长得一模一样。
    fetchMock.mockImplementation(jsonReply({ error: "boom", code: 500 }));

    await expect(getLoadRecords("node-h06", 6)).rejects.toThrow(/Schema mismatch/);
  });

  it("单行坏掉只丢那一行，其余照常可用", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockImplementation(jsonReply([historyRow(), "broken-row", historyRow()]));

    const { records } = await getLoadRecords("node-single-bad", 6);

    expect(records).toHaveLength(2);
    expect(warn.mock.calls.some((call) => String(call[0]).includes("格式不符"))).toBe(true);
    // 诊断只报数量，不能把业务 payload 打出来。
    const logged = warn.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).not.toContain("broken-row");
  });

  it("整批都不合法时报错，让健康监控分得出「接口破了」", async () => {
    fetchMock.mockImplementation(jsonReply(["broken", 42, null]));

    await expect(getLoadRecords("node-all-bad", 6)).rejects.toThrow(/0 of 3 rows/);
  });
});

describe("历史缓存的容量与代次", () => {
  it("命中时不再打后端", async () => {
    fetchMock.mockImplementation(jsonReply([historyRow()]));

    await getLoadRecords("node-cache-hit", 6);
    const calls = fetchMock.mock.calls.length;
    await getLoadRecords("node-cache-hit", 6);

    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it("超过条数上限时淘汰最久未使用的条目", async () => {
    fetchMock.mockImplementation(jsonReply([historyRow()]));

    const ids = Array.from({ length: 70 }, (_, index) => `node-lru-${index}`);
    for (const id of ids) await getLoadRecords(id, 6);

    expect(getHistoryCacheSize()).toBeLessThanOrEqual(64);

    // node-lru-0 是最早写入的，早该被挤出去 —— 再查必须重新打后端。
    const before = fetchMock.mock.calls.length;
    await getLoadRecords("node-lru-0", 6);
    expect(fetchMock.mock.calls.length).toBe(before + 1);

    // 最后写入的还在缓存里。
    const afterMiss = fetchMock.mock.calls.length;
    await getLoadRecords("node-lru-69", 6);
    expect(fetchMock.mock.calls.length).toBe(afterMiss);
  });

  it("命中的条目会被挪到队尾，不按写入时间被误淘汰", async () => {
    fetchMock.mockImplementation(jsonReply([historyRow()]));

    for (let index = 0; index < 63; index += 1) {
      await getLoadRecords(`node-touch-${index}`, 6);
    }
    // 把最早那条"用一次"，它就该活下来。
    await getLoadRecords("node-touch-0", 6);
    await getLoadRecords("node-touch-63", 6);
    await getLoadRecords("node-touch-64", 6);

    const before = fetchMock.mock.calls.length;
    await getLoadRecords("node-touch-0", 6);
    expect(fetchMock.mock.calls.length).toBe(before);

    // 而真正最久没用的 node-touch-1 应该已经被淘汰。
    await getLoadRecords("node-touch-1", 6);
    expect(fetchMock.mock.calls.length).toBe(before + 1);
  });

  it("清缓存期间在途的请求不会把结果回写", async () => {
    const gate = deferred<Response>();
    fetchMock.mockImplementation(() => gate.promise);

    const pending = getLoadRecords("node-stale", 6);
    clearHistoryCache();
    gate.resolve(jsonResponse([historyRow()]));
    await pending;

    fetchMock.mockImplementation(jsonReply([historyRow()]));
    const before = fetchMock.mock.calls.length;
    await getLoadRecords("node-stale", 6);

    expect(fetchMock.mock.calls.length).toBe(before + 1);
  });

  it("旧请求收尾时不会误删新请求的在途记录", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    fetchMock.mockImplementationOnce(() => first.promise);
    fetchMock.mockImplementation(() => second.promise);

    const p1 = getLoadRecords("node-supersede", 6);
    clearHistoryCache();
    const p2 = getLoadRecords("node-supersede", 6);
    first.resolve(jsonResponse([historyRow({ timestamp: 1 })]));
    await p1;

    // 第二个请求还挂着，第三次应复用它而不是再打一发。
    const p3 = getLoadRecords("node-supersede", 6);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    second.resolve(jsonResponse([historyRow({ timestamp: 2 })]));
    await Promise.all([p2, p3]);
  });
});

describe("getServersSnapshot 的分阶段交付", () => {
  it("慢站还没回来时，先把快站的数据交付出去", async () => {
    useTwoBases();
    const slow = deferred<Response>();
    fetchMock.mockImplementation(async (url: string) =>
      String(url).startsWith(ORIGIN)
        ? jsonResponse({
            servers: [serverPayload()],
            stats: { total: 1, online: 1 },
            regionStats: { JP: 1 },
            sysConfig: {},
          })
        : slow.promise,
    );

    const seen: ServersSnapshot[] = [];
    const pending = getServersSnapshot({ onSnapshot: (snapshot) => seen.push(snapshot) });

    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[0]!.servers.map((server) => server.id)).toEqual(["node-a"]);
    expect(seen[0]!.partial).toBe(true);
    expect(seen[0]!.baseByServerId.get("node-a")).toBe(ORIGIN);

    slow.resolve(
      jsonResponse({
        servers: [serverPayload({ id: "node-b", name: "Node B" })],
        stats: { total: 1 },
        regionStats: { US: 1 },
        sysConfig: {},
      }),
    );
    const final = await pending;

    expect(final.servers.map((server) => server.id).sort()).toEqual(["node-a", "node-b"]);
    expect(final.partial).toBe(false);
    // 中间快照只增不减：慢站的节点不会先消失再出现。
    expect(seen.at(-1)!.servers.length).toBeLessThanOrEqual(final.servers.length);
  });

  it("全部站点失败时抛错，且不发出任何中间快照", async () => {
    useTwoBases();
    fetchMock.mockImplementation(jsonReply({ error: "boom", code: 500 }, 500));

    const seen: ServersSnapshot[] = [];
    await expect(
      getServersSnapshot({ onSnapshot: (snapshot) => seen.push(snapshot) }),
    ).rejects.toBeInstanceOf(Error);

    expect(seen).toHaveLength(0);
  });

  it("不发中间快照时行为与从前一致", async () => {
    useTwoBases();
    fetchMock.mockImplementation(
      jsonReply({
        servers: [serverPayload()],
        stats: { total: 1, online: 1 },
        regionStats: { JP: 1 },
        sysConfig: {},
      }),
    );

    const snapshot = await getServersSnapshot();

    expect(snapshot.partial).toBe(false);
    expect(snapshot.servers).toHaveLength(1);
  });
});
