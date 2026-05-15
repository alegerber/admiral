import { getDb } from '../db'

export type ProposalAction = 'set_directive' | 'pause' | 'resume'
export type ProposalStatus = 'pending' | 'applied' | 'rejected' | 'expired'

export interface ProposalRow {
  id: number
  profile_id: string
  action: ProposalAction
  payload: string
  reasoning: string
  status: ProposalStatus
  created_at: string
  resolved_at: string | null
}

export interface CreateProposalInput {
  profileId: string
  action: ProposalAction
  payload: unknown
  reasoning: string
}

export function createProposal(input: CreateProposalInput): number {
  const result = getDb().query(
    `INSERT INTO supervisor_proposals (profile_id, action, payload, reasoning)
     VALUES (?, ?, ?, ?)`,
  ).run(input.profileId, input.action, JSON.stringify(input.payload), input.reasoning)
  return Number(result.lastInsertRowid)
}

export function getProposal(id: number): ProposalRow | null {
  const row = getDb().query('SELECT * FROM supervisor_proposals WHERE id = ?').get(id) as ProposalRow | undefined
  return row ?? null
}

export interface ListProposalsOptions {
  status?: ProposalStatus
  profileId?: string
  limit?: number
}

export function listProposals(opts: ListProposalsOptions): ProposalRow[] {
  const conditions: string[] = []
  const params: unknown[] = []
  if (opts.status) {
    conditions.push('status = ?')
    params.push(opts.status)
  }
  if (opts.profileId) {
    conditions.push('profile_id = ?')
    params.push(opts.profileId)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = opts.limit ?? 200
  params.push(limit)
  return getDb().query(
    `SELECT * FROM supervisor_proposals ${where} ORDER BY id DESC LIMIT ?`,
  ).all(...params) as ProposalRow[]
}

export function setProposalStatus(id: number, status: ProposalStatus): void {
  getDb().query(
    `UPDATE supervisor_proposals SET status = ?, resolved_at = datetime('now') WHERE id = ?`,
  ).run(status, id)
}

export function expireOldProposals(hours: number): number {
  const result = getDb().query(
    `UPDATE supervisor_proposals
     SET status = 'expired', resolved_at = datetime('now')
     WHERE status = 'pending' AND created_at <= datetime('now', '-' || ? || ' hours')`,
  ).run(hours)
  return Number(result.changes ?? 0)
}
