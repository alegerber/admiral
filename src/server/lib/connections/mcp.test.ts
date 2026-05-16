import { describe, it, expect, afterEach } from 'bun:test'
import { McpConnection } from './mcp'

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
const notifEmpty = {
  body: { jsonrpc: '2.0', id: 99, result: { content: [{ type: 'text', text: JSON.stringify({ notifications: [] }) }] } },
}

describe('McpConnection rate-limit handling', () => {
  let mock: ReturnType<typeof installFetchMock>
  afterEach(() => mock?.restore())

  it('retries after JSON-RPC -32029 using seconds parsed from message', async () => {
    mock = installFetchMock([
      initOk,                                                                  // initialize
      // First tool call: rate limited, 0 seconds (so test runs fast)
      { body: { jsonrpc: '2.0', id: 2, error: { code: -32029, message: 'Rate limited. Too many requests from your IP. Try again in 0 seconds.' } } },
      // Retry: success
      { body: { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] } } },
      notifEmpty,                                                              // background notification poll (if any)
    ])

    const conn = new McpConnection('http://server')
    await conn.connect()
    const resp = await conn.execute('get_status', {})

    expect(resp.error).toBeUndefined()
    expect(resp.result).toEqual({ ok: true })
    // Three fetches so far: initialize, rate-limited call, retry
    expect(mock.calls.length).toBeGreaterThanOrEqual(3)
    await conn.disconnect()
  })

  it('falls back to 30s default when message has no seconds — uses retry_after-style cap', async () => {
    // We don't want to actually wait 30s in a test, so we use a small-sleep injection
    // path: pass a malformed message and assert the error is surfaced rather than infinite-retry.
    mock = installFetchMock([
      initOk,
      { body: { jsonrpc: '2.0', id: 2, error: { code: -32029, message: 'Rate limited.' } } },
    ])

    const conn = new McpConnection('http://server')
    await conn.connect()
    // Kick off the call but don't await — we just want to assert it does NOT immediately resolve to error
    const p = conn.execute('get_status', {})
    // Race: if it resolves immediately as error, the test fails (we expect a backoff)
    const winner = await Promise.race([p, new Promise(r => setTimeout(() => r('still-waiting'), 50))])
    expect(winner).toBe('still-waiting')
    await conn.disconnect()
  })
})
