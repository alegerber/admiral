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

describe('McpConnection rate-limit handling', () => {
  let mock: ReturnType<typeof installFetchMock>
  afterEach(() => mock?.restore())

  it('retries after JSON-RPC -32029 using seconds parsed from message', async () => {
    mock = installFetchMock([
      initOk,
      { body: { jsonrpc: '2.0', id: 2, error: { code: -32029, message: 'Rate limited. Too many requests from your IP. Try again in 0 seconds.' } } },
      { body: { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] } } },
    ])

    const conn = new McpConnection('http://server')
    await conn.connect()
    const resp = await conn.execute('get_status', {})

    expect(resp.error).toBeUndefined()
    expect(resp.result).toEqual({ ok: true })
    // initialize + rate-limited call + retry — exactly 3, no extra inline poll
    expect(mock.calls.length).toBe(3)
    await conn.disconnect()
  })
})

describe('McpConnection request volume', () => {
  let mock: ReturnType<typeof installFetchMock>
  afterEach(() => mock?.restore())

  it('execute() issues exactly one tool-call fetch per command (no inline notification poll)', async () => {
    mock = installFetchMock([
      initOk,
      { body: { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] } } },
      { body: { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] } } },
    ])

    const conn = new McpConnection('http://server')
    await conn.connect()

    const fetchesBefore = mock.calls.length // initialize already consumed
    await conn.execute('get_status', {})
    await conn.execute('get_cargo', {})

    // Two execute() calls → exactly two new fetches, not four.
    expect(mock.calls.length - fetchesBefore).toBe(2)
    await conn.disconnect()
  })
})

describe('McpConnection background notification polling', () => {
  let mock: ReturnType<typeof installFetchMock>
  afterEach(() => mock?.restore())

  it('starts polling after connect and stops after disconnect', async () => {
    const notifEmpty = {
      body: { jsonrpc: '2.0', id: 99, result: { content: [{ type: 'text', text: JSON.stringify({ notifications: [] }) }] } },
    }
    mock = installFetchMock([
      initOk,
      // Any number of subsequent notification polls return empty
      notifEmpty, notifEmpty, notifEmpty, notifEmpty, notifEmpty,
    ])

    const conn = new McpConnection('http://server')
    // Override interval to make test fast — set via property write before connect
    ;(conn as unknown as { notificationPollIntervalMs: number }).notificationPollIntervalMs = 10
    conn.onNotification(() => {})

    await conn.connect()
    const callsAtConnect = mock.calls.length

    await new Promise(r => setTimeout(r, 35)) // allow ~3 polls
    const callsAfterPolling = mock.calls.length
    expect(callsAfterPolling).toBeGreaterThan(callsAtConnect)

    await conn.disconnect()
    const callsAtDisconnect = mock.calls.length
    await new Promise(r => setTimeout(r, 30))
    // No new fetches after disconnect
    expect(mock.calls.length).toBe(callsAtDisconnect)
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
          inputSchema: { properties: { action: { enum: ['get_status', 'get_notifications'] } } },
        },
      ],
    },
  },
}

describe('McpV2Connection rate-limit handling', () => {
  let mock: ReturnType<typeof installFetchMock>
  afterEach(() => mock?.restore())

  it('retries after JSON-RPC -32029 using seconds parsed from message', async () => {
    // connect() fires three fetches: initialize, notifications/initialized
    // (fire-and-forget, body ignored), and tools/list. Then execute() fires
    // the rate-limited call and its retry.
    mock = installFetchMock([
      initOk,
      initOk,
      toolsListReply,
      { body: { jsonrpc: '2.0', id: 4, error: { code: -32029, message: 'Rate limited. Try again in 0 seconds.' } } },
      { body: { jsonrpc: '2.0', id: 5, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] } } },
    ])

    const conn = new McpV2Connection('http://server')
    await conn.connect()
    const resp = await conn.execute('get_status', {})

    expect(resp.error).toBeUndefined()
    expect(resp.result).toEqual({ ok: true })
    // 3 fetches during connect + rate-limited call + retry — exactly 5
    expect(mock.calls.length).toBe(5)
    await conn.disconnect()
  })
})
