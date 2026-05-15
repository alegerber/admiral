import { describe, it, expect, beforeEach } from 'bun:test'
import { getDb } from '../db'
import { getNotes, upsertNotes, deleteNotes } from './notes'

process.env.ADMIRAL_DB_PATH = ':memory:'

function resetDb() {
  const db = getDb()
  db.exec('DELETE FROM supervisor_notes')
  db.exec(`INSERT OR IGNORE INTO profiles (id, name) VALUES ('p1', 'profile-one')`)
}

describe('notes', () => {
  beforeEach(resetDb)

  it('returns empty defaults when no row exists', () => {
    const n = getNotes('p1')
    expect(n.observations).toBe('')
    expect(n.last_strategy).toBe('')
    expect(n.open_concerns).toBe('')
  })

  it('upserts new notes', () => {
    upsertNotes('p1', { observations: 'mining slow', last_strategy: 'kupfer', open_concerns: 'no fuel' })
    const n = getNotes('p1')
    expect(n.observations).toBe('mining slow')
    expect(n.last_strategy).toBe('kupfer')
    expect(n.open_concerns).toBe('no fuel')
  })

  it('upserts overwrites existing fields', () => {
    upsertNotes('p1', { observations: 'v1', last_strategy: 's1', open_concerns: 'c1' })
    upsertNotes('p1', { observations: 'v2', last_strategy: 's2', open_concerns: 'c2' })
    const n = getNotes('p1')
    expect(n.observations).toBe('v2')
    expect(n.last_strategy).toBe('s2')
    expect(n.open_concerns).toBe('c2')
  })

  it('cascade-deletes when profile is deleted', () => {
    upsertNotes('p1', { observations: 'x', last_strategy: 'y', open_concerns: 'z' })
    getDb().query('DELETE FROM profiles WHERE id = ?').run('p1')
    const n = getNotes('p1')
    expect(n.observations).toBe('')
  })

  it('deleteNotes removes a row', () => {
    upsertNotes('p1', { observations: 'x', last_strategy: '', open_concerns: '' })
    deleteNotes('p1')
    const n = getNotes('p1')
    expect(n.observations).toBe('')
  })
})
