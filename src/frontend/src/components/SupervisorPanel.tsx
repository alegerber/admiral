import { useEffect, useState } from 'react'
import { Button } from './ui/button'
import { Overlay } from './ui/overlay'
import { ModelPicker } from '@/components/ModelPicker'

interface Config {
  enabled: boolean
  provider: string
  model: string
  systemPrompt: string
  tickIntervalSeconds: number
}

interface Status {
  enabled: boolean
  pendingProposalCount: number
  lastTick: string | null
}

interface Proposal {
  id: number
  profile_id: string
  action: string
  payload: string
  reasoning: string
  status: string
  created_at: string
}

interface AuditEntry {
  id: number
  timestamp: string
  event_type: string
  target_profile_id: string | null
  summary: string
}

interface SupervisorPanelProps {
  onClose: () => void
}

export function SupervisorPanel({ onClose }: SupervisorPanelProps) {
  const [config, setConfig] = useState<Config | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [providers, setProviders] = useState<{ id: string; status?: string }[]>([])

  const refresh = async () => {
    const [c, s, p, a, pv] = await Promise.all([
      fetch('/api/supervisor/config').then(r => r.json()),
      fetch('/api/supervisor/status').then(r => r.json()),
      fetch('/api/supervisor/proposals?status=pending').then(r => r.json()),
      fetch('/api/supervisor/audit?limit=20').then(r => r.json()),
      fetch('/api/providers').then(r => r.json()),
    ])
    setConfig(c); setStatus(s); setProposals(p); setAudit(a); setProviders(pv)
  }

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 5_000)
    return () => clearInterval(id)
  }, [])

  const updateConfig = async (patch: Partial<Config>) => {
    if (!config) return
    // Optimistic local update so the UI doesn't flicker
    setConfig({ ...config, ...patch })
    await fetch('/api/supervisor/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    refresh()
  }

  const toggleEnabled = () => {
    if (!config) return
    updateConfig({ enabled: !config.enabled })
  }

  const apply = async (id: number) => {
    await fetch(`/api/supervisor/proposals/${id}/apply`, { method: 'POST' })
    refresh()
  }

  const reject = async (id: number) => {
    await fetch(`/api/supervisor/proposals/${id}/reject`, { method: 'POST' })
    refresh()
  }

  if (!config || !status) {
    return (
      <Overlay title="Supervisor" onClose={onClose}>
        <div className="text-xs text-muted-foreground">Loading supervisor…</div>
      </Overlay>
    )
  }

  return (
    <Overlay title="Supervisor" onClose={onClose}>
      {/* Configuration section */}
      <div>
        <span className="text-[11px] text-[hsl(var(--smui-orange))] uppercase tracking-[1.5px] font-medium">Configuration</span>
        <div className="space-y-2.5 mt-2.5">
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground w-28 shrink-0">Provider</span>
            <select
              value={config.provider}
              onChange={e => updateConfig({ provider: e.target.value, model: '' })}
              className="bg-background border border-border rounded px-2 py-1 text-xs flex-1"
            >
              <option value="">(none)</option>
              {providers.filter(p => p.status === 'valid').map(p => (
                <option key={p.id} value={p.id}>{p.id}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground w-28 shrink-0">Model</span>
            <div className="flex-1">
              <ModelPicker
                provider={config.provider}
                value={config.model}
                onChange={(v) => updateConfig({ model: v })}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Status section */}
      <div>
        <span className="text-[11px] text-[hsl(var(--smui-frost-2))] uppercase tracking-[1.5px] font-medium">Status</span>
        <div className="space-y-2.5 mt-2.5">
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground w-28 shrink-0">State</span>
            <div className="flex items-center gap-2.5 flex-1">
              <div className={`status-dot ${config.enabled ? 'status-dot-green' : 'status-dot-grey'}`} />
              <span className="text-xs text-foreground">{config.enabled ? 'Enabled' : 'Disabled'}</span>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={toggleEnabled}
              className="h-6 text-[10px] hover:text-primary hover:border-primary/40"
            >
              {config.enabled ? 'Disable' : 'Enable'}
            </Button>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground w-28 shrink-0">Last tick</span>
            <span className="text-xs text-foreground">{status.lastTick ?? 'never'}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground w-28 shrink-0">Pending</span>
            <span className="text-xs text-foreground tabular-nums">{status.pendingProposalCount}</span>
          </div>
        </div>
      </div>

      {/* Pending Proposals section */}
      <div>
        <span className="text-[11px] text-[hsl(var(--smui-frost-2))] uppercase tracking-[1.5px] font-medium">Pending Proposals</span>
        <div className="space-y-1.5 mt-2.5">
          {proposals.length === 0 ? (
            <div className="text-[11px] text-muted-foreground">No pending proposals.</div>
          ) : proposals.map(p => (
            <div key={p.id} className="border border-border/60 bg-background/30 px-3 py-2">
              <div className="flex items-center gap-2.5">
                <span className="text-xs font-medium text-foreground">#{p.id} {p.action}</span>
                <span className="text-[10px] text-muted-foreground">on {p.profile_id}</span>
              </div>
              {p.reasoning && (
                <p className="text-[11px] text-muted-foreground mt-1.5">{p.reasoning}</p>
              )}
              <pre className="text-[10px] bg-muted px-2 py-1 mt-1.5 overflow-x-auto font-mono">{p.payload}</pre>
              <div className="flex gap-2 mt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => apply(p.id)}
                  className="h-6 text-[10px] hover:text-primary hover:border-primary/40"
                >
                  Apply
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => reject(p.id)}
                  className="h-6 text-[10px] hover:text-[hsl(var(--smui-orange))] hover:border-[hsl(var(--smui-orange))]/40"
                >
                  Reject
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Recent Activity section */}
      <div>
        <span className="text-[11px] text-[hsl(var(--smui-frost-2))] uppercase tracking-[1.5px] font-medium">Recent Activity</span>
        <div className="space-y-1 mt-2.5">
          {audit.length === 0 ? (
            <div className="text-[11px] text-muted-foreground">No activity yet.</div>
          ) : audit.map(a => (
            <div key={a.id} className="flex gap-2 text-[11px]">
              <span className="text-muted-foreground shrink-0 tabular-nums">{a.timestamp}</span>
              <span className="font-mono text-foreground shrink-0">{a.event_type}</span>
              <span className="text-muted-foreground truncate">{a.summary}</span>
            </div>
          ))}
        </div>
      </div>
    </Overlay>
  )
}
