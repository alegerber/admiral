import { describe, it, expect, afterEach } from 'bun:test'
import { McpConnection } from './mcp'
import { McpV2Connection } from './mcp_v2'

type FetchArgs = [input: string | URL, init?: RequestInit]
type FetchReply = { status?: number; headers?: Record<string, string>; body: unknown }

function installFetchMock(replies: FetchReply[]): { calls: FetchArgs[]; restore: () => void } {
  const calls: FetchArgs[] = []
  const original = globalThis.fetch
  let i = 0
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    calls.push([input, init])
    const r = replies[Math.min(i, replies.length - 1)]
    i++
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: r.headers ?? { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

const initOk = {
  body: { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: {} } },
}
const okResult = (id: number) => ({
  body: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] } },
})

describe('McpConnection sendJsonRpc rate-limit handling', () => {
  let mock: ReturnType<typeof installFetchMock>
  afterEach(() => mock?.restore())

  it('retries -32029 on initialize and connects successfully', async () => {
    mock = installFetchMock([
      // initialize returns rate-limited first
      { body: { jsonrpc: '2.0', id: 1, error: { code: -32029, message: 'Rate limited. Try again in 0 seconds.' } } },
      // retry of initialize succeeds
      initOk,
    ])

    const conn = new McpConnection('http://server')
    await conn.connect()
    expect(conn.isConnected()).toBe(true)
    expect(mock.calls.length).toBeGreaterThanOrEqual(2) // at least: 32029 + retry; + notifications/initialized (3 total)
    await conn.disconnect()
  })

  it('retries -32029 on tools/call inside execute', async () => {
    mock = installFetchMock([
      initOk,
      { body: { jsonrpc: '2.0', id: 2, error: { code: -32029, message: 'Rate limited. Try again in 0 seconds.' } } },
      okResult(3),
    ])

    const conn = new McpConnection('http://server')
    await conn.connect()
    const resp = await conn.execute('get_status', {})
    expect(resp.error).toBeUndefined()
    expect(resp.result).toEqual({ ok: true })
    await conn.disconnect()
  })
})

describe('McpConnection ensureConnected coalescing', () => {
  let mock: ReturnType<typeof installFetchMock>
  afterEach(() => mock?.restore())

  it('coalesces concurrent connect() calls onto one initialize', async () => {
    mock = installFetchMock([initOk])

    const conn = new McpConnection('http://server')
    // Three parallel connects should not fire three initialize requests.
    await Promise.all([conn.connect(), conn.connect(), conn.connect()])
    // initialize (1 fetch) + notifications/initialized notification (1 fetch) = 2 total
    expect(mock.calls.length).toBe(2)
    await conn.disconnect()
  })

  it('execute() implicitly ensures connection if not yet connected', async () => {
    mock = installFetchMock([
      initOk,
      okResult(2),
    ])

    const conn = new McpConnection('http://server')
    // Skip explicit connect()
    const resp = await conn.execute('get_status', {})
    expect(resp.result).toEqual({ ok: true })
    expect(conn.isConnected()).toBe(true)
    await conn.disconnect()
  })
})

describe('McpConnection background notification polling', () => {
  let mock: ReturnType<typeof installFetchMock>
  afterEach(() => mock?.restore())

  it('execute() issues exactly one tool-call fetch per command (no inline poll)', async () => {
    mock = installFetchMock([
      initOk,
      okResult(2),
      okResult(3),
    ])

    const conn = new McpConnection('http://server')
    await conn.connect()
    const before = mock.calls.length
    await conn.execute('get_status', {})
    await conn.execute('get_cargo', {})
    // Two execute() calls → exactly two new fetches, not four.
    expect(mock.calls.length - before).toBe(2)
    await conn.disconnect()
  })

  it('dispatches received notifications to registered handlers', async () => {
    const notifPayload = { type: 'attack', from: 'pirate' }
    const notifResult = {
      body: { jsonrpc: '2.0', id: 99, result: { content: [{ type: 'text', text: JSON.stringify({ notifications: [notifPayload] }) }] } },
    }
    mock = installFetchMock([initOk, notifResult])

    const received: unknown[] = []
    const conn = new McpConnection('http://server')
    ;(conn as unknown as { notificationPollIntervalMs: number }).notificationPollIntervalMs = 10
    conn.onNotification(n => received.push(n))

    await conn.connect()
    await new Promise(r => setTimeout(r, 35))
    await conn.disconnect()

    expect(received.length).toBeGreaterThan(0)
    expect(received[0]).toEqual(notifPayload)
  })

  it('stops polling after disconnect', async () => {
    const notifEmpty = {
      body: { jsonrpc: '2.0', id: 99, result: { content: [{ type: 'text', text: JSON.stringify({ notifications: [] }) }] } },
    }
    mock = installFetchMock([initOk, notifEmpty])

    const conn = new McpConnection('http://server')
    ;(conn as unknown as { notificationPollIntervalMs: number }).notificationPollIntervalMs = 10
    conn.onNotification(() => {})

    await conn.connect()
    await new Promise(r => setTimeout(r, 35))
    await conn.disconnect()
    const stable = mock.calls.length
    await new Promise(r => setTimeout(r, 30))
    expect(mock.calls.length).toBe(stable)
  })
})

const toolsListReply = {
  body: {
    jsonrpc: '2.0',
    id: 2,
    result: {
      tools: [
        {
          name: 'spacemolt',
          description: 'Main tool',
          inputSchema: { properties: { action: { enum: ['get_status', 'get_cargo', 'get_notifications'] } } },
        },
      ],
    },
  },
}

describe('McpV2Connection sendJsonRpc rate-limit handling', () => {
  let mock: ReturnType<typeof installFetchMock>
  afterEach(() => mock?.restore())

  it('retries -32029 on initialize and connects successfully', async () => {
    mock = installFetchMock([
      { body: { jsonrpc: '2.0', id: 1, error: { code: -32029, message: 'Rate limited. Try again in 0 seconds.' } } },
      initOk,             // retry of initialize succeeds
      initOk,             // notifications/initialized (body ignored)
      toolsListReply,     // tools/list
    ])

    const conn = new McpV2Connection('http://server')
    await conn.connect()
    expect(conn.isConnected()).toBe(true)
    await conn.disconnect()
  })

  it('retries -32029 on tools/call inside execute', async () => {
    mock = installFetchMock([
      initOk,
      initOk,
      toolsListReply,
      { body: { jsonrpc: '2.0', id: 4, error: { code: -32029, message: 'Rate limited. Try again in 0 seconds.' } } },
      okResult(5),
    ])

    const conn = new McpV2Connection('http://server')
    await conn.connect()
    const resp = await conn.execute('get_status', {})
    expect(resp.error).toBeUndefined()
    expect(resp.result).toEqual({ ok: true })
    await conn.disconnect()
  })
})

describe('McpV2Connection ensureConnected coalescing', () => {
  let mock: ReturnType<typeof installFetchMock>
  afterEach(() => mock?.restore())

  it('coalesces concurrent connect() calls', async () => {
    mock = installFetchMock([initOk, initOk, toolsListReply])

    const conn = new McpV2Connection('http://server')
    await Promise.all([conn.connect(), conn.connect(), conn.connect()])
    // initialize + notifications/initialized + tools/list = 3 fetches
    expect(mock.calls.length).toBe(3)
    await conn.disconnect()
  })
})

describe('McpV2Connection background notification polling', () => {
  let mock: ReturnType<typeof installFetchMock>
  afterEach(() => mock?.restore())

  it('execute() issues exactly one tool-call fetch per command', async () => {
    mock = installFetchMock([
      initOk,
      initOk,
      toolsListReply,
      okResult(4),
      okResult(5),
    ])

    const conn = new McpV2Connection('http://server')
    await conn.connect()
    const before = mock.calls.length
    await conn.execute('get_status', {})
    await conn.execute('get_cargo', {})
    expect(mock.calls.length - before).toBe(2)
    await conn.disconnect()
  })

  it('dispatches notifications to handlers', async () => {
    const payload = { type: 'attack', from: 'pirate' }
    const notifResult = {
      body: { jsonrpc: '2.0', id: 99, result: { content: [{ type: 'text', text: JSON.stringify({ notifications: [payload] }) }] } },
    }
    mock = installFetchMock([initOk, initOk, toolsListReply, notifResult])

    const received: unknown[] = []
    const conn = new McpV2Connection('http://server')
    ;(conn as unknown as { notificationPollIntervalMs: number }).notificationPollIntervalMs = 10
    conn.onNotification(n => received.push(n))

    await conn.connect()
    await new Promise(r => setTimeout(r, 35))
    await conn.disconnect()

    expect(received.length).toBeGreaterThan(0)
    expect(received[0]).toEqual(payload)
  })
})
