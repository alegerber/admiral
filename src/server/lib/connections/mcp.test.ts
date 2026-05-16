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
