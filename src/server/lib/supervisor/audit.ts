import { getDb } from '../db'

export type AuditEventType =
  | 'tick'
  | 'anomaly_detected'
  | 'llm_call'
  | 'nudge_sent'
  | 'proposal_created'
  | 'proposal_applied'
  | 'proposal_rejected'
  | 'proposal_expired'
  | 'supervisor_skip'
  | 'notes_updated'
  | 'do_nothing'
  | 'error'

export interface AuditRow {
  id: number
  timestamp: string
  event_type: AuditEventType
  target_profile_id: string | null
  summary: string
  detail: string | null
}

export function insertAudit(
  eventType: AuditEventType,
  targetProfileId: string | null,
  summary: string,
  detail?: unknown,
): number {
  const detailStr = detail === undefined ? null : JSON.stringify(detail)
  const result = getDb().query(
    'INSERT INTO supervisor_audit (event_type, target_profile_id, summary, detail) VALUES (?, ?, ?, ?)',
  ).run(eventType, targetProfileId, summary, detailStr)
  return Number(result.lastInsertRowid)
}

export interface ListAuditOptions {
  limit?: number
  targetProfileId?: string
  eventType?: AuditEventType
}

export function listAudit(opts: ListAuditOptions = {}): AuditRow[] {
  const limit = opts.limit ?? 100
  const conditions: string[] = []
  const params: unknown[] = []

  if (opts.targetProfileId) {
    conditions.push('target_profile_id = ?')
    params.push(opts.targetProfileId)
  }
  if (opts.eventType) {
    conditions.push('event_type = ?')
    params.push(opts.eventType)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const sql = `SELECT * FROM supervisor_audit ${where} ORDER BY id DESC LIMIT ?`
  params.push(limit)

  return getDb().query(sql).all(...params) as AuditRow[]
}
