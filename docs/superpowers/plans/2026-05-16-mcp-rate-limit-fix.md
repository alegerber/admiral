# MCP Rate-Limit Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop admiral's MCP v1 and v2 connections from hitting the SpaceMolt server's per-IP rate limit when multiple profiles run simultaneously.

**Architecture:** Two fixes per MCP connection class. (1) Replace the per-command `get_notifications` tool call with a background poll loop, so each `execute()` issues one server request instead of two. (2) Detect JSON-RPC error code `-32029` ("Rate limited"), parse the wait seconds from the message, sleep, and retry — mirroring the existing logic in `http.ts:91-95`.

**Tech Stack:** TypeScript, Bun runtime, `bun:test`, `fetch` (no extra deps).

---

## File Structure

**Modify:**
- `src/server/lib/connections/mcp.ts` — add `-32029` handling in `execute()`; replace inline `get_notifications` call with a background interval started in `connect()` / cleared in `disconnect()`
- `src/server/lib/connections/mcp_v2.ts` — same two changes, same shape

**Create:**
- `src/server/lib/connections/mcp.test.ts` — unit tests for rate-limit backoff and request-count assertions for both classes

**No changes to:** `http.ts`, `http_v2.ts`, `websocket.ts`, `interface.ts`, `loop.ts`, `agent.ts`.

---

## Constants and helpers used throughout

These types/values appear in multiple tasks. They live inside each connection file (no shared module — both files already duplicate `sendJsonRpc` etc., and a shared helper would be premature abstraction).

**JSON-RPC error code for rate-limit:** `-32029` (numeric in MCP responses; current code stringifies it via `resp.error.code?.toString()`, so we must compare against the number *before* it is stringified).

**Default backoff seconds (fallback when regex fails to parse):** `30`.

**Wait-seconds regex:** `/(\d+)\s*seconds?/i` — matches "42 seconds", "1 second", case-insensitive.

**Background notification poll interval:** `3000` ms. Rationale: SpaceMolt is tick-based with multi-second action cooldowns, so 3-second notification latency is imperceptible to the LLM loop while halving request volume.

---

## Task 1: Add rate-limit backoff to McpConnection (v1)

**Files:**
- Modify: `src/server/lib/connections/mcp.ts:62-96` (the `execute()` method)
- Create: `src/server/lib/connections/mcp.test.ts`

- [ ] **Step 1.1: Write the failing test for rate-limit detection + retry**

Create `src/server/lib/connections/mcp.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
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
```

- [ ] **Step 1.2: Run the test to verify it fails**

Run: `bun test src/server/lib/connections/mcp.test.ts`
Expected: FAIL — current code does not handle `-32029`; first test will see `resp.error` populated; second test's promise will resolve immediately as error (not "still-waiting").

- [ ] **Step 1.3: Implement rate-limit detection in `execute()`**

In `src/server/lib/connections/mcp.ts`, modify the `execute()` method. Replace lines 62-96 (the current method body) with:

```typescript
  async execute(command: string, args?: Record<string, unknown>): Promise<CommandResult> {
    const resp = await this.callTool(command, args || {})

    // JSON-RPC -32029: rate limited. Parse seconds from message, sleep, retry.
    if (resp.error && resp.error.code === -32029) {
      const match = /(\d+)\s*seconds?/i.exec(resp.error.message || '')
      const secs = match ? parseInt(match[1], 10) : 30
      await sleep(secs * 1000)
      return this.execute(command, args)
    }

    if (resp.error) {
      return { error: { code: resp.error.code?.toString() || 'mcp_error', message: resp.error.message || 'Unknown error' } }
    }

    const result = this.parseToolResult(resp.result)

    // Re-initialize on session expiry and retry once
    const errCode = (result?.error as Record<string, unknown> | undefined)?.code
    if (errCode === 'session_expired' || errCode === 'session_invalid') {
      this.sessionId = null
      this.connected = false
      await this.connect()
      return this.execute(command, args)
    }

    return { result }
  }
```

Also add the `sleep` helper at the bottom of the file, just before the final closing brace of the module:

```typescript
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
```

Note: the inline `get_notifications` call is removed here — it is replaced by a background poller in Task 3. The `notifications` field is no longer returned from `execute()`; emission happens in the background loop via `notificationHandlers`.

- [ ] **Step 1.4: Run the test to verify it passes**

Run: `bun test src/server/lib/connections/mcp.test.ts -t "retries after JSON-RPC -32029"`
Expected: PASS.

Run: `bun test src/server/lib/connections/mcp.test.ts -t "falls back to 30s default"`
Expected: PASS — promise stays pending past 50ms because the retry is waiting on the 30s default sleep.

- [ ] **Step 1.5: Run the full existing test suite to ensure nothing else broke**

Run: `bun test`
Expected: All previously-passing tests still pass (15 + 2 new = 17 pass minimum).

- [ ] **Step 1.6: Commit**

```bash
git add src/server/lib/connections/mcp.ts src/server/lib/connections/mcp.test.ts
git commit -m "fix: handle JSON-RPC -32029 rate-limit in MCP v1 with backoff"
```

---

## Task 2: Add rate-limit backoff to McpV2Connection

**Files:**
- Modify: `src/server/lib/connections/mcp_v2.ts:117-179` (the `execute()` method)
- Modify: `src/server/lib/connections/mcp.test.ts` (append v2 tests)

- [ ] **Step 2.1: Write the failing test for McpV2Connection**

Append to `src/server/lib/connections/mcp.test.ts`:

```typescript
import { McpV2Connection } from './mcp_v2'

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
    mock = installFetchMock([
      initOk,
      toolsListReply,
      { body: { jsonrpc: '2.0', id: 3, error: { code: -32029, message: 'Rate limited. Try again in 0 seconds.' } } },
      { body: { jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] } } },
      notifEmpty,
    ])

    const conn = new McpV2Connection('http://server')
    await conn.connect()
    const resp = await conn.execute('get_status', {})

    expect(resp.error).toBeUndefined()
    expect(resp.result).toEqual({ ok: true })
    await conn.disconnect()
  })
})
```

- [ ] **Step 2.2: Run the test to verify it fails**

Run: `bun test src/server/lib/connections/mcp.test.ts -t "McpV2Connection rate-limit"`
Expected: FAIL — `resp.error` is set because v2 also lacks `-32029` handling.

- [ ] **Step 2.3: Implement rate-limit detection in v2 `execute()`**

In `src/server/lib/connections/mcp_v2.ts`, in the `execute()` method, insert this block immediately after the line `const resp = await this.callTool(toolName, toolArgs)` (currently line 139):

```typescript
    // JSON-RPC -32029: rate limited. Parse seconds from message, sleep, retry.
    if (resp.error && resp.error.code === -32029) {
      const match = /(\d+)\s*seconds?/i.exec(resp.error.message || '')
      const secs = match ? parseInt(match[1], 10) : 30
      await sleep(secs * 1000)
      return this.execute(command, args)
    }
```

Then delete the existing inline notification-polling block (currently lines 159-176, starting with `// Poll notifications`). The method now ends with the structured-content return at line 178.

Add the `sleep` helper at the bottom of `mcp_v2.ts` (mirror of Task 1.3):

```typescript
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
```

- [ ] **Step 2.4: Run the test to verify it passes**

Run: `bun test src/server/lib/connections/mcp.test.ts -t "McpV2Connection rate-limit"`
Expected: PASS.

- [ ] **Step 2.5: Run the full test suite**

Run: `bun test`
Expected: all green.

- [ ] **Step 2.6: Commit**

```bash
git add src/server/lib/connections/mcp_v2.ts src/server/lib/connections/mcp.test.ts
git commit -m "fix: handle JSON-RPC -32029 rate-limit in MCP v2 with backoff"
```

---

## Task 3: Replace per-command notification polling with background poll (v1)

**Files:**
- Modify: `src/server/lib/connections/mcp.ts` (constructor, `connect()`, `disconnect()`)
- Modify: `src/server/lib/connections/mcp.test.ts`

- [ ] **Step 3.1: Write the failing test for request-count assertion**

Append to `src/server/lib/connections/mcp.test.ts`:

```typescript
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
```

- [ ] **Step 3.2: Run the test to verify it fails**

Run: `bun test src/server/lib/connections/mcp.test.ts -t "request volume"`
Expected: After Task 1, the inline `get_notifications` call was already removed from `execute()`, so this test may already pass. If it does, **skip directly to Step 3.3** (background poller implementation). If it fails, double-check that Task 1's `execute()` replacement removed the polling block (`mcp.ts:80-93` in the original).

- [ ] **Step 3.3: Add background notification poller**

In `src/server/lib/connections/mcp.ts`, add a private field next to the others (after `private connected = false`):

```typescript
  private notificationTimer: ReturnType<typeof setInterval> | null = null
  private readonly notificationPollIntervalMs = 3000
```

Modify `connect()` to start the timer at the end (after `this.connected = true`):

```typescript
    this.connected = true
    this.startNotificationPolling()
  }

  private startNotificationPolling(): void {
    if (this.notificationTimer) return
    this.notificationTimer = setInterval(() => {
      void this.pollNotifications()
    }, this.notificationPollIntervalMs)
  }

  private async pollNotifications(): Promise<void> {
    if (!this.connected || this.notificationHandlers.length === 0) return
    try {
      const resp = await this.callTool('get_notifications', {})
      // Silently skip if rate-limited — the next interval will retry.
      if (resp.error) return
      const parsed = this.parseToolResult(resp.result)
      const notifications = parsed?.notifications
      if (!Array.isArray(notifications)) return
      for (const n of notifications) {
        for (const handler of this.notificationHandlers) {
          handler(n)
        }
      }
    } catch {
      // Best-effort
    }
  }
```

Modify `disconnect()` to clear the timer:

```typescript
  async disconnect(): Promise<void> {
    if (this.notificationTimer) {
      clearInterval(this.notificationTimer)
      this.notificationTimer = null
    }
    this.sessionId = null
    this.connected = false
  }
```

- [ ] **Step 3.4: Write the failing test for background polling**

Append to `src/server/lib/connections/mcp.test.ts`:

```typescript
describe('McpConnection background notification polling', () => {
  let mock: ReturnType<typeof installFetchMock>
  afterEach(() => mock?.restore())

  it('starts polling after connect and stops after disconnect', async () => {
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
```

Note: the test mutates `notificationPollIntervalMs` via a type assertion because the field is declared `readonly`. To make this work, change the declaration in Step 3.3 from `private readonly notificationPollIntervalMs = 3000` to `private notificationPollIntervalMs = 3000`. (Drop `readonly`.)

- [ ] **Step 3.5: Run all new tests**

Run: `bun test src/server/lib/connections/mcp.test.ts`
Expected: all PASS (request-volume + background-polling + earlier rate-limit tests).

- [ ] **Step 3.6: Run the full suite**

Run: `bun test`
Expected: all green.

- [ ] **Step 3.7: Commit**

```bash
git add src/server/lib/connections/mcp.ts src/server/lib/connections/mcp.test.ts
git commit -m "refactor: replace per-command notification poll with background interval (MCP v1)"
```

---

## Task 4: Background notification poll for McpV2Connection

**Files:**
- Modify: `src/server/lib/connections/mcp_v2.ts`
- Modify: `src/server/lib/connections/mcp.test.ts`

- [ ] **Step 4.1: Write the failing test for v2 request volume + polling**

Append to `src/server/lib/connections/mcp.test.ts`:

```typescript
describe('McpV2Connection request volume + background polling', () => {
  let mock: ReturnType<typeof installFetchMock>
  afterEach(() => mock?.restore())

  it('execute() issues exactly one tool-call fetch per command', async () => {
    mock = installFetchMock([
      initOk,
      toolsListReply,
      { body: { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] } } },
      { body: { jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] } } },
    ])

    const conn = new McpV2Connection('http://server')
    await conn.connect()
    const before = mock.calls.length
    await conn.execute('get_status', {})
    await conn.execute('get_cargo', {})
    expect(mock.calls.length - before).toBe(2)
    await conn.disconnect()
  })

  it('starts polling after connect and stops after disconnect', async () => {
    mock = installFetchMock([
      initOk,
      toolsListReply,
      notifEmpty, notifEmpty, notifEmpty, notifEmpty, notifEmpty,
    ])

    const conn = new McpV2Connection('http://server')
    ;(conn as unknown as { notificationPollIntervalMs: number }).notificationPollIntervalMs = 10
    conn.onNotification(() => {})

    await conn.connect()
    const callsAtConnect = mock.calls.length
    await new Promise(r => setTimeout(r, 35))
    expect(mock.calls.length).toBeGreaterThan(callsAtConnect)

    await conn.disconnect()
    const stable = mock.calls.length
    await new Promise(r => setTimeout(r, 30))
    expect(mock.calls.length).toBe(stable)
  })
})
```

- [ ] **Step 4.2: Run the test to verify it fails**

Run: `bun test src/server/lib/connections/mcp.test.ts -t "McpV2Connection request volume"`
Expected: request-volume test may already pass (Task 2 deleted the inline poll). Polling test FAILS because there is no background timer yet.

- [ ] **Step 4.3: Add background poller to v2**

In `src/server/lib/connections/mcp_v2.ts`, add the fields next to `private connected = false`:

```typescript
  private notificationTimer: ReturnType<typeof setInterval> | null = null
  private notificationPollIntervalMs = 3000
```

Modify `connect()` (currently line 32-49). After the line `this.connected = true` (currently 48), add:

```typescript
    this.startNotificationPolling()
```

Add these private methods (place them next to the other private methods, e.g. after `discoverTools()`):

```typescript
  private startNotificationPolling(): void {
    if (this.notificationTimer) return
    this.notificationTimer = setInterval(() => {
      void this.pollNotifications()
    }, this.notificationPollIntervalMs)
  }

  private async pollNotifications(): Promise<void> {
    if (!this.connected || this.notificationHandlers.length === 0) return
    const notifTool = this.actionToTool.get('get_notifications')
    if (!notifTool) return
    try {
      const resp = await this.callTool(notifTool, { action: 'get_notifications' })
      if (resp.error) return
      const { parsed } = this.parseToolResult(resp.result)
      const notifications = parsed?.notifications
      if (!Array.isArray(notifications)) return
      for (const n of notifications) {
        for (const handler of this.notificationHandlers) {
          handler(n)
        }
      }
    } catch {
      // Best-effort
    }
  }
```

Modify `disconnect()` (currently lines 215-218):

```typescript
  async disconnect(): Promise<void> {
    if (this.notificationTimer) {
      clearInterval(this.notificationTimer)
      this.notificationTimer = null
    }
    this.sessionId = null
    this.connected = false
  }
```

- [ ] **Step 4.4: Run all new tests**

Run: `bun test src/server/lib/connections/mcp.test.ts`
Expected: all PASS.

- [ ] **Step 4.5: Run the full suite**

Run: `bun test`
Expected: all green.

- [ ] **Step 4.6: Commit**

```bash
git add src/server/lib/connections/mcp_v2.ts src/server/lib/connections/mcp.test.ts
git commit -m "refactor: replace per-command notification poll with background interval (MCP v2)"
```

---

## Task 5: Manual smoke test with multiple profiles

This task is **manual** — the unit tests cover correctness, but only a live run confirms the rate-limit no longer fires.

- [ ] **Step 5.1: Start admiral in dev mode**

Run: `bun run dev`
Expected: server up on port 3031 (per README), Vite frontend on 3030.

- [ ] **Step 5.2: Configure two or more profiles to use MCP v1**

In the admiral UI: create at least two agent profiles, each with **Connection Mode = MCP v1** against the same SpaceMolt server URL.

- [ ] **Step 5.3: Start both agents and observe logs**

Trigger turns on both profiles. In the log viewer, filter by `category = errors`.

Expected: **No** `-32029` / "Rate limited" errors over a 2-minute period of normal play.
Previously (pre-fix): one or more `Too many requests from your IP` errors within seconds.

- [ ] **Step 5.4: Repeat with MCP v2**

Same as 5.2-5.3 but with Connection Mode = MCP v2.

- [ ] **Step 5.5: If rate-limit still fires**

If `-32029` still appears under the new code, the per-IP bucket is tighter than the polling-halved load. In that case:

1. Increase the default `notificationPollIntervalMs` from 3000 to 10000 in both classes.
2. Re-run Steps 5.3-5.4.
3. If still failing, the bottleneck is no longer the notification poll — it's the command volume itself, and the next step is server-side rate-limit-bucket tuning (out of scope for this plan).

No commit in this task — it is verification only.

---

## Self-Review Summary

**Spec coverage:**
- Rate-limit backoff (Recommendation C): Tasks 1 & 2.
- Notification polling throttle (Recommendation A): Tasks 3 & 4.
- Multi-profile verification: Task 5.

**No placeholders:** every code step includes the exact code.

**Type consistency:**
- `notificationTimer: ReturnType<typeof setInterval> | null` — same in both v1 and v2.
- `notificationPollIntervalMs: number` (not `readonly`, so tests can mutate it) — same in both.
- `pollNotifications()`, `startNotificationPolling()` — same names in both classes.
- `sleep(ms: number): Promise<void>` — file-local helper in each of `mcp.ts` and `mcp_v2.ts`.
- Rate-limit regex `/(\d+)\s*seconds?/i` and default `30` — identical in both classes.

**Out of scope:** WebSocket connection (uses different transport), HTTP connections (already handle `rate_limited`), and server-side SSE-push refactor (Recommendation E, mentioned for the future).
