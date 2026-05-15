import { getPreference, setPreference } from '../db'

export interface WatchdogThresholds {
  activity_stuck_minutes: number
  no_llm_progress_minutes: number
  cost_spike_window_minutes: number
  cost_spike_threshold_usd: number
  max_rounds_window_hours: number
  max_rounds_count_threshold: number
  state_log_mismatch_minutes: number
  error_burst_window_minutes: number
  error_burst_count_threshold: number
  proposal_expiry_hours: number
  max_concurrent_supervisor_runs: number
}

export const DEFAULT_THRESHOLDS: WatchdogThresholds = {
  activity_stuck_minutes: 5,
  no_llm_progress_minutes: 8,
  cost_spike_window_minutes: 10,
  cost_spike_threshold_usd: 0.50,
  max_rounds_window_hours: 1,
  max_rounds_count_threshold: 2,
  state_log_mismatch_minutes: 10,
  error_burst_window_minutes: 10,
  error_burst_count_threshold: 5,
  proposal_expiry_hours: 6,
  max_concurrent_supervisor_runs: 2,
}

export interface SupervisorConfig {
  enabled: boolean
  provider: string
  model: string
  systemPrompt: string
  tickIntervalSeconds: number
  thresholds: WatchdogThresholds
}

function parseThresholds(raw: string | null): WatchdogThresholds {
  if (!raw) return DEFAULT_THRESHOLDS
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return DEFAULT_THRESHOLDS
    }
    return { ...DEFAULT_THRESHOLDS, ...(parsed as Partial<WatchdogThresholds>) }
  } catch {
    return DEFAULT_THRESHOLDS
  }
}

export function loadConfig(): SupervisorConfig {
  return {
    enabled: getPreference('supervisor.enabled') === 'true',
    provider: getPreference('supervisor.provider') ?? '',
    model: getPreference('supervisor.model') ?? '',
    systemPrompt: getPreference('supervisor.system_prompt') ?? '',
    tickIntervalSeconds: Number(getPreference('supervisor.tick_interval_seconds') ?? 60) || 60,
    thresholds: parseThresholds(getPreference('supervisor.watchdog_thresholds')),
  }
}

export function saveConfig(cfg: SupervisorConfig): void {
  setPreference('supervisor.enabled', cfg.enabled ? 'true' : 'false')
  setPreference('supervisor.provider', cfg.provider)
  setPreference('supervisor.model', cfg.model)
  setPreference('supervisor.system_prompt', cfg.systemPrompt)
  setPreference('supervisor.tick_interval_seconds', String(cfg.tickIntervalSeconds))
  setPreference('supervisor.watchdog_thresholds', JSON.stringify(cfg.thresholds))
}
