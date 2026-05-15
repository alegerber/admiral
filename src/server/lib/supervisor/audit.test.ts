import { describe, it, expect, beforeEach } from 'bun:test'
import { getDb } from '../db'
import { insertAudit, listAudit } from './audit'

// Use in-memory DB for tests
process.env.ADMIRAL_DB_PATH = ':memory:'

function resetDb() {
  const db = getDb()
  db.exec('DELETE FROM supervisor_audit')
  // Ensure at least one profile exists for FK tests
  db.exec(`INSERT OR IGNORE INTO profiles (id, name) VALUES ('p1', 'profile-one')`)
}

describe('audit', () => {
  beforeEach(resetDb)

  it('uses :memory: DB for tests (isolation check)', () => {
    const list = getDb().query('PRAGMA database_list').all() as Array<{ file: string }>
    // For :memory:, the file column is empty or ':memory:'
    expect(list[0].file === '' || list[0].file === ':memory:').toBe(true)
  })

  it('inserts a tick event with no target', () => {
    const id = insertAudit('tick', null, 'Watchdog tick started')
    expect(id).toBeGreaterThan(0)
    const rows = listAudit()
    expect(rows).toHaveLength(1)
    expect(rows[0].event_type).toBe('tick')
    expect(rows[0].target_profile_id).toBeNull()
    expect(rows[0].summary).toBe('Watchdog tick started')
  })

  it('inserts an anomaly event with target and JSON detail', () => {
    insertAudit('anomaly_detected', 'p1', 'cost spike', { window: 10, total: 0.7 })
    const rows = listAudit()
    expect(rows[0].target_profile_id).toBe('p1')
    expect(JSON.parse(rows[0].detail!)).toEqual({ window: 10, total: 0.7 })
  })

  it('lists audit entries newest first with limit', () => {
    insertAudit('tick', null, 'tick 1')
    insertAudit('tick', null, 'tick 2')
    insertAudit('tick', null, 'tick 3')
    const rows = listAudit({ limit: 2 })
    expect(rows).toHaveLength(2)
    expect(rows[0].summary).toBe('tick 3')
    expect(rows[1].summary).toBe('tick 2')
  })

  it('filters audit by target profile', () => {
    insertAudit('tick', null, 'global tick')
    insertAudit('anomaly_detected', 'p1', 'anomaly on p1')
    const rows = listAudit({ targetProfileId: 'p1' })
    expect(rows).toHaveLength(1)
    expect(rows[0].summary).toBe('anomaly on p1')
  })
})
