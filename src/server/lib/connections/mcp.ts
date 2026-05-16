import type { GameConnection, LoginResult, RegisterResult, CommandResult, NotificationHandler } from './interface'
import { USER_AGENT } from './interface'

export class McpConnection implements GameConnection {
  readonly mode = 'mcp' as const
  private baseUrl: string
  private sessionId: string | null = null
  private notificationHandlers: NotificationHandler[] = []
  private connected = false
  private jsonRpcId = 0
  private notificationTimer: ReturnType<typeof setInterval> | null = null
  // SpaceMolt actions cool down on multi-second ticks, so a 3s notification
  // latency is imperceptible while halving request volume vs. per-command polling.
  private notificationPollIntervalMs = 3000
  private polling = false

  constructor(serverUrl: string) {
    this.baseUrl = serverUrl.replace(/\/$/, '') + '/mcp'
  }

  async connect(): Promise<void> {
    // Send initialize request
    const resp = await this.sendJsonRpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'admiral', version: '0.2.1' },
    })

    if (!resp.result) {
      throw new Error('MCP initialize failed: ' + JSON.stringify(resp.error))
    }

    // Send initialized notification
    await this.sendNotification('notifications/initialized', {})
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
    const resp = await this.callTool(command, args || {})

    // JSON-RPC -32029: rate limited. The message ("Try again in N seconds")
    // is the only signal — MCP has no structured retry_after field. Default
    // 30s when the message is malformed, covering the worst documented window.
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
