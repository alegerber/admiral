import type { Model, Context, AssistantMessage, ToolCall } from '@mariozechner/pi-ai'
import { getProfile, getLogEntries } from '../db'
import { loadConfig } from './config'
import { getNotes } from './notes'
import { listProposals } from './proposals'
import { insertAudit } from './audit'
import { buildSystemPrompt, buildUserContext } from './prompt'
import { supervisorToolDefinitions, executeSupervisorTool, type AgentManagerLike } from './tools'
import type { Signals } from './watchdog'

export interface ProviderResolver {
  resolveModel(provider: string, modelId: string): Model<any>
  resolveApiKey(provider: string): string
}

export interface CompleteFn {
  (model: Model<any>, context: Context, opts: { apiKey: string; maxTokens: number; tools: unknown[] }): Promise<AssistantMessage>
}

export interface RunSupervisorTurnDeps {
  manager: AgentManagerLike & { getStatus(profileId: string): { gameState: Record<string, unknown> | null } }
  provider: ProviderResolver
  complete: CompleteFn
}

export async function runSupervisorTurn(
  profileId: string,
  signals: Signals,
  deps: RunSupervisorTurnDeps,
): Promise<void> {
  const cfg = loadConfig()
  if (!cfg.enabled) return

  const profile = getProfile(profileId)
  if (!profile) {
    insertAudit('error', profileId, 'Supervisor run skipped: profile not found')
    return
  }
  const profileName = profile.name

  const notes = getNotes(profileId)
  const logs = getLogEntries(profileId, undefined, 30)
  const gameState = deps.manager.getStatus(profileId).gameState
  const pendingProposals = listProposals({ profileId, status: 'pending' })

  const systemPrompt = buildSystemPrompt(cfg.systemPrompt)
  const userContent = buildUserContext({
    profileId, profileName, notes, signals, logs, gameState, pendingProposals,
  })

  const context: Context = {
    systemPrompt,
    messages: [{ role: 'user', content: userContent, timestamp: Date.now() }],
  }

  // We audit the attempt BEFORE calling complete() so failed attempts are still counted.
  // This means a failed LLM call produces two audit rows: one 'llm_call' (attempt) and one 'error' (outcome).
  insertAudit('llm_call', profileId, `Supervisor invoked for ${profileName}`, { signals })

  let response: AssistantMessage
  try {
    const model = deps.provider.resolveModel(cfg.provider, cfg.model)
    const apiKey = deps.provider.resolveApiKey(cfg.provider)
    response = await deps.complete(model, context, {
      apiKey,
      maxTokens: 1500,
      tools: supervisorToolDefinitions,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    insertAudit('error', profileId, `LLM call failed: ${message}`, { error: message })
    return
  }

  const toolCalls = response.content.filter((c): c is ToolCall => c.type === 'toolCall')

  for (const call of toolCalls) {
    try {
      await executeSupervisorTool(
        { name: call.name, arguments: call.arguments ?? {} },
        profileId,
        deps.manager,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      insertAudit('error', profileId, `Tool ${call.name} failed: ${message}`, { error: message })
    }
  }
}
