import { describe, it, expect } from 'bun:test'
import { buildSystemPrompt, buildUserContext } from './prompt'
import type { Signals } from './watchdog'
import type { Notes } from './notes'

describe('prompt builder', () => {
  it('default system prompt mentions authority levels', () => {
    const p = buildSystemPrompt('')
    expect(p).toContain('Nudges')
    expect(p).toContain('Directive')
    expect(p).toContain('Pause')
    expect(p).toContain('Resume')
    expect(p).toContain('notes')
  })

  it('uses user override if provided', () => {
    const p = buildSystemPrompt('CUSTOM PROMPT HERE')
    expect(p).toBe('CUSTOM PROMPT HERE')
  })

  it('user context includes notes, signals, logs, state', () => {
    const notes: Notes = { profile_id: 'p1', observations: 'obs', last_strategy: 'ls', open_concerns: 'oc', updated_at: '2026-05-15' }
    const signals: Signals = { activity_stuck: true, no_llm_progress: false, cost_spike: false, max_rounds_repeated: false, state_log_mismatch: false, error_burst: false }
    const ctx = buildUserContext({
      profileId: 'p1',
      profileName: 'TestProfile',
      notes,
      signals,
      logs: [{ id: 1, profile_id: 'p1', timestamp: '2026-05-15', type: 'tool_call', summary: 'mine()', detail: null }],
      gameState: { credits: 1234 },
      pendingProposals: [],
    })
    expect(ctx).toContain('TestProfile')
    expect(ctx).toContain('obs')
    expect(ctx).toContain('activity_stuck')
    expect(ctx).toContain('mine()')
    expect(ctx).toContain('1234')
  })
})
