import { getDb } from '../db'

export interface Notes {
  profile_id: string
  observations: string
  last_strategy: string
  open_concerns: string
  updated_at: string
}

const EMPTY_NOTES = (profileId: string): Notes => ({
  profile_id: profileId,
  observations: '',
  last_strategy: '',
  open_concerns: '',
  updated_at: '',
})

export function getNotes(profileId: string): Notes {
  const row = getDb().query('SELECT * FROM supervisor_notes WHERE profile_id = ?').get(profileId) as Notes | undefined
  return row ?? EMPTY_NOTES(profileId)
}

export interface NotesPatch {
  observations: string
  last_strategy: string
  open_concerns: string
}

export function upsertNotes(profileId: string, patch: NotesPatch): void {
  getDb().query(
    `INSERT INTO supervisor_notes (profile_id, observations, last_strategy, open_concerns, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(profile_id) DO UPDATE SET
       observations = excluded.observations,
       last_strategy = excluded.last_strategy,
       open_concerns = excluded.open_concerns,
       updated_at = excluded.updated_at`,
  ).run(profileId, patch.observations, patch.last_strategy, patch.open_concerns)
}

export function deleteNotes(profileId: string): void {
  getDb().query('DELETE FROM supervisor_notes WHERE profile_id = ?').run(profileId)
}
