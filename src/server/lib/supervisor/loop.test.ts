import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { getDb } from '../db'
import { runSupervisorTurn } from './loop'
import { saveConfig, DEFAULT_THRESHOLDS } from './config'
import { listAudit } from './audit'
import { getNotes } from './notes'
import { emptySignals } from './watchdog'

process.env.ADMIRAL_DB_PATH = ':memory:'

function resetDb() {
  const db = getDb()
  db.exec('DELETE FROM supervisor_audit')
  db.exec('DELETE FROM supervisor_notes')
  db.exec('DELETE FROM supervisor_proposals')
  db.exec('DELETE FROM log_entries')
  db.exec('DELETE FROM preferences')
  db.exec(`INSERT OR IGNORE INTO profiles (id, name) VALUES ('p1', 'profile-one')`)
  saveConfig({
    enabled: true, provider: 'anthropic', model: 'claude-opus-4-7',
    systemPrompt: '', tickIntervalSeconds: 60, thresholds: DEFAULT_THRESHOLDS,
  })
}

const fakeAgentManager = {
  nudge: () => {},
  getAgent: () => ({ isConnected: true }),
  getStatus: () => ({ connected: true, running: true, paused: false, activity: 'mining', gameState: { credits: 100 } }),
}

const fakeProvider = {
  resolveModel: () => ({ contextWindow: 200_000 } as any),
  resolveApiKey: () => 'test-key',
}

describe('supervisor loop', () => {
  beforeEach(resetDb)

  it('aborts if supervisor is disabled', async () => {
    saveConfig({
      enabled: false, provider: '', model: '',
      systemPrompt: '', tickIntervalSeconds: 60, thresholds: DEFAULT_THRESHOLDS,
    })
    const completeMock = mock(async () => ({ content: [], usage: { cost: { total: 0 } } } as any))
    await runSupervisorTurn('p1', emptySignals(), {
      manager: fakeAgentManager as any,
      provider: fakeProvider as any,
      complete: completeMock as any,
    })
    expect(completeMock).not.toHaveBeenCalled()
  })

  it('logs llm_call to audit and processes tool calls', async () => {
    const completeMock = mock(async () => ({
      content: [
        { type: 'toolCall', id: 't1', name: 'update_notes', arguments: { observations: 'o', last_strategy: 's', open_concerns: 'c' } },
        { type: 'toolCall', id: 't2', name: 'do_nothing', arguments: { reasoning: 'fine' } },
      ],
      usage: { input: 100, output: 50, cost: { total: 0.1 } },
      model: 'claude-opus-4-7',
      provider: 'anthropic',
      stopReason: 'end_turn',
    } as any))
    await runSupervisorTurn('p1', emptySignals(), {
      manager: fakeAgentManager as any,
      provider: fakeProvider as any,
      complete: completeMock as any,
    })
    expect(completeMock).toHaveBeenCalled()
    expect(listAudit().some(a => a.event_type === 'llm_call')).toBe(true)
    expect(getNotes('p1').observations).toBe('o')
  })

  it('handles LLM call failure gracefully', async () => {
    const completeMock = mock(async () => { throw new Error('rate limit') })
    await runSupervisorTurn('p1', emptySignals(), {
      manager: fakeAgentManager as any,
      provider: fakeProvider as any,
      complete: completeMock as any,
    })
    const errors = listAudit({ eventType: 'error' })
    expect(errors).toHaveLength(1)
    expect(errors[0].summary).toContain('rate limit')
  })
})
