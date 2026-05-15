import { describe, it, expect, beforeEach } from 'bun:test'
import { getDb } from '../db'
import { loadConfig, saveConfig, DEFAULT_THRESHOLDS } from './config'

process.env.ADMIRAL_DB_PATH = ':memory:'

function resetDb() {
  getDb().exec('DELETE FROM preferences')
}

describe('supervisor config', () => {
  beforeEach(resetDb)

  it('returns defaults when no preferences set', () => {
    const cfg = loadConfig()
    expect(cfg.enabled).toBe(false)
    expect(cfg.tickIntervalSeconds).toBe(60)
    expect(cfg.thresholds).toEqual(DEFAULT_THRESHOLDS)
    expect(cfg.systemPrompt).toBe('')
  })

  it('saves and reloads config', () => {
    saveConfig({
      enabled: true,
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      systemPrompt: '',
      tickIntervalSeconds: 90,
      thresholds: { ...DEFAULT_THRESHOLDS, activity_stuck_minutes: 3 },
    })
    const cfg = loadConfig()
    expect(cfg.enabled).toBe(true)
    expect(cfg.provider).toBe('anthropic')
    expect(cfg.model).toBe('claude-opus-4-7')
    expect(cfg.tickIntervalSeconds).toBe(90)
    expect(cfg.thresholds.activity_stuck_minutes).toBe(3)
  })

  it('falls back to defaults for malformed JSON thresholds', () => {
    getDb().query('INSERT INTO preferences (key, value) VALUES (?, ?)').run(
      'supervisor.watchdog_thresholds', '{not json}',
    )
    const cfg = loadConfig()
    expect(cfg.thresholds).toEqual(DEFAULT_THRESHOLDS)
  })

  it('falls back to defaults when thresholds JSON is an array or null', () => {
    // Array case
    getDb().query('UPDATE preferences SET value = ? WHERE key = ?')
      .run('[1,2,3]', 'supervisor.watchdog_thresholds')
    // If the row didn't exist (fresh DB), insert it
    if (getDb().query('SELECT 1 FROM preferences WHERE key = ?').get('supervisor.watchdog_thresholds') === null) {
      getDb().query('INSERT INTO preferences (key, value) VALUES (?, ?)')
        .run('supervisor.watchdog_thresholds', '[1,2,3]')
    }
    let cfg = loadConfig()
    expect(cfg.thresholds).toEqual(DEFAULT_THRESHOLDS)

    // null case
    getDb().query('UPDATE preferences SET value = ? WHERE key = ?')
      .run('null', 'supervisor.watchdog_thresholds')
    cfg = loadConfig()
    expect(cfg.thresholds).toEqual(DEFAULT_THRESHOLDS)
  })

  it('falls back to default tickIntervalSeconds when stored value is non-numeric', () => {
    getDb().query('INSERT INTO preferences (key, value) VALUES (?, ?)')
      .run('supervisor.tick_interval_seconds', 'not-a-number')
    const cfg = loadConfig()
    expect(cfg.tickIntervalSeconds).toBe(60)
  })
})
