import { describe, it, expect, beforeEach } from 'bun:test'
import { getDb, addLogEntry } from '../db'
import { executeSupervisorTool, supervisorToolDefinitions } from './tools'
import { listAudit } from './audit'
import { listProposals } from './proposals'
import { getNotes } from './notes'

process.env.ADMIRAL_DB_PATH = ':memory:'

function resetDb() {
  const db = getDb()
  db.exec('DELETE FROM supervisor_audit')
  db.exec('DELETE FROM supervisor_proposals')
  db.exec('DELETE FROM supervisor_notes')
  db.exec('DELETE FROM log_entries')
  db.exec(`INSERT OR IGNORE INTO profiles (id, name) VALUES ('p1', 'profile-one')`)
}

interface NudgeCall { profileId: string; message: string }
function makeAgentManagerMock() {
  const nudges: NudgeCall[] = []
  return {
    nudges,
    nudge: (profileId: string, message: string) => { nudges.push({ profileId, message }) },
    getAgent: (_id: string) => ({ isConnected: true }),
  }
}

describe('supervisor tools', () => {
  beforeEach(resetDb)

  it('defines all six tools', () => {
    const names = supervisorToolDefinitions.map(t => t.name)
    expect(names).toEqual([
      'send_nudge',
      'propose_directive_change',
      'propose_pause',
      'propose_resume',
      'update_notes',
      'do_nothing',
    ])
  })

  it('send_nudge calls agentManager.nudge and logs to audit + sub-agent log', async () => {
    const mgr = makeAgentManagerMock()
    await executeSupervisorTool({ name: 'send_nudge', arguments: { message: 'try asteroid belt 7' } }, 'p1', mgr as any)
    expect(mgr.nudges).toEqual([{ profileId: 'p1', message: 'try asteroid belt 7' }])
    const audit = listAudit()
    expect(audit[0].event_type).toBe('nudge_sent')
    const logs = getDb().query(`SELECT * FROM log_entries WHERE profile_id = 'p1' AND type = 'supervisor_action'`).all()
    expect(logs).toHaveLength(1)
  })

  it('propose_directive_change creates a pending proposal', async () => {
    await executeSupervisorTool(
      { name: 'propose_directive_change', arguments: { new_directive: 'focus mining', reasoning: 'trading failed' } },
      'p1',
      makeAgentManagerMock() as any,
    )
    const proposals = listProposals({ status: 'pending' })
    expect(proposals).toHaveLength(1)
    expect(proposals[0].action).toBe('set_directive')
    expect(JSON.parse(proposals[0].payload)).toEqual({ directive: 'focus mining' })
    expect(proposals[0].reasoning).toBe('trading failed')
  })

  it('propose_pause and propose_resume create proposals with correct actions', async () => {
    await executeSupervisorTool({ name: 'propose_pause', arguments: { reasoning: 'looping' } }, 'p1', makeAgentManagerMock() as any)
    await executeSupervisorTool({ name: 'propose_resume', arguments: { reasoning: 'recovered' } }, 'p1', makeAgentManagerMock() as any)
    const proposals = listProposals({})
    expect(proposals.map(p => p.action).sort()).toEqual(['pause', 'resume'])
  })

  it('update_notes upserts notes', async () => {
    await executeSupervisorTool(
      { name: 'update_notes', arguments: { observations: 'A', last_strategy: 'B', open_concerns: 'C' } },
      'p1',
      makeAgentManagerMock() as any,
    )
    const n = getNotes('p1')
    expect(n.observations).toBe('A')
    expect(n.last_strategy).toBe('B')
    expect(n.open_concerns).toBe('C')
  })

  it('do_nothing only logs to audit', async () => {
    await executeSupervisorTool({ name: 'do_nothing', arguments: { reasoning: 'all good' } }, 'p1', makeAgentManagerMock() as any)
    const audit = listAudit()
    expect(audit[0].event_type).toBe('llm_call')  // do_nothing logs via audit
    // No proposals, no nudges
    expect(listProposals({}).length).toBe(0)
  })

  it('skips intervention if agent profile does not exist', async () => {
    const mgr = { nudges: [] as NudgeCall[], nudge: () => { throw new Error('should not be called') }, getAgent: () => undefined }
    await executeSupervisorTool({ name: 'send_nudge', arguments: { message: 'x' } }, 'nonexistent-profile', mgr as any)
    // It should not throw; instead log to audit as 'error' or 'supervisor_skip'
    const audit = listAudit()
    expect(audit.some(a => a.event_type === 'error' || a.event_type === 'supervisor_skip')).toBe(true)
  })
})
