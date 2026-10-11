import assert from 'node:assert/strict'
import test from 'node:test'

import { createServer } from 'vite'

class FakeWebSocket {
  static instances = []

  constructor(url) {
    this.url = url
    this.listeners = new Map()
    this.sent = []
    this.closeCalls = []
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(handler)
  }

  emit(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) handler(event)
  }

  send(message) {
    this.sent.push(message)
  }

  close(code, reason = '') {
    this.closeCalls.push({ code, reason })
    this.emit('close', { code, reason })
  }
}

test('frontend WebSocket closes at its lifetime limit without reconnecting', async () => {
  const vite = await createServer({
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true }
  })
  const { createLiveSocket, normalizeLiveSocketTimeoutMinutes } = await vite.ssrLoadModule('/src/frontend/utils/api.js')
  const originalWindow = globalThis.window
  const originalLocalStorage = globalThis.localStorage
  const originalWebSocket = globalThis.WebSocket
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout

  globalThis.window = {
    location: {
      origin: 'https://example.com',
      protocol: 'https:',
      host: 'example.com'
    }
  }
  globalThis.localStorage = { getItem: () => '' }
  globalThis.WebSocket = FakeWebSocket
  const timers = []
  globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false }
    timers.push(timer)
    return timer
  }
  globalThis.clearTimeout = timer => {
    if (timer) timer.cleared = true
  }
  FakeWebSocket.instances = []

  let liveSocket = null
  let unlimitedSocket = null
  try {
    const statuses = []
    const timeouts = []
    liveSocket = createLiveSocket('all', {
      timeoutMinutes: 1,
      onStatus: status => statuses.push(status),
      onTimeout: timeout => timeouts.push(timeout)
    }, 0, ['server-1'])

    const socket = FakeWebSocket.instances[0]
    socket.emit('open')
    assert.equal(timers.length, 1)
    assert.equal(timers[0].delay, 60 * 1000)
    timers[0].callback()

    assert.deepEqual(socket.closeCalls, [{
      code: 1000,
      reason: 'connection lifetime exceeded'
    }])
    assert.equal(FakeWebSocket.instances.length, 1)
    assert.equal(liveSocket.isConnected, false)
    assert.deepEqual(timeouts, [{ durationMs: 60 * 1000 }])
    assert.deepEqual(statuses.at(-1), {
      connected: false,
      reason: 'connection lifetime exceeded'
    })

    unlimitedSocket = createLiveSocket('all')
    const unlimitedWebSocket = FakeWebSocket.instances[1]
    unlimitedWebSocket.emit('open')
    assert.equal(timers.length, 1)
    assert.deepEqual(unlimitedWebSocket.closeCalls, [])
    assert.equal(normalizeLiveSocketTimeoutMinutes(0), 0)
    assert.equal(normalizeLiveSocketTimeoutMinutes(20), 20)
    assert.equal(normalizeLiveSocketTimeoutMinutes(-1), 0)
    assert.equal(normalizeLiveSocketTimeoutMinutes(1441), 0)
  } finally {
    liveSocket?.close()
    unlimitedSocket?.close()
    globalThis.window = originalWindow
    globalThis.localStorage = originalLocalStorage
    globalThis.WebSocket = originalWebSocket
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    await vite.close()
  }
})

test('cross-origin Vue sockets exchange JWT for a ticket and ignore stale ticket responses', async () => {
  const vite = await createServer({ configFile: false, appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  const { createLiveSocket } = await vite.ssrLoadModule('/src/frontend/utils/api.js')
  const originals = Object.fromEntries(['window', 'localStorage', 'WebSocket', 'fetch', 'setTimeout', 'clearTimeout'].map(key => [key, globalThis[key]]))
  const requests = []
  const timers = []
  const clients = []
  globalThis.window = { location: { origin: 'https://ui.invalid', protocol: 'https:', host: 'ui.invalid' },
    __APP_API_BASES__: ['https://first.invalid', 'https://second.invalid'] }
  globalThis.localStorage = { getItem: key => key === 'jwt_token' ? 'long-lived-jwt' : '', removeItem() {} }
  globalThis.WebSocket = FakeWebSocket
  globalThis.fetch = (url, init) => new Promise(resolve => requests.push({ url, init, resolve }))
  globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false }
    timers.push(timer)
    return timer
  }
  globalThis.clearTimeout = timer => { if (timer) timer.cleared = true }
  const settle = () => new Promise(resolve => setImmediate(resolve))
  FakeWebSocket.instances = []
  try {
    const live = createLiveSocket('all', {}, 1, ['node'])
    clients.push(live)
    assert.equal(requests[0].url, 'https://second.invalid/api/ws-ticket')
    assert.equal(requests[0].init.headers.Authorization, 'Bearer long-lived-jwt')
    requests[0].resolve(new Response(JSON.stringify({ ticket: 'short-lived-ticket' })))
    await settle()
    const url = new URL(FakeWebSocket.instances[0].url)
    assert.equal(url.host, 'second.invalid')
    assert.equal(url.searchParams.get('ticket'), 'short-lived-ticket')
    assert.equal(url.searchParams.has('token'), false)
    assert.equal(url.toString().includes('long-lived-jwt'), false)
    live.close()

    const closed = createLiveSocket('all', {}, 1)
    clients.push(closed)
    closed.close()
    requests[1].resolve(new Response(JSON.stringify({ ticket: 'ignored-ticket' })))
    await settle()
    assert.equal(FakeWebSocket.instances.length, 1)

    const reconnected = createLiveSocket('all', {}, 1)
    clients.push(reconnected)
    reconnected.reconnect()
    requests[3].resolve(new Response(JSON.stringify({ ticket: 'new-ticket' })))
    await settle()
    requests[2].resolve(new Response(JSON.stringify({ ticket: 'stale-ticket' })))
    await settle()
    assert.equal(FakeWebSocket.instances.length, 2)
    const current = FakeWebSocket.instances[1]
    assert.equal(new URL(current.url).searchParams.get('ticket'), 'new-ticket')
    current.emit('close')
    const reconnectTimer = timers.findLast(timer => !timer.cleared)
    reconnected.close()
    assert.equal(reconnectTimer.cleared, true)
    reconnectTimer.callback() // Even an already queued callback cannot reopen a closed client.
    await settle()
    assert.equal(requests.length, 4)
    assert.equal(FakeWebSocket.instances.length, 2)
  } finally {
    clients.forEach(client => client.close())
    for (const [key, value] of Object.entries(originals)) globalThis[key] = value
    await vite.close()
  }
})
