import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { getDb } from '../db'
import { SupervisorManager } from './manager'
import { saveConfig, DEFAULT_THRESHOLDS } from './config'
import { listAudit } from './audit'

process.env.ADMIRAL_DB_PATH = ':memory:'

function resetDb() {
  const db = getDb()
  db.exec('DELETE FROM supervisor_audit')
  db.exec('DELETE FROM supervisor_notes')
  db.exec('DELETE FROM supervisor_proposals')
  db.exec('DELETE FROM log_entries')
  db.exec('DELETE FROM preferences')
  db.exec(`DELETE FROM profiles WHERE id IN ('p1', 'p2')`)
  db.exec(`INSERT INTO profiles (id, name) VALUES ('p1', 'profile-one')`)
  db.exec(`INSERT INTO profiles (id, name) VALUES ('p2', 'profile-two')`)
  saveConfig({
    enabled: true, provider: 'anthropic', model: 'claude-opus-4-7',
    systemPrompt: '', tickIntervalSeconds: 60, thresholds: DEFAULT_THRESHOLDS,
  })
}

function makeManager() {
  const runs: string[] = []
  const runSupervisorTurn = mock(async (profileId: string) => { runs.push(profileId) })
  const fakeAgentManager = {
    listActive: () => ['p1', 'p2'],
    getStatus: (_id: string) => ({ connected: true, running: true, paused: false, activity: 'idle', gameState: null }),
    nudge: () => {},
    getAgent: () => ({ isConnected: true }),
  }
  const mgr = new SupervisorManager({
    agentManager: fakeAgentManager as any,
    runSupervisorTurn: runSupervisorTurn as any,
    getActivitySnapshot: () => ({ lastActivityChangeMs: Date.now() - 999_999_999 }),  // very old → activity_stuck fires
  })
  return { mgr, runs, runSupervisorTurn }
}

describe('SupervisorManager', () => {
  beforeEach(resetDb)

  it('tick runs supervisor for all active sub-agents with fired signals', async () => {
    const { mgr, runs } = makeManager()
    await mgr.tick()
    expect(runs.sort()).toEqual(['p1', 'p2'])
    expect(listAudit({ eventType: 'tick' })).toHaveLength(1)
    expect(listAudit({ eventType: 'anomaly_detected' })).toHaveLength(2)
  })

  it('tick is a no-op when supervisor is disabled', async () => {
    saveConfig({ enabled: false, provider: '', model: '', systemPrompt: '', tickIntervalSeconds: 60, thresholds: DEFAULT_THRESHOLDS })
    const { mgr, runs } = makeManager()
    await mgr.tick()
    expect(runs).toHaveLength(0)
    expect(listAudit({ eventType: 'tick' })).toHaveLength(0)
  })

  it('semaphore caps concurrent runs', async () => {
    saveConfig({
      enabled: true, provider: 'anthropic', model: 'claude-opus-4-7',
      systemPrompt: '', tickIntervalSeconds: 60,
      thresholds: { ...DEFAULT_THRESHOLDS, max_concurrent_supervisor_runs: 1 },
    })
    let resolveFirst: (() => void) | null = null
    const slow = new Promise<void>(r => { resolveFirst = r })
    const runMock = mock(async (profileId: string) => {
      if (profileId === 'p1') await slow
    })
    const fakeAgentManager = {
      listActive: () => ['p1', 'p2'],
      getStatus: () => ({ connected: true, running: true, paused: false, activity: 'idle', gameState: null }),
      nudge: () => {}, getAgent: () => ({ isConnected: true }),
    }
    const mgr = new SupervisorManager({
      agentManager: fakeAgentManager as any,
      runSupervisorTurn: runMock as any,
      getActivitySnapshot: () => ({ lastActivityChangeMs: Date.now() - 999_999_999 }),
    })
    const p = mgr.tick()
    // p2 should be dropped because p1 holds the only slot
    await new Promise(r => setTimeout(r, 20))
    const skips = listAudit({ eventType: 'supervisor_skip' })
    expect(skips.length).toBeGreaterThanOrEqual(1)
    resolveFirst!()
    await p
  })

  it('onLlmCall triggers supervisor when cost_spike fires', async () => {
    const { mgr, runs } = makeManager()
    // Insert llm_call logs totaling > $0.50
    for (let i = 0; i < 3; i++) {
      const db = getDb()
      db.query('INSERT INTO log_entries (profile_id, type, summary, detail) VALUES (?, ?, ?, ?)').run(
        'p1', 'llm_call', 'x', JSON.stringify({ usage: { cost: { total: 0.20 } } }),
      )
    }
    mgr.onLlmCall('p1')
    await new Promise(r => setTimeout(r, 10))
    expect(runs).toContain('p1')
  })
})
