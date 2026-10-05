const ALGORITHM = { name: 'HMAC', hash: 'SHA-256' };
import { verifyPasswordHash } from '../utils/common.js';
import { isValidJwtSecret } from '../utils/settings.js';

export const AUTH_COOKIE_NAME = 'cfsm_auth';

/**
 * WebSocket 连接票据。
 *
 * 原生 WebSocket 没法带 Authorization 头，所以跨域私有站点过去只能把长期管理员 JWT 塞进
 * 查询串 —— 那个 URL 会进浏览器历史、反代日志、追踪系统。现在改成：
 * 先 `POST /api/ws-ticket`（走正常鉴权）换一张 **60 秒有效、只能用于 /api/ws、且只用一次**
 * 的票据，再拿它去建连。泄露出去的窗口从 7 天缩到 60 秒。
 */
export const WS_TICKET_QUERY_KEY = 'ticket';
export const WS_TICKET_PURPOSE = 'ws';
export const WS_TICKET_TTL_SECONDS = 60;

async function generateKeyFromSecret(secret) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  return await crypto.subtle.importKey('raw', keyData, ALGORITHM, false, ['sign', 'verify']);
}

async function signJwt(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = btoa(JSON.stringify(header)).replace(/=/g, '');
  const encodedPayload = btoa(JSON.stringify(payload)).replace(/=/g, '');
  
  const data = `${encodedHeader}.${encodedPayload}`;
  const key = await generateKeyFromSecret(secret);
  
  const encoder = new TextEncoder();
  const dataBytes = encoder.encode(data);
  const signature = await crypto.subtle.sign(ALGORITHM, key, dataBytes);
  
  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, '');
  
  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

async function verifyJwt(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }
    
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    
    const key = await generateKeyFromSecret(secret);
    
    const data = `${encodedHeader}.${encodedPayload}`;
    const encoder = new TextEncoder();
    const dataBytes = encoder.encode(data);
    
    const signatureBytes = new Uint8Array(atob(encodedSignature).split('').map(c => c.charCodeAt(0)));
    
    const isValid = await crypto.subtle.verify(ALGORITHM, key, signatureBytes, dataBytes);
    
    if (!isValid) {
      return null;
    }
    
    const payload = JSON.parse(atob(encodedPayload));
    
    if (payload.exp && Date.now() > payload.exp * 1000) {
      return null;
    }
    
    return payload;
  } catch (e) {
    console.error('JWT verification error:', e);
    return null;
  }
}

function getJwtSecret(env, sys) {
  if (isValidJwtSecret(sys?.jwt_secret)) {
    return sys.jwt_secret;
  }

  const fallback = env.API_SECRET || 'default_jwt_secret_for_server_monitor';
  return fallback.padEnd(32, 'x').substring(0, 64);
}

function getCookieValue(request, name) {
  const cookie = request?.headers?.get('Cookie') || '';
  const prefix = `${name}=`;
  for (const part of cookie.split(';')) {
    const item = part.trim();
    if (!item.startsWith(prefix)) continue;
    try {
      return decodeURIComponent(item.slice(prefix.length));
    } catch (_) {
      return item.slice(prefix.length);
    }
  }
  return '';
}

function extractBearerToken(request) {
  const authHeader = request?.headers?.get('Authorization') || '';
  const parts = authHeader.trim().split(/\s+/);
  return parts[0] === 'Bearer' && parts[1] ? parts[1] : '';
}

async function verifyToken(token, env, sys) {
  if (!token) return false;
  const secret = getJwtSecret(env, sys);

  try {
    const payload = await verifyJwt(token, secret);
    return payload?.sub === 'admin' && payload.purpose === undefined;
  } catch (e) {
    console.error('Auth check error:', e);
    return false;
  }
}

export async function generateToken(env, sys) {
  const payload = {
    sub: 'admin',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 604800
  };

  const secret = getJwtSecret(env, sys);
  return signJwt(payload, secret);
}

export async function checkAuth(request, env, sys) {
  if (await verifyToken(extractBearerToken(request), env, sys)) {
    return true;
  }
  return verifyToken(getCookieValue(request, AUTH_COOKIE_NAME), env, sys);
}

function randomTicketId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 签一张短期连接票据。调用方必须先确认请求已通过正常鉴权。 */
export async function createWsTicket(env, sys) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    purpose: WS_TICKET_PURPOSE,
    jti: randomTicketId(),
    iat: now,
    exp: now + WS_TICKET_TTL_SECONDS
  };
  const secret = getJwtSecret(env, sys);
  return {
    ticket: await signJwt(payload, secret),
    expires_in: WS_TICKET_TTL_SECONDS
  };
}

/**
 * 校验票据签名、有效期与用途。**不判断是否已用过** —— 那一步要做一次性登记，
 * 见 `consumeWsTicket`。用途限定是必须的：否则一张票据就等于一段可复用的短期管理员令牌。
 */
export async function verifyWsTicket(ticket, env, sys) {
  if (!ticket || typeof ticket !== 'string') return null;
  const secret = getJwtSecret(env, sys);
  const payload = await verifyJwt(ticket, secret);
  if (!payload || payload.purpose !== WS_TICKET_PURPOSE) return null;
  if (typeof payload.jti !== 'string' || payload.jti.length === 0) return null;
  return payload;
}

export function readWsTicket(request) {
  try {
    return new URL(request.url).searchParams.get(WS_TICKET_QUERY_KEY) || '';
  } catch (_) {
    return '';
  }
}

/**
 * 一次性消费登记。登记在全局唯一的 MetricsBroadcaster DO 上，重放返回 409。
 *
 * 消费登记不可用时拒绝票据，避免无法保证一次性的凭证被重复使用。
 * 同源 Cookie / Bearer 登录仍可使用。
 */
async function consumeWsTicket(env, payload) {
  if (!env?.METRICS_BROADCASTER) return false;
  try {
    const id = env.METRICS_BROADCASTER.idFromName('global');
    const stub = env.METRICS_BROADCASTER.get(id);
    const response = await stub.fetch('http://internal/ws-ticket/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jti: payload.jti, exp: payload.exp })
    });
    if (response.status === 409) return false;
    if (!response.ok) {
      console.warn(`[ws-ticket] consume returned ${response.status}, rejecting ticket`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[ws-ticket] consume failed, rejecting ticket:', e?.message || e);
    return false;
  }
}

/**
 * `/api/ws` 的鉴权：同源 Cookie（正常情况）、Bearer（用于不走 Cookie 的场景），
 * 或者一张有效的短期一次性票据。**不再接受任何查询串里的长期 JWT。**
 */
export async function checkWebSocketAuth(request, env, sys) {
  if (await checkAuth(request, env, sys)) {
    return true;
  }

  const payload = await verifyWsTicket(readWsTicket(request), env, sys);
  if (!payload) return false;
  return consumeWsTicket(env, payload);
}

export function buildAuthCookie(request, token, maxAge = 604800) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${AUTH_COOKIE_NAME}=${encodeURIComponent(token || '')}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

export function buildClearAuthCookie(request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${AUTH_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

export async function validateCredentials(request, env, sys) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) {
      return { valid: false, needsPasswordUpgrade: false };
    }

    const parts = authHeader.trim().split(/\s+/);
    const scheme = parts[0];
    const encoded = parts[1];

    if (scheme !== 'Basic' || !encoded) {
      return { valid: false, needsPasswordUpgrade: false };
    }

    let decoded;
    try {
      decoded = atob(encoded);
    } catch (e) {
      return { valid: false, needsPasswordUpgrade: false };
    }

    const idx = decoded.indexOf(':');
    if (idx === -1) {
      return { valid: false, needsPasswordUpgrade: false };
    }

    const username = decoded.slice(0, idx);
    const password = decoded.slice(idx + 1);

    const validUsername = (sys && sys.username && sys.username.length > 0)
      ? sys.username
      : (typeof env.API_USER_NAME === 'string' && env.API_USER_NAME.length > 0)
        ? env.API_USER_NAME
        : 'admin';

    if (sys && sys.password && sys.password.length > 0) {
      if (username !== validUsername) {
        return { valid: false, needsPasswordUpgrade: false };
      }

      const result = await verifyPasswordHash(password, sys.password);
      return {
        valid: result.valid,
        needsPasswordUpgrade: result.needsRehash === true
      };
    }

    const valid = (
      typeof env.API_SECRET === 'string' &&
      env.API_SECRET.length > 0 &&
      username === validUsername &&
      password === env.API_SECRET
    );
    return { valid, needsPasswordUpgrade: false };
  } catch (e) {
    console.error('Credential validation error:', e);
    return { valid: false, needsPasswordUpgrade: false };
  }
}

export function simpleAuthResponse() {
  return new Response(JSON.stringify({ error: 'Unauthorized', code: 401 }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' }
  });
}
