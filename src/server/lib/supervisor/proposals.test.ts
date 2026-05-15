import { describe, it, expect, beforeEach } from 'bun:test'
import { getDb } from '../db'
import {
  createProposal,
  listProposals,
  getProposal,
  setProposalStatus,
  expireOldProposals,
} from './proposals'

process.env.ADMIRAL_DB_PATH = ':memory:'

function resetDb() {
  const db = getDb()
  db.exec('DELETE FROM supervisor_proposals')
  db.exec(`INSERT OR IGNORE INTO profiles (id, name) VALUES ('p1', 'profile-one')`)
}

describe('proposals', () => {
  beforeEach(resetDb)

  it('creates a pending proposal', () => {
    const id = createProposal({
      profileId: 'p1',
      action: 'set_directive',
      payload: { directive: 'new goal' },
      reasoning: 'stuck for 30 min',
    })
    const p = getProposal(id)!
    expect(p.action).toBe('set_directive')
    expect(p.status).toBe('pending')
    expect(JSON.parse(p.payload)).toEqual({ directive: 'new goal' })
  })

  it('lists pending proposals only', () => {
    createProposal({ profileId: 'p1', action: 'pause', payload: {}, reasoning: 'r1' })
    const id2 = createProposal({ profileId: 'p1', action: 'resume', payload: {}, reasoning: 'r2' })
    setProposalStatus(id2, 'applied')
    const pending = listProposals({ status: 'pending' })
    expect(pending).toHaveLength(1)
    expect(pending[0].action).toBe('pause')
  })

  it('setProposalStatus updates status and resolved_at', () => {
    const id = createProposal({ profileId: 'p1', action: 'pause', payload: {}, reasoning: 'r' })
    setProposalStatus(id, 'rejected')
    const p = getProposal(id)!
    expect(p.status).toBe('rejected')
    expect(p.resolved_at).not.toBeNull()
  })

  it('setProposalStatus is a no-op on non-pending rows', () => {
    const id = createProposal({ profileId: 'p1', action: 'pause', payload: {}, reasoning: 'r' })
    setProposalStatus(id, 'applied')
    const firstResolvedAt = getProposal(id)!.resolved_at
    expect(firstResolvedAt).not.toBeNull()

    // Attempt to overwrite an already-resolved proposal — must be a no-op
    setProposalStatus(id, 'rejected')
    const p = getProposal(id)!
    expect(p.status).toBe('applied')  // status unchanged
    expect(p.resolved_at).toBe(firstResolvedAt)  // resolved_at unchanged
  })

  it('expireOldProposals marks old pending as expired', () => {
    // Insert a proposal with manually backdated created_at
    const db = getDb()
    db.exec(`
      INSERT INTO supervisor_proposals (profile_id, action, payload, reasoning, created_at)
      VALUES ('p1', 'pause', '{}', 'old', datetime('now', '-10 hours'))
    `)
    db.exec(`
      INSERT INTO supervisor_proposals (profile_id, action, payload, reasoning, created_at)
      VALUES ('p1', 'pause', '{}', 'fresh', datetime('now'))
    `)
    const expired = expireOldProposals(6)
    expect(expired).toBe(1)
    const all = listProposals({})
    const oldOne = all.find(p => p.reasoning === 'old')!
    const freshOne = all.find(p => p.reasoning === 'fresh')!
    expect(oldOne.status).toBe('expired')
    expect(freshOne.status).toBe('pending')
  })
})
