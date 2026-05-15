import { loadConfig } from './config'
import { computeSignals, anyFired, signalSummary, type Signals, type AgentSnapshot } from './watchdog'
import { insertAudit } from './audit'
import { expireOldProposals } from './proposals'
import { runSupervisorTurn as defaultRunSupervisorTurn } from './loop'
import { resolveModel } from '../model'
import { getProvider } from '../db'
import { complete } from '@mariozechner/pi-ai'
import type { AgentManagerLike } from './tools'
import type { ProviderResolver, CompleteFn } from './loop'

export interface SupervisorManagerDeps {
  agentManager: AgentManagerLike & {
    listActive(): string[]
    getStatus(profileId: string): { running: boolean; paused: boolean; gameState: Record<string, unknown> | null }
  }
  runSupervisorTurn?: (profileId: string, signals: Signals) => Promise<void>
  getActivitySnapshot?: (profileId: string) => { lastActivityChangeMs: number }
}

export class SupervisorManager {
  private inflight = new Map<string, Promise<void>>()
  private intervalHandle: ReturnType<typeof setInterval> | null = null
  private deps: SupervisorManagerDeps

  constructor(deps: SupervisorManagerDeps) {
    this.deps = deps
  }

  start(): void {
    if (this.intervalHandle) return
    const tickMs = loadConfig().tickIntervalSeconds * 1000
    this.intervalHandle = setInterval(() => {
      this.tick().catch(err => {
        insertAudit('error', null, `Tick failure: ${err instanceof Error ? err.message : String(err)}`)
      })
    }, tickMs)
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
  }

  async tick(): Promise<void> {
    const cfg = loadConfig()
    if (!cfg.enabled) return
    insertAudit('tick', null, 'Watchdog tick started')

    const active = this.deps.agentManager.listActive()
    expireOldProposals(cfg.thresholds.proposal_expiry_hours)

    const startPromises: Promise<void>[] = []
    for (const profileId of active) {
      const snap = this.buildSnapshot(profileId)
      const signals = computeSignals(profileId, cfg.thresholds, snap)
      if (anyFired(signals)) {
        insertAudit('anomaly_detected', profileId, `Signals fired: ${signalSummary(signals)}`, signals)
        startPromises.push(this.enqueue(profileId, signals))
      }
    }
    await Promise.all(startPromises)
  }

  async runFor(profileId: string, signals: Signals): Promise<void> {
    await this.enqueue(profileId, signals)
  }

  onLlmCall(profileId: string): void {
    const cfg = loadConfig()
    if (!cfg.enabled) return
    const snap = this.buildSnapshot(profileId)
    const signals = computeSignals(profileId, cfg.thresholds, snap)
    if (signals.cost_spike) {
      insertAudit('anomaly_detected', profileId, `Cost spike (event hook): ${signalSummary(signals)}`, signals)
      this.enqueue(profileId, signals).catch(() => { /* loop.ts handles LLM errors; pre-loop failures are swallowed */ })
    }
  }

  private async enqueue(profileId: string, signals: Signals): Promise<void> {
    const cfg = loadConfig()
    if (this.inflight.has(profileId)) {
      insertAudit('supervisor_skip', profileId, 'Already in flight for this sub-agent')
      return
    }
    if (this.inflight.size >= cfg.thresholds.max_concurrent_supervisor_runs) {
      insertAudit('supervisor_skip', profileId, 'Concurrency cap reached')
      return
    }
    const runFn = this.deps.runSupervisorTurn ?? ((id, sig) => defaultRunSupervisorTurn(id, sig, {
      manager: this.deps.agentManager,
      provider: this.buildProvider(),
      complete: complete as CompleteFn,
    }))
    const promise = runFn(profileId, signals).finally(() => {
      this.inflight.delete(profileId)
    })
    this.inflight.set(profileId, promise)
    return promise
  }

  private buildSnapshot(profileId: string): AgentSnapshot {
    const status = this.deps.agentManager.getStatus(profileId)
    const lastActivityChangeMs = this.deps.getActivitySnapshot
      ? this.deps.getActivitySnapshot(profileId).lastActivityChangeMs
      : Date.now()  // optimistic default: assume agent was just active to avoid false positives on cold start
    return {
      isRunning: status.running,
      isPaused: status.paused,
      lastActivityChangeMs,
      gameState: status.gameState,
    }
  }

  private buildProvider(): ProviderResolver {
    return {
      resolveModel: (provider: string, modelId: string) => {
        // model.ts.resolveModel takes a single "provider/model-id" string and returns { model, apiKey? }
        // We discard apiKey here; resolveApiKey below fetches it separately from the same DB.
        return resolveModel(`${provider}/${modelId}`).model
      },
      resolveApiKey: (provider: string) => {
        return getProvider(provider)?.api_key ?? ''
      },
    }
  }
}

export const supervisorManager: { instance: SupervisorManager | null } = { instance: null }
