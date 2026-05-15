import { getDb } from '../db'
import type { WatchdogThresholds } from './config'

export interface Signals {
  activity_stuck: boolean
  no_llm_progress: boolean
  cost_spike: boolean
  max_rounds_repeated: boolean
  state_log_mismatch: boolean
  error_burst: boolean
}

export interface AgentSnapshot {
  isRunning: boolean
  isPaused: boolean
  lastActivityChangeMs: number
  gameState: Record<string, unknown> | null
}

export function emptySignals(): Signals {
  return {
    activity_stuck: false,
    no_llm_progress: false,
    cost_spike: false,
    max_rounds_repeated: false,
    state_log_mismatch: false,
    error_burst: false,
  }
}

export function anyFired(s: Signals): boolean {
  return s.activity_stuck || s.no_llm_progress || s.cost_spike
    || s.max_rounds_repeated || s.state_log_mismatch || s.error_burst
}

export function signalSummary(s: Signals): string {
  return (Object.keys(s) as (keyof Signals)[]).filter(k => s[k]).join(', ')
}

export function computeSignals(
  profileId: string,
  t: WatchdogThresholds,
  snap: AgentSnapshot,
): Signals {
  const sig = emptySignals()

  // Don't fire signals on paused or non-running agents
  if (!snap.isRunning || snap.isPaused) return sig

  const now = Date.now()
  const minutesSinceActivity = (now - snap.lastActivityChangeMs) / 60_000

  if (minutesSinceActivity >= t.activity_stuck_minutes) {
    sig.activity_stuck = true
  }

  // no_llm_progress: any llm_call log in last X minutes?
  const llmCallCount = countRecentLogs(profileId, 'llm_call', t.no_llm_progress_minutes)
  if (llmCallCount === 0 && minutesSinceActivity >= t.no_llm_progress_minutes) {
    sig.no_llm_progress = true
  }

  // cost_spike: sum of usage.cost.total in last X minutes
  const totalCost = sumLlmCallCost(profileId, t.cost_spike_window_minutes)
  if (totalCost >= t.cost_spike_threshold_usd) {
    sig.cost_spike = true
  }

  // max_rounds_repeated
  const maxRoundsCount = countLogsMatching(profileId, 'system', '%Reached max tool rounds%', t.max_rounds_window_hours * 60)
  if (maxRoundsCount >= t.max_rounds_count_threshold) {
    sig.max_rounds_repeated = true
  }

  // error_burst
  const errorCount = countRecentLogs(profileId, 'error', t.error_burst_window_minutes)
  if (errorCount >= t.error_burst_count_threshold) {
    sig.error_burst = true
  }

  // state_log_mismatch: check if cargo/credits unchanged AND agent thinks it's doing something
  if (minutesSinceActivity >= t.state_log_mismatch_minutes && snap.gameState !== null) {
    const productiveActions = countLogsMatching(profileId, 'tool_call', '%mine%', t.state_log_mismatch_minutes)
      + countLogsMatching(profileId, 'tool_call', '%trade%', t.state_log_mismatch_minutes)
    if (productiveActions > 0) {
      sig.state_log_mismatch = true
    }
  }

  return sig
}

// --- DB query helpers ---

function countRecentLogs(profileId: string, type: string, minutes: number): number {
  const row = getDb().query(
    `SELECT COUNT(*) as c FROM log_entries
     WHERE profile_id = ? AND type = ?
     AND timestamp >= datetime('now', '-' || ? || ' minutes')`,
  ).get(profileId, type, minutes) as { c: number }
  return row.c
}

function countLogsMatching(profileId: string, type: string, summaryLike: string, minutes: number): number {
  const row = getDb().query(
    `SELECT COUNT(*) as c FROM log_entries
     WHERE profile_id = ? AND type = ? AND summary LIKE ?
     AND timestamp >= datetime('now', '-' || ? || ' minutes')`,
  ).get(profileId, type, summaryLike, minutes) as { c: number }
  return row.c
}

function sumLlmCallCost(profileId: string, minutes: number): number {
  const rows = getDb().query(
    `SELECT detail FROM log_entries
     WHERE profile_id = ? AND type = 'llm_call'
     AND timestamp >= datetime('now', '-' || ? || ' minutes')`,
  ).all(profileId, minutes) as Array<{ detail: string | null }>
  let total = 0
  for (const r of rows) {
    if (!r.detail) continue
    try {
      const parsed = JSON.parse(r.detail)
      total += parsed?.usage?.cost?.total ?? 0
    } catch { /* ignore malformed entries */ }
  }
  return total
}
