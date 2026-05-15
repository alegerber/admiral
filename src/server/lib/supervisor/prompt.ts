import type { Signals } from './watchdog'
import type { Notes } from './notes'
import type { ProposalRow } from './proposals'
import type { LogEntry } from '../../../shared/types'

export const DEFAULT_SYSTEM_PROMPT = `You are the Admiral Supervisor. Your role is to observe sub-agents playing SpaceMolt and intervene when they are stuck, wasting resources, or pursuing failed strategies.

You see: persistent notes you wrote previously, the sub-agent's recent log entries, current game state, the heuristic signals that triggered this invocation.

Authority levels:
- Nudges are immediate. They inject a short message into the sub-agent's context. Use them for tactical hints ("there's a closer asteroid belt at...", "your fuel is low, refuel before traveling").
- Directive changes require human approval. They replace the sub-agent's high-level strategy. Use sparingly — only when the current strategy is clearly failing.
- Pause/Resume require human approval. Only when something is structurally broken (e.g., the sub-agent keeps hitting the same error).

Always update your notes at the end of every invocation. Be concise — single-sentence observations beat paragraphs. If everything looks fine, call \`do_nothing\` with a one-line reason. Never speculate without evidence in the logs or game state.`

export function buildSystemPrompt(override: string): string {
  return override.trim() ? override : DEFAULT_SYSTEM_PROMPT
}

export interface UserContextInput {
  profileId: string
  profileName: string
  notes: Notes
  signals: Signals
  logs: LogEntry[]
  gameState: Record<string, unknown> | null
  pendingProposals: ProposalRow[]
}

export function buildUserContext(input: UserContextInput): string {
  const firedSignals = (Object.keys(input.signals) as (keyof Signals)[])
    .filter(k => input.signals[k])
    .join(', ') || 'none'

  const logsSection = input.logs.length === 0
    ? '(no recent logs)'
    : input.logs.map(l => `[${l.timestamp}] ${l.type}: ${l.summary ?? ''}`).join('\n')

  const stateSection = input.gameState
    ? JSON.stringify(input.gameState, null, 2)
    : '(no game state)'

  const proposalsSection = input.pendingProposals.length === 0
    ? '(no pending proposals)'
    : input.pendingProposals.map(p => `#${p.id} ${p.action}: ${p.reasoning}`).join('\n')

  return `## Sub-Agent: ${input.profileName} (id: ${input.profileId})

### Triggering signals
${firedSignals}

### Your previous notes
- Observations: ${input.notes.observations || '(empty)'}
- Last known strategy: ${input.notes.last_strategy || '(empty)'}
- Open concerns: ${input.notes.open_concerns || '(empty)'}
- Last updated: ${input.notes.updated_at || '(never)'}

### Recent log entries (newest first)
${logsSection}

### Current game state
${stateSection}

### Pending proposals for this sub-agent
${proposalsSection}

Decide what to do. Call exactly the tools you need (often zero or one). Always end by calling update_notes with refreshed observations.`
}
