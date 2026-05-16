import type { GameConnection, LoginResult, RegisterResult, CommandResult, NotificationHandler } from './interface'
import { USER_AGENT } from './interface'

const MAX_RECONNECT_ATTEMPTS = 6
const RECONNECT_BASE_DELAY_MS = 5_000
const RATE_LIMIT_CODE = -32029
const DEFAULT_BACKOFF_SECS = 30

export class McpConnection implements GameConnection {
  readonly mode = 'mcp' as const
  private baseUrl: string
  private sessionId: string | null = null
  private notificationHandlers: NotificationHandler[] = []
  private connected = false
  private jsonRpcId = 0
  private ensureConnectedPromise: Promise<void> | null = null
  private notificationTimer: ReturnType<typeof setInterval> | null = null
  // SpaceMolt actions cool down on multi-second ticks, so a 3s notification
  // latency is imperceptible while halving request volume vs. per-command polling.
  private notificationPollIntervalMs = 3000
  private polling = false

  constructor(serverUrl: string) {
    this.baseUrl = serverUrl.replace(/\/$/, '') + '/mcp'
  }

  async connect(): Promise<void> {
    await this.ensureConnected()
  }

  async login(username: string, password: string): Promise<LoginResult> {
    const resp = await this.callTool('login', { username, password })
    if (resp.error) {
      return { success: false, error: resp.error.message }
    }
    const result = this.parseToolResult(resp.result)
    return {
      success: true,
      player_id: result?.player_id as string | undefined,
    }
  }

  async register(username: string, empire: string, code?: string): Promise<RegisterResult> {
    const args: Record<string, unknown> = { username, empire }
    if (code) args.registration_code = code
    const resp = await this.callTool('register', args)
    if (resp.error) {
      return { success: false, error: resp.error.message }
    }
    const result = this.parseToolResult(resp.result)
    return {
      success: true,
      username: result?.username as string,
      password: result?.password as string,
      player_id: result?.player_id as string,
      empire: result?.empire as string,
    }
  }

  async execute(command: string, args?: Record<string, unknown>): Promise<CommandResult> {
    try {
      await this.ensureConnected()
    } catch {
      return { error: { code: 'connection_failed', message: 'Could not connect to MCP server' } }
    }

    const resp = await this.callTool(command, args || {})
    if (resp.error) {
      return { error: { code: resp.error.code?.toString() || 'mcp_error', message: resp.error.message || 'Unknown error' } }
    }

    const result = this.parseToolResult(resp.result)

    // Re-initialize on session expiry and retry once
    const errCode = (result?.error as Record<string, unknown> | undefined)?.code
    if (errCode === 'session_expired' || errCode === 'session_invalid') {
      this.sessionId = null
      this.connected = false
      await this.ensureConnected()
      return this.execute(command, args)
    }

    return { result }
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandlers.push(handler)
  }

  async disconnect(): Promise<void> {
    if (this.notificationTimer) {
      clearInterval(this.notificationTimer)
      this.notificationTimer = null
    }
    this.sessionId = null
    this.connected = false
  }

  isConnected(): boolean {
    return this.connected
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) return

    // Coalesce concurrent callers onto a single in-flight attempt — mirrors
    // http.ts's ensureSessionPromise so multiple profiles or a session-recovery
    // retry don't all hammer initialize against the same per-IP rate-limit bucket.
    if (!this.ensureConnectedPromise) {
      this.ensureConnectedPromise = this.doConnect().finally(() => {
        this.ensureConnectedPromise = null
      })
    }
    return this.ensureConnectedPromise
  }

  private async doConnect(): Promise<void> {
    let lastError: Error | null = null
    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt++) {
      try {
        const resp = await this.sendJsonRpc('initialize', {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'admiral', version: '0.2.1' },
        })
        if (!resp.result) {
          throw new Error('MCP initialize failed: ' + JSON.stringify(resp.error))
        }
        await this.sendNotification('notifications/initialized', {})
        this.connected = true
        this.startNotificationPolling()
        return
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt)
        await sleep(delay)
      }
    }
    throw lastError || new Error('Failed to connect to MCP server')
  }

  private startNotificationPolling(): void {
    if (this.notificationTimer) return
    this.notificationTimer = setInterval(() => {
      void this.pollNotifications()
    }, this.notificationPollIntervalMs)
  }

  private async pollNotifications(): Promise<void> {
    // Skip the round-trip when nobody is listening, or when a previous poll
    // is still in flight (laptop sleep + setInterval can queue several ticks
    // — without this guard a resume would burst-fire requests, exactly the
    // rate-limit pattern this connection is trying to avoid).
    if (this.polling || !this.connected || this.notificationHandlers.length === 0) return
    this.polling = true
    try {
      const resp = await this.callTool('get_notifications', {})
      // Re-check after the await: disconnect() may have fired while we waited.
      if (!this.connected) return
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
    } finally {
      this.polling = false
    }
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<{
    result?: unknown
    error?: { code?: number; message: string }
  }> {
    return this.sendJsonRpc('tools/call', { name, arguments: args })
  }

  private async sendJsonRpc(method: string, params: unknown): Promise<{
    result?: unknown
    error?: { code?: number; message: string }
  }> {
    // Rate-limit retry loop — centralised here so initialize, tools/list,
    // tools/call and any future JSON-RPC method get backoff for free, instead
    // of duplicating the check in every caller (the HTTP pattern in
    // http.ts:91-95 lives in execute() but HTTP only has one request shape).
    while (true) {
      const resp = await this.doSendJsonRpc(method, params)
      if (resp.error && resp.error.code === RATE_LIMIT_CODE) {
        const match = /(\d+)\s*seconds?/i.exec(resp.error.message || '')
        const secs = match ? parseInt(match[1], 10) : DEFAULT_BACKOFF_SECS
        await sleep(secs * 1000)
        continue
      }
      return resp
    }
  }

  private async doSendJsonRpc(method: string, params: unknown): Promise<{
    result?: unknown
    error?: { code?: number; message: string }
  }> {
    const id = ++this.jsonRpcId
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    })

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'User-Agent': USER_AGENT,
    }
    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId
    }

    const resp = await fetch(this.baseUrl, { method: 'POST', headers, body })

    // Capture session ID from response headers
    const sid = resp.headers.get('Mcp-Session-Id')
    if (sid) this.sessionId = sid

    const contentType = resp.headers.get('content-type') || ''
    if (contentType.includes('text/event-stream')) {
      // Parse SSE response
      const text = await resp.text()
      const lines = text.split('\n')
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6))
            if (data.id === id) return data
          } catch {
            // continue parsing
          }
        }
      }
      return { error: { message: 'No matching response in SSE stream' } }
    }

    return await resp.json()
  }

  private async sendNotification(method: string, params: unknown): Promise<void> {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params })
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT }
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId

    await fetch(this.baseUrl, { method: 'POST', headers, body })
  }

  private parseToolResult(result: unknown): Record<string, unknown> | null {
    if (!result) return null
    // MCP tool results come as { content: [{ type: "text", text: "..." }] }
    const r = result as Record<string, unknown>
    if (r.content && Array.isArray(r.content)) {
      for (const block of r.content) {
        const b = block as Record<string, unknown>
        if (b.type === 'text' && typeof b.text === 'string') {
          try {
            return JSON.parse(b.text)
          } catch {
            return { text: b.text }
          }
        }
      }
    }
    return r
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
