import { z } from "zod";
import { fetchWithTimeout } from "@/utils/abort";
import {
  clearJwtToken,
  clearTurnstileCredentials,
  getApiBases,
  getJwtToken,
  getPrimaryApiBase,
  getTurnstileToken,
  getTurnstileVerified,
  setTurnstileVerified,
  validateApiBase,
} from "@/services/cfsm/config";

// 普通 GET 没有传输超时，half-open socket 会无限挂住调用方，这里统一兜底。
export const DEFAULT_API_TIMEOUT_MS = 12_000;

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
    /** 后端错误体里的业务 code，通常与 status 一致。 */
    public readonly code: number = status,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/** 数据库需要升级（409）时后端返回 `{ message: "databaseUpgradeRequired" }`。 */
export class DatabaseUpgradeRequiredError extends ApiRequestError {
  constructor(path: string) {
    super("databaseUpgradeRequired", 409, path, 409);
    this.name = "DatabaseUpgradeRequiredError";
  }
}

const ErrorBodySchema = z
  .object({
    error: z.string().optional(),
    message: z.string().optional(),
    code: z.union([z.number(), z.string()]).optional(),
  })
  .passthrough();

export interface RequestOptions {
  signal?: AbortSignal;
  timeout?: number;
  /** 指定后端；多站部署时用于把详情/历史请求打到拥有该服务器的站点。 */
  base?: string;
}

function buildHeaders(base: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };

  const token = getJwtToken(base);
  if (token) headers.Authorization = `Bearer ${token}`;

  // 已验证凭证优先；只有还没拿到凭证时才带一次性 token。
  const verified = getTurnstileVerified(base);
  if (verified) {
    headers["X-Turnstile-Verified"] = verified;
  } else {
    const turnstileToken = getTurnstileToken(base);
    if (turnstileToken) headers["X-Turnstile-Token"] = turnstileToken;
  }

  return headers;
}

async function readErrorBody(resp: Response) {
  try {
    const parsed = ErrorBodySchema.safeParse(await resp.json());
    if (!parsed.success) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function captureTurnstileVerified(payload: unknown, base: string): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const value = (payload as Record<string, unknown>).turnstile_verified;
  if (typeof value === "string" && value) setTurnstileVerified(value, base);
}

/**
 * 单个后端的 GET。成功响应直接是业务对象（没有 `{status,data}` 包装），
 * 失败响应是 `{ error, code }`。
 */
export async function cfsmGet<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  options?: RequestOptions,
): Promise<z.output<S>> {
  const base = validateApiBase(options?.base ?? getPrimaryApiBase());
  const url = `${base}${path}`;
  const resp = await fetchWithTimeout(
    url,
    { credentials: "include", redirect: "error", headers: buildHeaders(base) },
    options?.timeout ?? DEFAULT_API_TIMEOUT_MS,
    options?.signal,
  );

  if (!resp.ok) {
    const body = await readErrorBody(resp);
    if (resp.status === 401) {
      // 令牌过期后清掉，让后续请求以访客身份继续；不做跳转 —— 主题不接管登录。
      clearJwtToken(base);
    }
    if (resp.status === 403) {
      clearTurnstileCredentials(base);
    }
    if (resp.status === 409 || body?.message === "databaseUpgradeRequired") {
      throw new DatabaseUpgradeRequiredError(path);
    }
    const code = Number(body?.code);
    throw new ApiRequestError(
      body?.error || body?.message || `Request ${path} failed: ${resp.status}`,
      resp.status,
      path,
      Number.isFinite(code) && code > 0 ? code : resp.status,
    );
  }

  const json = (await resp.json()) as unknown;
  captureTurnstileVerified(json, base);

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `Schema mismatch on ${path}: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return parsed.data;
}

/**
 * 单个后端的 POST。目前唯一的写入口是第三方主题保存自身配置（`POST /api/theme_options`，
 * 仅登录站长可用）—— 与 GET 共用鉴权头（Bearer JWT + Turnstile），额外带 JSON body。
 * 401 清 JWT、403 清 Turnstile 凭证的处理与 cfsmGet 一致，调用方据 status 提示。
 */
export async function cfsmPost<S extends z.ZodTypeAny>(
  path: string,
  body: unknown,
  schema: S,
  options?: RequestOptions,
): Promise<z.output<S>> {
  const base = validateApiBase(options?.base ?? getPrimaryApiBase());
  const url = `${base}${path}`;
  const resp = await fetchWithTimeout(
    url,
    {
      method: "POST",
      redirect: "error",
      credentials: "include",
      headers: { ...buildHeaders(base), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    options?.timeout ?? DEFAULT_API_TIMEOUT_MS,
    options?.signal,
  );

  if (!resp.ok) {
    const errorBody = await readErrorBody(resp);
    if (resp.status === 401) {
      // 令牌过期：清掉，让调用方提示重新登录（写操作没有匿名降级一说）。
      clearJwtToken(base);
    }
    if (resp.status === 403) {
      // Turnstile 凭证失效：清掉，全局 TurnstileGate 会在下次拉 config 时重新弹验证。
      clearTurnstileCredentials(base);
    }
    if (resp.status === 409 || errorBody?.message === "databaseUpgradeRequired") {
      throw new DatabaseUpgradeRequiredError(path);
    }
    const code = Number(errorBody?.code);
    throw new ApiRequestError(
      errorBody?.error || errorBody?.message || `Request ${path} failed: ${resp.status}`,
      resp.status,
      path,
      Number.isFinite(code) && code > 0 ? code : resp.status,
    );
  }

  const json = (await resp.json()) as unknown;
  captureTurnstileVerified(json, base);

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `Schema mismatch on ${path}: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return parsed.data;
}

/**
 * `POST /api/ws-ticket` 的响应体。
 *
 * 原生 WebSocket 带不了 Authorization 头，跨域私有站点过去只能把长期 JWT 放进查询串。
 * 现在改成先换一张 60 秒有效、只能用于 `/api/ws`、且只用一次的票据。
 */
const WsTicketSchema = z.object({
  ticket: z.string().min(1),
  expires_in: z.number().optional(),
});

export interface WsTicket {
  ticket: string;
  expiresIn: number;
}

/** 取一张短期连接票据。失败时抛错，调用方回落到 Cookie 鉴权。 */
export async function requestWsTicket(options?: RequestOptions): Promise<WsTicket> {
  const result = await cfsmPost("/api/ws-ticket", {}, WsTicketSchema, options);
  return { ticket: result.ticket, expiresIn: result.expires_in ?? 60 };
}

export interface MultiBaseResult<T> {
  base: string;
  data?: T;
  error?: unknown;
}

export interface MultiBaseOptions {
  signal?: AbortSignal;
  timeout?: number;
  /**
   * 每有一个后端 settle 就回调一次（按**完成顺序**，不是 `getApiBases()` 顺序）。
   *
   * 有了它调用方才能真正做到「单站失败不阻塞其它站」：现在 `cfsmGetAll` 还是要等全部
   * settle 才返回，但先回来的站点不必陪着最慢的站点一起等超时。回调抛错会被吞掉并
   * 打一条警告，进度通知失败不该让已经发出的请求白费。
   */
  onResult?: (result: MultiBaseResult<unknown>) => void;
}

/**
 * 向所有后端并发发起同一个 GET。单站失败不影响其它站，调用方自行决定如何合并
 * 与如何提示（多站部署下部分站点离线属于常态）。
 *
 * 返回数组与 `getApiBases()` 严格同序 —— 跨站去重依赖这个顺序，所以按索引回填，
 * 不用完成顺序。
 */
export async function cfsmGetAll<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  options?: Omit<RequestOptions, "base"> & MultiBaseOptions,
): Promise<MultiBaseResult<z.output<S>>[]> {
  const { onResult, ...requestOptions } = options ?? {};
  const bases = getApiBases();
  const results = new Array<MultiBaseResult<z.output<S>>>(bases.length);

  const notify = (result: MultiBaseResult<z.output<S>>) => {
    if (!onResult) return;
    try {
      onResult(result);
    } catch (error) {
      console.warn("[LuminaPlus] cfsmGetAll onResult 回调抛错，已忽略：", error);
    }
  };

  await Promise.all(
    bases.map(async (base, index) => {
      let result: MultiBaseResult<z.output<S>>;
      try {
        result = { base, data: await cfsmGet(path, schema, { ...requestOptions, base }) };
      } catch (error) {
        result = { base, error };
      }
      results[index] = result;
      notify(result);
    }),
  );

  return results;
}
