import { describe, it, expect, beforeEach } from 'bun:test'
import { getDb, addLogEntry, setLogEntryHook } from './db'

process.env.ADMIRAL_DB_PATH = ':memory:'

function resetDb() {
  const db = getDb()
  db.exec('DELETE FROM log_entries')
  db.exec(`INSERT OR IGNORE INTO profiles (id, name) VALUES ('p1', 'profile-one')`)
  setLogEntryHook(null)
}

describe('addLogEntry hook', () => {
  beforeEach(resetDb)

  it('does not fire hook when none is set', () => {
    addLogEntry('p1', 'llm_call', 'x')
    // No assertion — the test passes if no error is thrown
    expect(true).toBe(true)
  })

  it('fires hook for llm_call entries', () => {
    const calls: Array<{ profileId: string; type: string }> = []
    setLogEntryHook((profileId, type) => calls.push({ profileId, type }))
    addLogEntry('p1', 'llm_call', 'x')
    expect(calls).toEqual([{ profileId: 'p1', type: 'llm_call' }])
  })

  it('does NOT fire hook for non-llm_call entries', () => {
    const calls: Array<{ profileId: string; type: string }> = []
    setLogEntryHook((profileId, type) => calls.push({ profileId, type }))
    addLogEntry('p1', 'error', 'something broke')
    addLogEntry('p1', 'system', 'note')
    addLogEntry('p1', 'tool_call', 'mine()')
    expect(calls).toEqual([])
  })

  it('swallows hook exceptions without breaking the insert', () => {
    setLogEntryHook(() => { throw new Error('hook went boom') })
    const id = addLogEntry('p1', 'llm_call', 'should still log')
    expect(id).toBeGreaterThan(0)  // INSERT succeeded
    const row = getDb().query('SELECT summary FROM log_entries WHERE id = ?').get(id) as { summary: string }
    expect(row.summary).toBe('should still log')
  })

  it('setLogEntryHook(null) removes the hook', () => {
    const calls: number[] = []
    setLogEntryHook(() => calls.push(1))
    addLogEntry('p1', 'llm_call', 'a')
    setLogEntryHook(null)
    addLogEntry('p1', 'llm_call', 'b')
    expect(calls).toHaveLength(1)
  })
})
