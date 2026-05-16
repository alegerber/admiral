import type { GameConnection, LoginResult, RegisterResult, CommandResult, NotificationHandler } from './interface'
import { USER_AGENT } from './interface'

const MAX_RECONNECT_ATTEMPTS = 6
const RECONNECT_BASE_DELAY_MS = 5_000
const RATE_LIMIT_CODE = -32029
const DEFAULT_BACKOFF_SECS = 30

interface V2ToolDef {
  name: string
  description: string
  actions: string[]
}

/**
 * MCP v2 connection. V2 consolidates ~148 individual commands into ~15 grouped
 * tools (spacemolt, spacemolt_auth, spacemolt_ship, etc.), each with an `action`
 * parameter. This connection discovers tools on connect and translates command
 * names to the correct tool+action pair.
 */
export class McpV2Connection implements GameConnection {
  readonly mode = 'mcp_v2' as const
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
  /** Map from action name to v2 tool name */
  private actionToTool: Map<string, string> = new Map()
  /** Discovered v2 tool definitions */
  private v2Tools: V2ToolDef[] = []

  constructor(serverUrl: string) {
    this.baseUrl = serverUrl.replace(/\/$/, '') + '/mcp/v2'
  }

  async connect(): Promise<void> {
    await this.ensureConnected()
  }

  async login(username: string, password: string): Promise<LoginResult> {
    const toolName = this.actionToTool.get('login') || 'spacemolt_auth'
    const resp = await this.callTool(toolName, { action: 'login', username, password })
    if (resp.error) {
      return { success: false, error: resp.error.message }
    }
    const { parsed: result } = this.parseToolResult(resp.result)
    return {
      success: true,
      player_id: result?.player_id as string | undefined,
    }
  }

  async register(username: string, empire: string, code?: string): Promise<RegisterResult> {
    const toolName = this.actionToTool.get('register') || 'spacemolt_auth'
    const args: Record<string, unknown> = { action: 'register', username, empire }
    if (code) args.registration_code = code
    const resp = await this.callTool(toolName, args)
    if (resp.error) {
      return { success: false, error: resp.error.message }
    }
    const { parsed: result } = this.parseToolResult(resp.result)
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

    let toolName = this.actionToTool.get(command)
    let toolArgs: Record<string, unknown>

    if (toolName) {
      // Known command -- route to correct tool
      const hasAction = this.v2Tools.find(t => t.name === toolName)?.actions.length ?? 0
      toolArgs = hasAction > 0
        ? { action: command, ...(args || {}) }
        : { ...(args || {}) }
    } else if (this.v2Tools.some(t => t.name === command)) {
      // Command matches a tool name directly (e.g. "spacemolt_catalog")
      toolName = command
      toolArgs = { ...(args || {}) }
    } else {
      // Unknown command -- pass through to the main tool and let the server
      // handle it, matching how other protocols (HTTP, WS, MCP v1) behave.
      // The server will return a proper error with suggestions if invalid.
      toolName = this.actionToTool.get('get_state') ? (this.actionToTool.get('get_state')!) : 'spacemolt'
      toolArgs = { action: command, ...(args || {}) }
    }

    const resp = await this.callTool(toolName, toolArgs)

    if (resp.error) {
      return { error: { code: resp.error.code?.toString() || 'mcp_error', message: resp.error.message || 'Unknown error' } }
    }

    const { parsed: result, structured: structuredContent } = this.parseToolResult(resp.result)

    // Re-initialize on session expiry and retry once
    const errCode = (result?.error as Record<string, unknown> | undefined)?.code
    if (errCode === 'session_expired' || errCode === 'session_invalid') {
      this.sessionId = null
      this.connected = false
      await this.ensureConnected()
      return this.execute(command, args)
    }

    return { result, structuredContent }
  }

  /**
   * Return a formatted command list string for the LLM system prompt,
   * extracted from the discovered v2 tools.
   */
  getCommandList(): string {
    if (this.v2Tools.length === 0) return ''

    const lines: string[] = []
    for (const tool of this.v2Tools) {
      if (tool.actions.length === 0) {
        lines.push(`${tool.name}: (use directly with type, id, search, category params)`)
        continue
      }
      const queries = tool.actions.filter(a => isQueryAction(a))
      const mutations = tool.actions.filter(a => !isQueryAction(a))
      const parts: string[] = []
      if (mutations.length > 0) parts.push(mutations.join(', '))
      if (queries.length > 0) parts.push(`[free queries: ${queries.join(', ')}]`)
      lines.push(`${tool.name}: ${parts.join(' | ')}`)
    }
    lines.push('')
    lines.push('Tip: Use action="help" on any tool to see detailed parameter docs.')
    return lines.join('\n')
  }

  /** Number of discovered tools */
  get toolCount(): number {
    return this.actionToTool.size
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
          throw new Error('MCP v2 initialize failed: ' + JSON.stringify(resp.error))
        }
        await this.sendNotification('notifications/initialized', {})
        await this.discoverTools()
        this.connected = true
        this.startNotificationPolling()
        return
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt)
        await sleep(delay)
      }
    }
    throw lastError || new Error('Failed to connect to MCP v2 server')
  }

  private async discoverTools(): Promise<void> {
    const resp = await this.sendJsonRpc('tools/list', {})
    if (!resp.result) return

    const result = resp.result as { tools?: unknown[] }
    if (!Array.isArray(result.tools)) return

    for (const tool of result.tools) {
      const t = tool as Record<string, unknown>
      const name = t.name as string
      if (!name) continue

      const description = (t.description as string) || ''
      const schema = t.inputSchema as Record<string, unknown> | undefined
      const props = schema?.properties as Record<string, Record<string, unknown>> | undefined
      const hasActionParam = !!props?.action

      const actionEnum = props?.action?.enum as string[] | undefined
      const actions = actionEnum || (hasActionParam ? parseActionsFromDescription(description) : [])

      this.v2Tools.push({ name, description, actions })

      for (const action of actions) {
        this.actionToTool.set(action, name)
      }

      if (!hasActionParam) {
        this.actionToTool.set(name, name)
      }
    }
  }

  private startNotificationPolling(): void {
    if (this.notificationTimer) return
    this.notificationTimer = setInterval(() => {
      void this.pollNotifications()
    }, this.notificationPollIntervalMs)
  }

  private async pollNotifications(): Promise<void> {
    if (this.polling || !this.connected || this.notificationHandlers.length === 0) return
    const notifTool = this.actionToTool.get('get_notifications')
    if (!notifTool) return
    this.polling = true
    try {
      const resp = await this.callTool(notifTool, { action: 'get_notifications' })
      if (!this.connected) return
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

    const sid = resp.headers.get('Mcp-Session-Id')
    if (sid) this.sessionId = sid

    const contentType = resp.headers.get('content-type') || ''
    if (contentType.includes('text/event-stream')) {
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

  private parseToolResult(result: unknown): { parsed: Record<string, unknown> | null; structured: unknown } {
    if (!result) return { parsed: null, structured: null }
    const r = result as Record<string, unknown>
    // MCP v2 returns structuredContent with the actual JSON data (mutations only)
    if (r.structuredContent && typeof r.structuredContent === 'object') {
      return { parsed: r.structuredContent as Record<string, unknown>, structured: r.structuredContent }
    }
    if (r.content && Array.isArray(r.content)) {
      for (const block of r.content) {
        const b = block as Record<string, unknown>
        if (b.type === 'text' && typeof b.text === 'string') {
          try {
            const json = JSON.parse(b.text)
            return { parsed: json, structured: json }
          } catch {
            return { parsed: { text: b.text }, structured: null }
          }
        }
      }
    }
    return { parsed: r, structured: r }
  }
}

/**
 * Parse action names from a tool description. The v2 server lists actions as:
 *   action_name(params) -- description
 *   action_name -- description
 */
function parseActionsFromDescription(description: string): string[] {
  const actions: string[] = []
  const lines = description.split('\n')
  for (const line of lines) {
    const m = line.match(/^\s{2}(\w+)(?:\(| —)/)
    if (m) actions.push(m[1])
  }
  return actions
}

function isQueryAction(action: string): boolean {
  return /^(get_|view_|list_|search_|find_|browse_|read_|query_|estimate_|analyze_|forum_list|forum_get|captains_log_list|captains_log_get)/.test(action)
    || action === 'help'
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
