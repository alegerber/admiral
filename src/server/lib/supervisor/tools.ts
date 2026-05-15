import { addLogEntry, getProfile } from '../db'
import { insertAudit } from './audit'
import { createProposal } from './proposals'
import { upsertNotes } from './notes'

export interface SupervisorToolDefinition {
  name: string
  description: string
  parameters: { type: 'object'; properties: Record<string, unknown>; required: string[] }
}

export const supervisorToolDefinitions: SupervisorToolDefinition[] = [
  {
    name: 'send_nudge',
    description: 'AUTONOMOUS. Sends a short message into the sub-agent\'s context. Use for tactical hints.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The nudge message (1-2 sentences)' },
      },
      required: ['message'],
    },
  },
  {
    name: 'propose_directive_change',
    description: 'PROPOSAL (needs human approval). Replaces the sub-agent\'s high-level strategy. Use sparingly.',
    parameters: {
      type: 'object',
      properties: {
        new_directive: { type: 'string', description: 'The complete replacement directive' },
        reasoning: { type: 'string', description: 'Why this change is needed' },
      },
      required: ['new_directive', 'reasoning'],
    },
  },
  {
    name: 'propose_pause',
    description: 'PROPOSAL (needs human approval). Pause the sub-agent. Only when structurally broken.',
    parameters: {
      type: 'object',
      properties: {
        reasoning: { type: 'string', description: 'Why pausing is needed' },
      },
      required: ['reasoning'],
    },
  },
  {
    name: 'propose_resume',
    description: 'PROPOSAL (needs human approval). Resume a paused sub-agent.',
    parameters: {
      type: 'object',
      properties: {
        reasoning: { type: 'string', description: 'Why resuming is appropriate now' },
      },
      required: ['reasoning'],
    },
  },
  {
    name: 'update_notes',
    description: 'AUTONOMOUS. Update your persistent notes for this sub-agent. Always call this at the end.',
    parameters: {
      type: 'object',
      properties: {
        observations: { type: 'string', description: 'What you observe now' },
        last_strategy: { type: 'string', description: 'Sub-agent\'s current apparent strategy' },
        open_concerns: { type: 'string', description: 'Issues to keep watching' },
      },
      required: ['observations', 'last_strategy', 'open_concerns'],
    },
  },
  {
    name: 'do_nothing',
    description: 'AUTONOMOUS. No action taken. Use when everything looks fine.',
    parameters: {
      type: 'object',
      properties: {
        reasoning: { type: 'string', description: 'Brief reason for inaction' },
      },
      required: ['reasoning'],
    },
  },
]

export interface AgentManagerLike {
  nudge(profileId: string, message: string): void
  getAgent(profileId: string): { isConnected: boolean } | undefined
}

export interface ToolCallInput {
  name: string
  arguments: Record<string, unknown>
}

export async function executeSupervisorTool(
  call: ToolCallInput,
  profileId: string,
  manager: AgentManagerLike,
): Promise<void> {
  const profileExists = !!getProfile(profileId)
  if (!profileExists) {
    // Profile may have been deleted between supervisor call and tool execution.
    // Audit with null target since FK would otherwise fail.
    insertAudit('error', null, `Tool ${call.name} skipped: profile ${profileId} not found`, { call, profileId })
    return
  }

  switch (call.name) {
    case 'send_nudge': {
      const message = String(call.arguments.message ?? '')
      const agent = manager.getAgent(profileId)
      if (!agent?.isConnected) {
        insertAudit('supervisor_skip', profileId, `Nudge skipped: agent disconnected`, { call })
        return
      }
      manager.nudge(profileId, message)
      insertAudit('nudge_sent', profileId, `Nudge sent: ${message.slice(0, 80)}`, { message })
      addLogEntry(profileId, 'supervisor_action', `Supervisor nudge: ${message}`)
      return
    }

    case 'propose_directive_change': {
      const newDirective = String(call.arguments.new_directive ?? '')
      const reasoning = String(call.arguments.reasoning ?? '')
      const id = createProposal({ profileId, action: 'set_directive', payload: { directive: newDirective }, reasoning })
      insertAudit('proposal_created', profileId, `Directive change proposed (#${id})`, { id, reasoning })
      return
    }

    case 'propose_pause': {
      const reasoning = String(call.arguments.reasoning ?? '')
      const id = createProposal({ profileId, action: 'pause', payload: {}, reasoning })
      insertAudit('proposal_created', profileId, `Pause proposed (#${id})`, { id, reasoning })
      return
    }

    case 'propose_resume': {
      const reasoning = String(call.arguments.reasoning ?? '')
      const id = createProposal({ profileId, action: 'resume', payload: {}, reasoning })
      insertAudit('proposal_created', profileId, `Resume proposed (#${id})`, { id, reasoning })
      return
    }

    case 'update_notes': {
      const observations = String(call.arguments.observations ?? '')
      const last_strategy = String(call.arguments.last_strategy ?? '')
      const open_concerns = String(call.arguments.open_concerns ?? '')
      upsertNotes(profileId, { observations, last_strategy, open_concerns })
      insertAudit('notes_updated', profileId, 'Notes updated', { observations, last_strategy, open_concerns })
      return
    }

    case 'do_nothing': {
      const reasoning = String(call.arguments.reasoning ?? '')
      insertAudit('do_nothing', profileId, `do_nothing: ${reasoning.slice(0, 80)}`, { reasoning })
      return
    }

    default:
      insertAudit('error', profileId, `Unknown tool: ${call.name}`, { call })
  }
}
