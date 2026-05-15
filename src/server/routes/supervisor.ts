import { Hono } from 'hono'
import { loadConfig, saveConfig, type SupervisorConfig } from '../lib/supervisor/config'
import { listAudit } from '../lib/supervisor/audit'
import { listProposals, getProposal, setProposalStatus } from '../lib/supervisor/proposals'
import { getNotes } from '../lib/supervisor/notes'
import { agentManager } from '../lib/agent-manager'
import { supervisorManager } from '../lib/supervisor/manager'
import { emptySignals } from '../lib/supervisor/watchdog'
import { insertAudit } from '../lib/supervisor/audit'
import { updateProfile, addLogEntry } from '../lib/db'

const app = new Hono()

app.get('/config', (c) => c.json(loadConfig()))

app.put('/config', async (c) => {
  const body = await c.req.json() as Partial<SupervisorConfig>
  const current = loadConfig()
  saveConfig({ ...current, ...body })
  return c.json(loadConfig())
})

app.get('/status', (c) => {
  const cfg = loadConfig()
  const pending = listProposals({ status: 'pending' })
  return c.json({
    enabled: cfg.enabled,
    pendingProposalCount: pending.length,
    lastTick: listAudit({ eventType: 'tick', limit: 1 })[0]?.timestamp ?? null,
  })
})

app.get('/proposals', (c) => {
  const status = c.req.query('status') as 'pending' | 'applied' | 'rejected' | 'expired' | undefined
  const profileId = c.req.query('profileId')
  return c.json(listProposals({ status, profileId }))
})

app.post('/proposals/:id/apply', async (c) => {
  const id = Number(c.req.param('id'))
  const p = getProposal(id)
  if (!p) return c.json({ error: 'not_found' }, 404)
  if (p.status !== 'pending') return c.json({ error: 'not_pending' }, 409)

  const agent = agentManager.getAgent(p.profile_id)
  if (!agent?.isConnected) return c.json({ error: 'disconnected' }, 409)

  try {
    if (p.action === 'set_directive') {
      const payload = JSON.parse(p.payload) as { directive: string }
      updateProfile(p.profile_id, { directive: payload.directive })
      agentManager.restartTurn(p.profile_id)
    } else if (p.action === 'pause') {
      agentManager.pauseLLM(p.profile_id)
    } else if (p.action === 'resume') {
      agentManager.resumeLLM(p.profile_id)
    }
    setProposalStatus(id, 'applied')
    insertAudit('proposal_applied', p.profile_id, `Proposal #${id} applied (${p.action})`)
    addLogEntry(p.profile_id, 'supervisor_action', `Supervisor proposal applied: ${p.action}`)
    return c.json({ ok: true })
  } catch (err) {
    return c.json({ error: 'apply_failed', message: err instanceof Error ? err.message : String(err) }, 500)
  }
})

app.post('/proposals/:id/reject', async (c) => {
  const id = Number(c.req.param('id'))
  const p = getProposal(id)
  if (!p) return c.json({ error: 'not_found' }, 404)
  if (p.status !== 'pending') return c.json({ error: 'not_pending' }, 409)
  setProposalStatus(id, 'rejected')
  insertAudit('proposal_rejected', p.profile_id, `Proposal #${id} rejected`)
  return c.json({ ok: true })
})

app.get('/audit', (c) => {
  const limit = Number(c.req.query('limit') ?? '100')
  const targetProfileId = c.req.query('profileId')
  return c.json(listAudit({ limit, targetProfileId }))
})

app.get('/notes/:profileId', (c) => {
  return c.json(getNotes(c.req.param('profileId')))
})

app.post('/run', async (c) => {
  const body = await c.req.json() as { profileId: string }
  if (!body.profileId) return c.json({ error: 'profileId required' }, 400)
  if (!supervisorManager.instance) return c.json({ error: 'supervisor not initialized' }, 500)
  await supervisorManager.instance.runFor(body.profileId, emptySignals())
  return c.json({ ok: true })
})

export default app
