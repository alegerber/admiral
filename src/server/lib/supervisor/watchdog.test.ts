import { describe, it, expect, beforeEach } from 'bun:test'
import { getDb, addLogEntry } from '../db'
import { computeSignals, anyFired, signalSummary } from './watchdog'
import { DEFAULT_THRESHOLDS } from './config'

process.env.ADMIRAL_DB_PATH = ':memory:'

function resetDb() {
  const db = getDb()
  db.exec('DELETE FROM log_entries')
  db.exec(`INSERT OR IGNORE INTO profiles (id, name) VALUES ('p1', 'profile-one')`)
}

describe('watchdog signals', () => {
  beforeEach(resetDb)

  it('no signals fire on a freshly created profile with no logs', () => {
    const sig = computeSignals('p1', DEFAULT_THRESHOLDS, { isRunning: true, isPaused: false, lastActivityChangeMs: Date.now(), gameState: null })
    expect(anyFired(sig)).toBe(false)
  })

  it('activity_stuck fires when activity unchanged > threshold', () => {
    const longAgo = Date.now() - 6 * 60_000
    const sig = computeSignals('p1', DEFAULT_THRESHOLDS, { isRunning: true, isPaused: false, lastActivityChangeMs: longAgo, gameState: null })
    expect(sig.activity_stuck).toBe(true)
  })

  it('cost_spike fires when llm_call costs exceed threshold', () => {
    // Insert 3 llm_call log entries totaling > $0.50
    const details = [
      JSON.stringify({ usage: { cost: { total: 0.20 } } }),
      JSON.stringify({ usage: { cost: { total: 0.20 } } }),
      JSON.stringify({ usage: { cost: { total: 0.25 } } }),
    ]
    for (const d of details) addLogEntry('p1', 'llm_call', 'x', d)
    const sig = computeSignals('p1', DEFAULT_THRESHOLDS, { isRunning: true, isPaused: false, lastActivityChangeMs: Date.now(), gameState: null })
    expect(sig.cost_spike).toBe(true)
  })

  it('error_burst fires when >= threshold error logs in window', () => {
    for (let i = 0; i < 5; i++) addLogEntry('p1', 'error', `err ${i}`)
    const sig = computeSignals('p1', DEFAULT_THRESHOLDS, { isRunning: true, isPaused: false, lastActivityChangeMs: Date.now(), gameState: null })
    expect(sig.error_burst).toBe(true)
  })

  it('does not fire signals when agent is paused', () => {
    for (let i = 0; i < 5; i++) addLogEntry('p1', 'error', `err ${i}`)
    const sig = computeSignals('p1', DEFAULT_THRESHOLDS, { isRunning: true, isPaused: true, lastActivityChangeMs: Date.now() - 999999, gameState: null })
    expect(anyFired(sig)).toBe(false)
  })

  it('signalSummary produces human-readable text for fired signals', () => {
    const sig = { activity_stuck: true, no_llm_progress: false, cost_spike: true, max_rounds_repeated: false, state_log_mismatch: false, error_burst: false }
    const text = signalSummary(sig)
    expect(text).toContain('activity_stuck')
    expect(text).toContain('cost_spike')
    expect(text).not.toContain('no_llm_progress')
  })
})
