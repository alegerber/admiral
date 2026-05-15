import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader } from './ui/card'
import { Button } from './ui/button'
import { Badge } from './ui/badge'

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

export function SupervisorPanel() {
  const [config, setConfig] = useState<Config | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [audit, setAudit] = useState<AuditEntry[]>([])

  const refresh = async () => {
    const [c, s, p, a] = await Promise.all([
      fetch('/api/supervisor/config').then(r => r.json()),
      fetch('/api/supervisor/status').then(r => r.json()),
      fetch('/api/supervisor/proposals?status=pending').then(r => r.json()),
      fetch('/api/supervisor/audit?limit=20').then(r => r.json()),
    ])
    setConfig(c); setStatus(s); setProposals(p); setAudit(a)
  }

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 5_000)
    return () => clearInterval(id)
  }, [])

  const toggleEnabled = async () => {
    if (!config) return
    await fetch('/api/supervisor/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !config.enabled }),
    })
    refresh()
  }

  const apply = async (id: number) => {
    await fetch(`/api/supervisor/proposals/${id}/apply`, { method: 'POST' })
    refresh()
  }

  const reject = async (id: number) => {
    await fetch(`/api/supervisor/proposals/${id}/reject`, { method: 'POST' })
    refresh()
  }

  if (!config || !status) return <div className="p-4">Loading supervisor…</div>

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Supervisor</h2>
          <div className="flex items-center gap-2">
            <Badge variant={config.enabled ? 'default' : 'secondary'}>
              {config.enabled ? 'Enabled' : 'Disabled'}
            </Badge>
            <Button size="sm" onClick={toggleEnabled}>
              {config.enabled ? 'Disable' : 'Enable'}
            </Button>
          </div>
        </div>
        <div className="text-xs text-muted-foreground mt-2">
          Model: {config.model || '(none)'} · Last tick: {status.lastTick ?? 'never'} · Pending: {status.pendingProposalCount}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">

        <section>
          <h3 className="text-sm font-medium mb-2">Pending Proposals</h3>
          {proposals.length === 0 ? (
            <div className="text-xs text-muted-foreground">No pending proposals.</div>
          ) : proposals.map(p => (
            <div key={p.id} className="border rounded p-2 mb-2">
              <div className="text-sm font-medium">#{p.id} {p.action} on {p.profile_id}</div>
              <div className="text-xs text-muted-foreground my-1">{p.reasoning}</div>
              <pre className="text-xs bg-muted p-1 rounded overflow-x-auto">{p.payload}</pre>
              <div className="flex gap-2 mt-2">
                <Button size="sm" onClick={() => apply(p.id)}>Apply</Button>
                <Button size="sm" variant="outline" onClick={() => reject(p.id)}>Reject</Button>
              </div>
            </div>
          ))}
        </section>

        <section>
          <h3 className="text-sm font-medium mb-2">Recent Activity</h3>
          <div className="space-y-1 text-xs max-h-60 overflow-y-auto">
            {audit.map(a => (
              <div key={a.id} className="flex gap-2">
                <span className="text-muted-foreground">{a.timestamp}</span>
                <span className="font-mono">{a.event_type}</span>
                <span className="truncate">{a.summary}</span>
              </div>
            ))}
          </div>
        </section>
      </CardContent>
    </Card>
  )
}
