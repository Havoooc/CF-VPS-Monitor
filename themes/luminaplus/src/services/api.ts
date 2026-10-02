import { z } from "zod";
import {
  CfsmServerSchema,
  HistoryRowSchema,
  ServersResponseSchema,
  SiteConfigSchema,
  type CfsmServer,
  type HistoryRow,
  type LoadRecordsResponse,
  type Me,
  type NodeInfo,
  type PingRecordsResponse,
  type PingTaskStats,
  type PublicConfig,
  type SysConfig,
} from "@/types/cfsm";
import { getApiBases, getJwtToken, getPrimaryApiBase, validateApiBase } from "@/services/cfsm/config";
import {
  cfsmGet,
  cfsmPost,
  type RequestOptions,
} from "@/services/cfsm/http";
import {
  CARRIER_TASKS,
  carrierPingTasks,
  resolveCarrierNames,
  historyRowToLoadRecord,
  historyRowsToPingRecords,
  historyRowsToPingSamples,
  inferIntervalSeconds,
  isServerOnline,
  toNodeInfo,
} from "@/services/cfsm/mappers";
import { seedMeasuredHistory } from "@/services/pingLiveStore";
import { resolvePreferredAppearance } from "@/utils/themeSettings";

export { ApiRequestError, DatabaseUpgradeRequiredError } from "@/services/cfsm/http";

/** 后端支持的历史查询时长档位（小时）。 */
export const HISTORY_HOURS_OPTIONS = [0.167, 0.5, 1, 6, 12, 24, 48, 96, 168] as const;

/** 未登录用户查询超过 24 小时会被拒绝。 */
export const ANONYMOUS_MAX_HISTORY_HOURS = 24;

const degradeWarned = new Set<string>();
export function warnDegradedOnce(key: string, message: string) {
  if (degradeWarned.has(key)) return;
  degradeWarned.add(key);
  console.warn(`[LuminaPlus] ${message}`);
}

/** serverId → 拥有它的后端地址。多站部署时详情/历史必须打到正确的站点。 */
const serverBaseIndex = new Map<string, string>();

export function getServerApiBase(serverId: string): string | undefined {
  const base = serverBaseIndex.get(serverId);
  if (base && !getApiBases().includes(base)) { serverBaseIndex.delete(serverId); return undefined; }
  return base;
}


/** 把后端时长参数收敛到受支持的档位，避免 400。 */
export function normalizeHistoryHours(hours: number): number {
  if (!Number.isFinite(hours) || hours <= 0) return 24;
  let closest = HISTORY_HOURS_OPTIONS[0] as number;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const option of HISTORY_HOURS_OPTIONS) {
    const delta = Math.abs(option - hours);
    if (delta < bestDelta) {
      bestDelta = delta;
      closest = option;
    }
  }
  return closest;
}

/* ------------------------------------------------------------------ *
 * 站点配置
 * ------------------------------------------------------------------ */

export async function getSiteConfig(options?: RequestOptions) {
  return cfsmGet("/api/config", SiteConfigSchema, options);
}

/** `POST /api/theme_options` 的响应体（`{ success, theme_options, message }`）。 */
const ThemeOptionsSaveSchema = z
  .object({
    success: z.boolean().default(true),
    theme_options: z.record(z.string(), z.unknown()).default({}),
    message: z.string().catch(""),
  })
  .passthrough();

/**
 * 把第三方主题配置写到站点级（后端 `appearance_options.theme_options`）。
 *
 * 后端 2.1.1 专门给第三方主题开的写入口：只更新 theme_options，不碰 site_options，也不覆盖
 * 站点标题 / 背景图 / CSP / 自定义脚本等其它外观设置。仅登录站长可用（需 Bearer JWT，
 * 站点开了全局验证时还需 Turnstile 凭证，两者都由 http 层从 localStorage 复用）。这条替代了
 * 「复制 JSON → 手动粘到后台『外观设置 → 主题自定义配置』」的老路；访客配置仍只进 localStorage。
 *
 * body 里的 `themeOptions` 必须是非数组对象，否则后端返回 `400 invalidThemeOptionsFormat`
 * —— 调用方（设置页）传的是归一化白名单 + 配色的快照，天然满足。
 */
export async function saveThemeOptions(
  themeOptions: Record<string, unknown>,
  options?: RequestOptions,
) {
  return cfsmPost(
    "/api/theme_options",
    { theme_options: themeOptions },
    ThemeOptionsSaveSchema,
    options,
  );
}

/**
 * 站点配置的展示模型。CF-Server-Monitor 没有站点简介字段，描述留空。
 */
export async function getPublic(options?: RequestOptions): Promise<PublicConfig> {
  const config = await getSiteConfig(options);
  return {
    sitename: config.site_title,
    description: "",
    version: config.version,
    latestVersion: config.last_workers_version,
    private_site: !config.is_public,
    turnstile_enabled: config.turnstile_enabled,
    turnstile_site_key: config.turnstile_site_key,
    verified: config.verified,
    // 第三方主题的自定义配置是只读的，只作为主题设置的默认值来源。
    theme_settings: config.theme_options,
    latencyWindow: config.latency_window,
    frontendWsTimeoutMinutes: config.frontend_ws_timeout_minutes,
    preferredAppearance: resolvePreferredAppearance(config.preferred_theme),
    // 线路名可由站长在后端改；老后端不下发这几个字段，逐条回退到主题默认名。
    // 后四条（2.8.5 Beta4 新增）的键名风格和前四条不一样，是 node_N_name。
    carrierNames: resolveCarrierNames({
      ct: config.custom_ct_name,
      cu: config.custom_cu_name,
      cm: config.custom_cm_name,
      bd: config.custom_bd_name,
      node_1: config.node_1_name,
      node_2: config.node_2_name,
      node_3: config.node_3_name,
      node_4: config.node_4_name,
    }),
    sys: {
      show_price: true,
      show_expire: true,
      show_tf: true,
      show_time: true,
      long_history_points: config.long_history_points,
    } as SysConfig,
  };
}

/**
 * CF-Server-Monitor 没有 `/api/me`：登录态由 `/api/config` 的 `authorization` 决定，
 * 令牌本身存在 localStorage 里由 `/admin` 登录时写入。
 */
export async function getMe(options?: RequestOptions): Promise<Me> {
  if (!getJwtToken()) {
    return { logged_in: false, username: "", uuid: "" };
  }
  const config = await getSiteConfig(options);
  return {
    logged_in: config.authorization,
    username: config.authorization ? "admin" : "",
    uuid: "",
  };
}

/* ------------------------------------------------------------------ *
 * 服务器列表
 * ------------------------------------------------------------------ */

export interface ServersSnapshot {
  servers: CfsmServer[];
  /** serverId → 所属后端，供 WebSocket 与详情请求分流。 */
  baseByServerId: Map<string, string>;
  sysConfig: SysConfig;
  regionStats: Record<string, number>;
  stats: AggregatedStats;
  /** 至少有一个后端成功返回。 */
  partial: boolean;
}

export interface AggregatedStats {
  total: number;
  online: number;
  offline: number;
  globalSpeedIn: number;
  globalSpeedOut: number;
  globalNetTx: number;
  globalNetRx: number;
}

const STATS_KEYS = [
  "total",
  "online",
  "offline",
  "globalSpeedIn",
  "globalSpeedOut",
  "globalNetTx",
  "globalNetRx",
] as const;

function emptyStats(): AggregatedStats {
  return {
    total: 0,
    online: 0,
    offline: 0,
    globalSpeedIn: 0,
    globalSpeedOut: 0,
    globalNetTx: 0,
    globalNetRx: 0,
  };
}

interface BaseServersResult {
  base: string;
  data?: z.output<typeof ServersResponseSchema>;
  error?: unknown;
}

/**
 * 按 `bases` 顺序合并已 settle 的后端结果。
 *
 * 纯函数：同一份 settled 数组重复调用得到同一份快照，所以既能用于「分阶段交付」的中间
 * 快照，也能用于最终快照。未 settle 的槽位（undefined）按「这一站还没有结果」处理，
 * 只影响 `partial` 标记。
 */
function mergeServersSnapshot(
  bases: readonly string[],
  settled: ReadonlyArray<BaseServersResult | undefined>,
): ServersSnapshot {
  const servers: CfsmServer[] = [];
  const baseByServerId = new Map<string, string>();
  const regionStats: Record<string, number> = {};
  const stats = emptyStats();
  let sysConfig: SysConfig | null = null;
  let duplicated = false;
  let succeeded = 0;

  for (const result of settled) {
    if (!result?.data) continue;
    succeeded += 1;

    const seen = new Set<string>();
    for (const server of result.data.servers) {
      // 同一 ID 在多站同时出现时以第一个站为准，避免重复卡片。
      if (!server.id) continue;
      if (seen.has(server.id) || baseByServerId.has(server.id)) { duplicated = true; continue; }
      seen.add(server.id);
      baseByServerId.set(server.id, result.base);
      servers.push(server);
    }


    for (const [region, count] of Object.entries(result.data.regionStats)) {
      regionStats[region] = (regionStats[region] ?? 0) + Number(count ?? 0);
    }
    for (const key of STATS_KEYS) {
      stats[key] += Number(result.data.stats[key] ?? 0);
    }
    // 站点开关取第一个成功站点的配置。
    sysConfig ??= result.data.sysConfig;
  }

  // Without collisions preserve backend statistics (which may include hidden nodes).
  // With collisions use the same retained nodes as the cards for every aggregate.
  if (duplicated) {
    for (const key of Object.keys(regionStats)) delete regionStats[key];
    Object.assign(stats, emptyStats());
    const now = Date.now();
    for (const server of servers) {
      const online = isServerOnline(server, now);
      stats.total += 1;
      stats[online ? "online" : "offline"] += 1;
      if (online) {
        stats.globalSpeedIn += server.net_in_speed;
        stats.globalSpeedOut += server.net_out_speed;
      }
      stats.globalNetTx += server.net_tx;
      stats.globalNetRx += server.net_rx;
      if (server.region) regionStats[server.region] = (regionStats[server.region] ?? 0) + 1;
    }
  }

  serverBaseIndex.clear();
  for (const [id, base] of baseByServerId) serverBaseIndex.set(id, base);

  return {
    servers,
    baseByServerId,
    sysConfig: sysConfig ?? ({} as SysConfig),
    regionStats,
    stats,
    partial: succeeded < bases.length,
  };
}

export interface ServersSnapshotOptions extends Omit<RequestOptions, "base"> {
  refreshBases?: readonly string[];
  /**
   * 每有一个后端返回就重新合并并回调一次，用于「首屏不必等最慢的站点」。
   *
   * 中间快照的 `baseByServerId` 只增不减（未返回的站点不产出节点），所以调用方可以安全地
   * 直接把它当最终快照用。**只在冷启动（本地还没有任何节点）时消费它** —— 热刷新时节点
   * 会先消失再出现，卡片闪烁，得不偿失。
   *
   * 回调抛错会被吞掉：进度通知失败不该影响取数。
   */
  onSnapshot?: (snapshot: ServersSnapshot) => void;
}

/**
 * 拉取全部后端的服务器列表并合并。多站部署下单站失败不阻塞其它站，
 * 但全部失败时抛出第一个错误，让上层进入错误态而不是渲染空列表。
 */
const serverSnapshots = new Map<string, z.output<typeof ServersResponseSchema>>();

export async function getServersSnapshot(
  options?: ServersSnapshotOptions,
): Promise<ServersSnapshot> {
  const { refreshBases, onSnapshot, ...requestOptions } = options ?? {};
  const bases = getApiBases();
  for (const base of serverSnapshots.keys()) {
    if (!bases.includes(base)) serverSnapshots.delete(base);
  }
  const refresh = refreshBases ? new Set(refreshBases) : null;

  // 按 bases 索引回填：跨站去重顺序必须与 getApiBases() 一致，不能用完成顺序。
  const settled = new Array<BaseServersResult | undefined>(bases.length);
  let succeeded = 0;
  let firstError: unknown = null;

  const collect = (index: number, result: BaseServersResult) => {
    settled[index] = result;
    if (result.data) succeeded += 1;
    else firstError ??= result.error;

    // 已经有过成功站点就不再等别人：先把手上这份交付出去。
    if (succeeded === 0 || !onSnapshot) return;
    try {
      onSnapshot(mergeServersSnapshot(bases, settled));
    } catch (error) {
      console.warn("[LuminaPlus] getServersSnapshot onSnapshot 回调抛错，已忽略：", error);
    }
  };

  await Promise.all(bases.map(async (base, index) => {
    const cached = serverSnapshots.get(base);
    if (refresh && !refresh.has(base) && cached) {
      collect(index, { base, data: cached, error: undefined });
      return;
    }
    try {
      const data = await cfsmGet("/api/servers", ServersResponseSchema, { ...requestOptions, base });
      serverSnapshots.set(base, data);
      collect(index, { base, data, error: undefined });
    } catch (error) {
      serverSnapshots.delete(base);
      collect(index, { base, data: undefined, error });
    }
  }));

  if (succeeded === 0) {
    throw firstError instanceof Error
      ? firstError
      : new Error("All API bases failed to return /api/servers");
  }

  return mergeServersSnapshot(bases, settled);
}

/**
 * 一次性的节点静态信息列表。设置页等只需要 meta 的场景用它，
 * 而不是启动常驻实时 store。
 */
export async function getNodes(
  options?: Omit<RequestOptions, "base">,
): Promise<NodeInfo[]> {
  const snapshot = await getServersSnapshot(options);
  return snapshot.servers
    .map(toNodeInfo)
    .sort((left, right) => left.weight - right.weight);
}

/** 单台服务器详情。带 `latestReportUpdates`，主题目前只用其中的服务器字段。 */
export async function getServerDetail(
  serverId: string,
  options?: RequestOptions,
): Promise<CfsmServer> {
  return cfsmGet(
    `/api/server?${new URLSearchParams({ id: serverId })}`,
    CfsmServerSchema,
    { ...options, base: options?.base ?? getServerApiBase(serverId) },
  );
}

/* ------------------------------------------------------------------ *
 * 历史指标
 * ------------------------------------------------------------------ */

/**
 * `/api/history/all` 的顶层校验。
 *
 * 必须真的是数组。旧实现写的是 `z.array(HistoryRowSchema).catch([])` —— 一行不合法或结构
 * 变了，整批静默变成空数组，页面只是一片空白，用户和监控都分不出「接口坏了」和「这段时间
 * 确实没数据」。顶层严格校验后，整批格式错会以 `Schema mismatch` 抛给调用方。
 */
const HistoryResponseSchema = z.array(z.unknown());

export interface ParsedHistoryRows {
  rows: HistoryRow[];
  /** 被逐行校验拒绝的行数。 */
  dropped: number;
}

/** 逐行校验：单行坏掉只丢这一行，并回报丢弃数量。 */
export function parseHistoryRows(payload: unknown[]): ParsedHistoryRows {
  const rows: HistoryRow[] = [];
  let dropped = 0;
  for (const raw of payload) {
    const parsed = HistoryRowSchema.safeParse(raw);
    if (parsed.success) rows.push(parsed.data);
    else dropped += 1;
  }
  return { rows, dropped };
}

async function requestHistoryRows(
  serverId: string,
  hours: number,
  options?: RequestOptions,
): Promise<HistoryRow[]> {
  const params = new URLSearchParams({
    id: serverId,
    hours: String(hours),
  });
  const payload = await cfsmGet(`/api/history/all?${params}`, HistoryResponseSchema, {
    ...options,
    base: options?.base ?? getServerApiBase(serverId),
  });

  const { rows, dropped } = parseHistoryRows(payload);
  if (dropped > 0) {
    if (rows.length === 0) {
      // 整批都不认识：这是接口契约变了，不是「没有历史」。抛出去让上层进错误态。
      throw new Error(
        `Schema mismatch on /api/history/all: 0 of ${dropped} rows accepted for ${serverId}`,
      );
    }
    // 诊断只报数量，不打业务 payload。
    warnDegradedOnce(
      `history-rows:${serverId}`,
      `节点 ${serverId} 的历史数据有 ${dropped} 行格式不符，已丢弃。`,
    );
  }

  // 后端按时间倒序或正序都可能，图表要求升序。
  return [...rows].sort((left, right) => left.timestamp - right.timestamp);
}

/**
 * 历史查询的短期缓存。
 *
 * CF-Server-Monitor 没有批量历史接口，一台节点一次请求；而首页 Ping 概览会为四条线路
 * 分别取数据。缓存让同一节点同一时长的并发/连续请求只打一次后端。
 */
const HISTORY_CACHE_TTL_MS = 20_000;
/**
 * 条数上限。`(后端, 节点, 时长)` 组合随节点数和时长档位相乘增长，长会话里遍历一遍所有
 * 节点 + 所有档位就能把每个数组（最多 168 小时 × 采样点）留在 Map 里到页面关闭。
 */
const HISTORY_CACHE_MAX_ENTRIES = 64;

interface HistoryCacheEntry {
  fetchedAt: number;
  rows: HistoryRow[];
}

const historyCache = new Map<string, HistoryCacheEntry>();
const historyInFlight = new Map<string, Promise<HistoryRow[]>>();
/** 每次清缓存自增；在途请求只有代次没变时才允许回写。 */
let historyCacheGeneration = 0;

function historyCacheKey(base: string, serverId: string, hours: number) {
  return JSON.stringify([base, serverId, hours]);
}

/**
 * 回收过期条目（TTL 只管命中与否，不删就会一直占内存），再按 LRU 截断到上限。
 * Map 的迭代顺序即插入顺序，命中时重新 set 一次就把它挪到队尾。
 */
function pruneHistoryCache(now: number): void {
  for (const [key, entry] of historyCache) {
    if (now - entry.fetchedAt >= HISTORY_CACHE_TTL_MS) historyCache.delete(key);
  }
  while (historyCache.size > HISTORY_CACHE_MAX_ENTRIES) {
    const oldest = historyCache.keys().next();
    if (oldest.done) break;
    historyCache.delete(oldest.value);
  }
}

function writeHistoryCache(key: string, entry: HistoryCacheEntry, now: number): void {
  historyCache.delete(key);
  historyCache.set(key, entry);
  pruneHistoryCache(now);
}

export function clearHistoryCache(): void {
  historyCacheGeneration += 1;
  historyCache.clear();
  historyInFlight.clear();
}

/** 测试与诊断用：当前缓存的条目数。 */
export function getHistoryCacheSize(): number {
  return historyCache.size;
}

/**
 * 详情页查回来的历史，顺手回灌首页延迟条的缓冲区。
 *
 * 首页自己不许查历史（逐节点查会让后端 D1 读行翻几十倍，见 README 的硬约束），但用户主动
 * 点开详情页时这份数据已经在手上了 —— 白扔可惜：`/api/servers` 的窗口是向后填充出来的，
 * 而这里是原始采样，看过的节点首页那一小时就能用真数据。缓冲区只留一小时，更早的会被丢掉。
 */
function backfillPingBuffer(serverId: string, rows: HistoryRow[]): void {
  if (rows.length === 0) return;
  seedMeasuredHistory(serverId, historyRowsToPingSamples(rows));
}

async function fetchHistoryRows(
  serverId: string,
  hours: number,
  options?: RequestOptions & { cache?: boolean },
): Promise<HistoryRow[]> {
  const normalizedHours = normalizeHistoryHours(hours);
  if (options?.cache === false) {
    const rows = await requestHistoryRows(serverId, normalizedHours, options);
    backfillPingBuffer(serverId, rows);
    return rows;
  }

  const base = validateApiBase(options?.base ?? getServerApiBase(serverId) ?? getPrimaryApiBase());
  const key = historyCacheKey(base, serverId, normalizedHours);
  const cached = historyCache.get(key);
  if (cached) {
    if (Date.now() - cached.fetchedAt < HISTORY_CACHE_TTL_MS) {
      // 命中即最近使用。
      writeHistoryCache(key, cached, Date.now());
      return cached.rows;
    }
    historyCache.delete(key);
  }

  const inFlight = historyInFlight.get(key);
  // 复用在途请求时不能沿用调用方的 signal，否则一个组件卸载会取消所有等待者。
  if (inFlight) return inFlight;

  // 记下发起时的代次：期间若清过缓存，旧结果不许回写，否则会把上一代的数据灌进新缓存。
  const generation = historyCacheGeneration;
  const request = requestHistoryRows(serverId, normalizedHours, {
    ...options,
    signal: undefined,
    base,
  })
    .then((rows) => {
      if (generation === historyCacheGeneration) {
        writeHistoryCache(key, { fetchedAt: Date.now(), rows }, Date.now());
      }
      backfillPingBuffer(serverId, rows);
      return rows;
    })
    .finally(() => {
      // 只删自己：期间可能已经有更新的在途请求占住了同一个 key。
      if (historyInFlight.get(key) === request) historyInFlight.delete(key);
    });
  historyInFlight.set(key, request);
  return request;
}

/** 手动刷新首页延迟条时的并发上限：节点多的站点别一次把请求全打出去。 */
const PING_HISTORY_REFRESH_CONCURRENCY = 4;
/** 手动刷新只拉一小时：首页延迟条本来就只画一小时，多拉的行是白读。 */
const PING_HISTORY_REFRESH_HOURS = 1;

export interface PingHistoryRefreshResult {
  requested: number;
  succeeded: number;
  failed: number;
}

/**
 * 手动刷新首页延迟条：逐台拉一小时历史回灌本地缓冲。
 *
 * **这是首页唯一允许发起 `/api/history/all` 的入口，且只能由用户点击触发。**
 * 自动轮询仍然禁止 —— 读行量差 60 倍：按线上实测（7 台、上报间隔 30/60 秒）点一次约 780 行，
 * 而每分钟自动拉一次是每小时 4.7 万行。后端对 1 小时档有 60 秒服务端缓存（响应带 `X-Cache`），
 * 连点几下不会真的重复读库。
 *
 * 效果等同于「把每台节点的详情页都点开一遍」：走的是同一个 `fetchHistoryRows` →
 * `backfillPingBuffer` 通道，不是另一套取数逻辑。
 *
 * 绕开前端那 20 秒缓存（`cache: false`）—— 用户按刷新就是想要新的，拿缓存糊弄没有意义。
 */
export async function refreshPingHistory(
  serverIds: readonly string[],
  options?: RequestOptions,
): Promise<PingHistoryRefreshResult> {
  const ids = [...new Set(serverIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return { requested: 0, succeeded: 0, failed: 0 };

  let cursor = 0;
  let succeeded = 0;
  let failed = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const serverId = ids[index];
      if (serverId === undefined) return;
      try {
        await fetchHistoryRows(serverId, PING_HISTORY_REFRESH_HOURS, {
          ...options,
          cache: false,
        });
        succeeded += 1;
      } catch {
        // 单台失败不该拖垮整批：某台节点历史查不到（刚加入、分区 id 没建好）时，
        // 其余节点照常回灌。
        failed += 1;
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(PING_HISTORY_REFRESH_CONCURRENCY, ids.length) },
      () => worker(),
    ),
  );

  return { requested: ids.length, succeeded, failed };
}

export async function getLoadRecords(
  uuid: string,
  hours = 6,
  options?: RequestOptions,
): Promise<LoadRecordsResponse> {
  const rows = await fetchHistoryRows(uuid, hours, options);
  const records = rows.map((row) => historyRowToLoadRecord(row, uuid));
  const times = records.map((record) => record.time);
  const rangeEndMs = Date.now();
  return {
    count: records.length,
    records,
    rangeStartMs: rangeEndMs - normalizeHistoryHours(hours) * 60 * 60 * 1000,
    rangeEndMs,
    intervalSeconds: inferIntervalSeconds(times),
  };
}

/**
 * Ping 历史。CF-Server-Monitor 的探测点固定为电信/联通/移动/BD 四条线路，
 * 数据与负载共用同一张历史表，因此这里复用同一个请求形状。
 */
export async function getPingRecords(
  uuid: string,
  hours = 6,
  options?: RequestOptions,
): Promise<PingRecordsResponse> {
  const rows = await fetchHistoryRows(uuid, hours, options);
  const records = historyRowsToPingRecords(rows, uuid);
  const rangeEndMs = Date.now();
  const observed = new Set(records.map((record) => record.task_id));
  const tasks = carrierPingTasks().filter((task) => observed.has(task.id));

  return {
    count: records.length,
    records,
    tasks: tasks.length > 0 ? tasks : carrierPingTasks(),
    intervalSeconds: inferIntervalSeconds(rows.map((row) => row.timestamp)),
    rangeStartMs: rangeEndMs - normalizeHistoryHours(hours) * 60 * 60 * 1000,
    rangeEndMs,
    stats: buildPingStats(records, uuid),
  };
}

function buildPingStats(
  records: PingRecordsResponse["records"],
  client: string,
): PingTaskStats[] {
  const byTask = new Map<number, number[]>();
  const lossByTask = new Map<number, { lost: number; total: number }>();

  for (const record of records) {
    const values = byTask.get(record.task_id) ?? [];
    values.push(record.value);
    byTask.set(record.task_id, values);

    const loss = lossByTask.get(record.task_id) ?? { lost: 0, total: 0 };
    loss.total += 1;
    if (typeof record.loss === "number" && record.loss > 0) {
      loss.lost += record.loss / 100;
    }
    lossByTask.set(record.task_id, loss);
  }

  return CARRIER_TASKS.filter((task) => byTask.has(task.id)).map((task) => {
    const values = [...(byTask.get(task.id) ?? [])].sort((a, b) => a - b);
    const loss = lossByTask.get(task.id) ?? { lost: 0, total: 0 };
    const sum = values.reduce((acc, value) => acc + value, 0);
    const avg = values.length > 0 ? sum / values.length : null;
    const p50 = percentile(values, 0.5);
    const p99 = percentile(values, 0.99);
    const variance =
      values.length > 1 && avg != null
        ? values.reduce((acc, value) => acc + (value - avg) ** 2, 0) / (values.length - 1)
        : 0;

    return {
      client,
      taskId: task.id,
      name: task.name,
      type: "icmp",
      interval: 60,
      total: loss.total,
      valid: values.length,
      loss: loss.total > 0 ? (loss.lost / loss.total) * 100 : 0,
      min: values[0] ?? null,
      max: values[values.length - 1] ?? null,
      avg,
      latest: values.length > 0 ? (byTask.get(task.id)!.at(-1) ?? null) : null,
      p50,
      p99,
      stddev: Math.sqrt(variance),
      p99P50Ratio: p50 && p99 ? p99 / p50 : 0,
    };
  });
}

function percentile(sortedValues: number[], fraction: number): number | null {
  if (sortedValues.length === 0) return null;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.round(fraction * (sortedValues.length - 1))),
  );
  return sortedValues[index] ?? null;
}

/** 今日流量：由历史里的上/下行速率按采样间隔积分近似得到。 */
