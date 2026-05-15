# Supervisor Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a two-tier Supervisor Agent — a cheap deterministic Watchdog gates an Opus-powered LLM Supervisor that monitors running sub-agents, sends autonomous nudges, and writes human-approvable proposals for high-risk actions (directive changes, pause/resume).

**Architecture:** New `src/server/lib/supervisor/` directory with one file per responsibility (manager, watchdog, loop, tools, notes, proposals, audit, prompt, config). One new route file (`/api/supervisor/*`). Two new React components (`SupervisorPanel`, `SupervisorBadge`). Three new SQL tables (`supervisor_notes`, `supervisor_proposals`, `supervisor_audit`) plus six new `preferences` keys. All additive — no breaking changes to existing code.

**Tech Stack:** Bun + Hono backend, `bun:sqlite` for DB, `bun:test` for tests, `@mariozechner/pi-ai` for LLM calls (already a dependency), React 19 + Tailwind for UI.

**Reference spec:** `docs/specs/2026-05-15-supervisor-agent-design.md`

---

## Phase 0 — Preflight

### Task 0.1: Install dependencies and verify baseline

**Files:** None modified

- [ ] **Step 1: Install dependencies**

Run: `bun install`

Expected: Resolves and installs all deps without errors. If the sandbox blocks `bun install` with `PermissionDenied`, retry with sandbox disabled (this is a known, harmless operation).

- [ ] **Step 2: Run existing tests to confirm clean baseline**

Run: `bun test`

Expected: All existing tests pass (currently only `src/server/lib/tools.test.ts`). If any fail, do NOT proceed — investigate or ask user.

- [ ] **Step 3: Verify the worktree is on the supervisor branch**

Run: `git branch --show-current`

Expected: `worktree-feat+supervisor-agent` (or whatever branch the worktree was created on).

No commit for this task.

---

## Phase 1 — Database & Persistence

### Task 1.1: Add supervisor SQL schema

**Files:**
- Modify: `src/server/lib/db.ts` (extend `migrate()` function around line 76)

- [ ] **Step 1: Add the three new tables to `migrate()`**

After the existing `idx_log_profile` index creation and before the `// Migrations: add columns...` block, append to the same `db.exec()` call. Open `src/server/lib/db.ts` and replace the existing schema block (lines 39-76) so that the additional CREATEs run inside the same migration call.

Concretely, add this block immediately after the `CREATE INDEX IF NOT EXISTS idx_log_profile ...` line, still inside the same `db.exec()` template literal:

```sql
CREATE TABLE IF NOT EXISTS supervisor_notes (
  profile_id    TEXT PRIMARY KEY,
  observations  TEXT NOT NULL DEFAULT '',
  last_strategy TEXT NOT NULL DEFAULT '',
  open_concerns TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS supervisor_proposals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id  TEXT NOT NULL,
  action      TEXT NOT NULL,
  payload     TEXT NOT NULL,
  reasoning   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_proposals_pending
  ON supervisor_proposals(status, created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_proposals_profile
  ON supervisor_proposals(profile_id, id DESC);

CREATE TABLE IF NOT EXISTS supervisor_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp  TEXT NOT NULL DEFAULT (datetime('now')),
  event_type TEXT NOT NULL,
  target_profile_id TEXT,
  summary    TEXT NOT NULL,
  detail     TEXT,
  FOREIGN KEY (target_profile_id) REFERENCES profiles(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_recent ON supervisor_audit(id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target ON supervisor_audit(target_profile_id, id DESC);
```

- [ ] **Step 2: Verify migrate runs cleanly**

Delete the existing local DB if present (so migration runs fresh on next startup), then run a one-liner:

```bash
rm -f data/admiral.db
bun -e 'import("./src/server/lib/db.ts").then(m => { m.getDb(); console.log("ok") })'
```

Expected: prints `ok` with no errors. Tables exist:

```bash
bun -e 'import("./src/server/lib/db.ts").then(m => { const db = m.getDb(); console.log(db.query("SELECT name FROM sqlite_master WHERE type=\"table\" ORDER BY name").all()) })'
```

Expected output contains `supervisor_notes`, `supervisor_proposals`, `supervisor_audit`.

- [ ] **Step 3: Commit**

```bash
git add src/server/lib/db.ts
git commit -m "feat(supervisor): add supervisor_notes/proposals/audit tables"
```

---

### Task 1.2: Make `getDb` test-injectable

The existing `getDb()` hardcodes `data/admiral.db`. Unit tests need an in-memory DB. Smallest change: respect `ADMIRAL_DB_PATH` env var if set.

**Files:**
- Modify: `src/server/lib/db.ts:6-7`

- [ ] **Step 1: Replace `DB_PATH` constant**

Replace lines 6-7:

```typescript
const DB_DIR = path.join(process.cwd(), 'data')
const DB_PATH = path.join(DB_DIR, 'admiral.db')
```

with:

```typescript
const DB_DIR = path.join(process.cwd(), 'data')
const DB_PATH = process.env.ADMIRAL_DB_PATH || path.join(DB_DIR, 'admiral.db')
```

- [ ] **Step 2: Skip dir creation when using `:memory:` or test path**

In `getDb()` around line 29 (`fs.mkdirSync(DB_DIR, { recursive: true })`), wrap so it only runs when DB_PATH starts with the DB_DIR prefix:

```typescript
if (DB_PATH.startsWith(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true })
}
```

Also, the `fs.existsSync(DB_PATH)` health check at line 14 must skip for `:memory:` (which has no file). Wrap the conditional:

```typescript
if (db) {
  // For :memory: DB, just verify the connection is healthy
  const isFileBased = DB_PATH !== ':memory:'
  if (isFileBased && !fs.existsSync(DB_PATH)) {
    try { db.close() } catch { /* ignore */ }
    db = null
  } else {
    try {
      db.query('SELECT 1 FROM profiles LIMIT 1').get()
      return db
    } catch {
      try { db.close() } catch { /* ignore */ }
      db = null
    }
  }
}
```

- [ ] **Step 3: Verify existing tests still pass**

Run: `bun test src/server/lib/tools.test.ts`

Expected: PASS (no behavior change for the default file-based path).

- [ ] **Step 4: Commit**

```bash
git add src/server/lib/db.ts
git commit -m "refactor(db): allow ADMIRAL_DB_PATH env override for tests"
```

---

### Task 1.3: Audit helpers (`audit.ts`)

**Files:**
- Create: `src/server/lib/supervisor/audit.ts`
- Create: `src/server/lib/supervisor/audit.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/server/lib/supervisor/audit.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'bun:test'
import { getDb } from '../db'
import { insertAudit, listAudit } from './audit'

// Use in-memory DB for tests
process.env.ADMIRAL_DB_PATH = ':memory:'

function resetDb() {
  const db = getDb()
  db.exec('DELETE FROM supervisor_audit')
  // Ensure at least one profile exists for FK tests
  db.exec(`INSERT OR IGNORE INTO profiles (id, name) VALUES ('p1', 'profile-one')`)
}

describe('audit', () => {
  beforeEach(resetDb)

  it('inserts a tick event with no target', () => {
    const id = insertAudit('tick', null, 'Watchdog tick started')
    expect(id).toBeGreaterThan(0)
    const rows = listAudit()
    expect(rows).toHaveLength(1)
    expect(rows[0].event_type).toBe('tick')
    expect(rows[0].target_profile_id).toBeNull()
    expect(rows[0].summary).toBe('Watchdog tick started')
  })

  it('inserts an anomaly event with target and JSON detail', () => {
    insertAudit('anomaly_detected', 'p1', 'cost spike', { window: 10, total: 0.7 })
    const rows = listAudit()
    expect(rows[0].target_profile_id).toBe('p1')
    expect(JSON.parse(rows[0].detail!)).toEqual({ window: 10, total: 0.7 })
  })

  it('lists audit entries newest first with limit', () => {
    insertAudit('tick', null, 'tick 1')
    insertAudit('tick', null, 'tick 2')
    insertAudit('tick', null, 'tick 3')
    const rows = listAudit({ limit: 2 })
    expect(rows).toHaveLength(2)
    expect(rows[0].summary).toBe('tick 3')
    expect(rows[1].summary).toBe('tick 2')
  })

  it('filters audit by target profile', () => {
    insertAudit('tick', null, 'global tick')
    insertAudit('anomaly_detected', 'p1', 'anomaly on p1')
    const rows = listAudit({ targetProfileId: 'p1' })
    expect(rows).toHaveLength(1)
    expect(rows[0].summary).toBe('anomaly on p1')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/server/lib/supervisor/audit.test.ts`

Expected: FAIL — `audit.ts` doesn't exist yet.

- [ ] **Step 3: Implement `audit.ts`**

Create `src/server/lib/supervisor/audit.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/server/lib/supervisor/audit.test.ts`

Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/lib/supervisor/audit.ts src/server/lib/supervisor/audit.test.ts
git commit -m "feat(supervisor): add audit log helpers"
```

---

### Task 1.4: Notes helpers (`notes.ts`)

**Files:**
- Create: `src/server/lib/supervisor/notes.ts`
- Create: `src/server/lib/supervisor/notes.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/server/lib/supervisor/notes.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'bun:test'
import { getDb } from '../db'
import { getNotes, upsertNotes, deleteNotes } from './notes'

process.env.ADMIRAL_DB_PATH = ':memory:'

function resetDb() {
  const db = getDb()
  db.exec('DELETE FROM supervisor_notes')
  db.exec(`INSERT OR IGNORE INTO profiles (id, name) VALUES ('p1', 'profile-one')`)
}

describe('notes', () => {
  beforeEach(resetDb)

  it('returns empty defaults when no row exists', () => {
    const n = getNotes('p1')
    expect(n.observations).toBe('')
    expect(n.last_strategy).toBe('')
    expect(n.open_concerns).toBe('')
  })

  it('upserts new notes', () => {
    upsertNotes('p1', { observations: 'mining slow', last_strategy: 'kupfer', open_concerns: 'no fuel' })
    const n = getNotes('p1')
    expect(n.observations).toBe('mining slow')
    expect(n.last_strategy).toBe('kupfer')
    expect(n.open_concerns).toBe('no fuel')
  })

  it('upserts overwrites existing fields', () => {
    upsertNotes('p1', { observations: 'v1', last_strategy: 's1', open_concerns: 'c1' })
    upsertNotes('p1', { observations: 'v2', last_strategy: 's2', open_concerns: 'c2' })
    const n = getNotes('p1')
    expect(n.observations).toBe('v2')
    expect(n.last_strategy).toBe('s2')
    expect(n.open_concerns).toBe('c2')
  })

  it('cascade-deletes when profile is deleted', () => {
    upsertNotes('p1', { observations: 'x', last_strategy: 'y', open_concerns: 'z' })
    getDb().query('DELETE FROM profiles WHERE id = ?').run('p1')
    const n = getNotes('p1')
    expect(n.observations).toBe('')
  })

  it('deleteNotes removes a row', () => {
    upsertNotes('p1', { observations: 'x', last_strategy: '', open_concerns: '' })
    deleteNotes('p1')
    const n = getNotes('p1')
    expect(n.observations).toBe('')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/server/lib/supervisor/notes.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement `notes.ts`**

Create `src/server/lib/supervisor/notes.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/server/lib/supervisor/notes.test.ts`

Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/lib/supervisor/notes.ts src/server/lib/supervisor/notes.test.ts
git commit -m "feat(supervisor): add notes helpers"
```

---

### Task 1.5: Proposals helpers (`proposals.ts`)

**Files:**
- Create: `src/server/lib/supervisor/proposals.ts`
- Create: `src/server/lib/supervisor/proposals.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/server/lib/supervisor/proposals.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'bun:test'
import { getDb } from '../db'
import {
  createProposal,
  listProposals,
  getProposal,
  setProposalStatus,
  expireOldProposals,
} from './proposals'

process.env.ADMIRAL_DB_PATH = ':memory:'

function resetDb() {
  const db = getDb()
  db.exec('DELETE FROM supervisor_proposals')
  db.exec(`INSERT OR IGNORE INTO profiles (id, name) VALUES ('p1', 'profile-one')`)
}

describe('proposals', () => {
  beforeEach(resetDb)

  it('creates a pending proposal', () => {
    const id = createProposal({
      profileId: 'p1',
      action: 'set_directive',
      payload: { directive: 'new goal' },
      reasoning: 'stuck for 30 min',
    })
    const p = getProposal(id)!
    expect(p.action).toBe('set_directive')
    expect(p.status).toBe('pending')
    expect(JSON.parse(p.payload)).toEqual({ directive: 'new goal' })
  })

  it('lists pending proposals only', () => {
    createProposal({ profileId: 'p1', action: 'pause', payload: {}, reasoning: 'r1' })
    const id2 = createProposal({ profileId: 'p1', action: 'resume', payload: {}, reasoning: 'r2' })
    setProposalStatus(id2, 'applied')
    const pending = listProposals({ status: 'pending' })
    expect(pending).toHaveLength(1)
    expect(pending[0].action).toBe('pause')
  })

  it('setProposalStatus updates status and resolved_at', () => {
    const id = createProposal({ profileId: 'p1', action: 'pause', payload: {}, reasoning: 'r' })
    setProposalStatus(id, 'rejected')
    const p = getProposal(id)!
    expect(p.status).toBe('rejected')
    expect(p.resolved_at).not.toBeNull()
  })

  it('expireOldProposals marks old pending as expired', () => {
    // Insert a proposal with manually backdated created_at
    const db = getDb()
    db.exec(`
      INSERT INTO supervisor_proposals (profile_id, action, payload, reasoning, created_at)
      VALUES ('p1', 'pause', '{}', 'old', datetime('now', '-10 hours'))
    `)
    db.exec(`
      INSERT INTO supervisor_proposals (profile_id, action, payload, reasoning, created_at)
      VALUES ('p1', 'pause', '{}', 'fresh', datetime('now'))
    `)
    const expired = expireOldProposals(6)
    expect(expired).toBe(1)
    const all = listProposals({})
    const oldOne = all.find(p => p.reasoning === 'old')!
    const freshOne = all.find(p => p.reasoning === 'fresh')!
    expect(oldOne.status).toBe('expired')
    expect(freshOne.status).toBe('pending')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/server/lib/supervisor/proposals.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement `proposals.ts`**

Create `src/server/lib/supervisor/proposals.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/server/lib/supervisor/proposals.test.ts`

Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/lib/supervisor/proposals.ts src/server/lib/supervisor/proposals.test.ts
git commit -m "feat(supervisor): add proposal CRUD helpers"
```

---

### Task 1.6: Config loader (`config.ts`)

**Files:**
- Create: `src/server/lib/supervisor/config.ts`
- Create: `src/server/lib/supervisor/config.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/server/lib/supervisor/config.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'bun:test'
import { getDb } from '../db'
import { loadConfig, saveConfig, DEFAULT_THRESHOLDS } from './config'

process.env.ADMIRAL_DB_PATH = ':memory:'

function resetDb() {
  getDb().exec('DELETE FROM preferences')
}

describe('supervisor config', () => {
  beforeEach(resetDb)

  it('returns defaults when no preferences set', () => {
    const cfg = loadConfig()
    expect(cfg.enabled).toBe(false)
    expect(cfg.tickIntervalSeconds).toBe(60)
    expect(cfg.thresholds).toEqual(DEFAULT_THRESHOLDS)
    expect(cfg.systemPrompt).toBe('')
  })

  it('saves and reloads config', () => {
    saveConfig({
      enabled: true,
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      systemPrompt: '',
      tickIntervalSeconds: 90,
      thresholds: { ...DEFAULT_THRESHOLDS, activity_stuck_minutes: 3 },
    })
    const cfg = loadConfig()
    expect(cfg.enabled).toBe(true)
    expect(cfg.provider).toBe('anthropic')
    expect(cfg.model).toBe('claude-opus-4-7')
    expect(cfg.tickIntervalSeconds).toBe(90)
    expect(cfg.thresholds.activity_stuck_minutes).toBe(3)
  })

  it('falls back to defaults for malformed JSON thresholds', () => {
    getDb().query('INSERT INTO preferences (key, value) VALUES (?, ?)').run(
      'supervisor.watchdog_thresholds', '{not json}',
    )
    const cfg = loadConfig()
    expect(cfg.thresholds).toEqual(DEFAULT_THRESHOLDS)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/server/lib/supervisor/config.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement `config.ts`**

Create `src/server/lib/supervisor/config.ts`:

```typescript
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

const DEFAULT_CONFIG: SupervisorConfig = {
  enabled: false,
  provider: '',
  model: '',
  systemPrompt: '',
  tickIntervalSeconds: 60,
  thresholds: DEFAULT_THRESHOLDS,
}

function parseThresholds(raw: string | null): WatchdogThresholds {
  if (!raw) return DEFAULT_THRESHOLDS
  try {
    const parsed = JSON.parse(raw)
    return { ...DEFAULT_THRESHOLDS, ...parsed }
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
    tickIntervalSeconds: Number(getPreference('supervisor.tick_interval_seconds') ?? DEFAULT_CONFIG.tickIntervalSeconds),
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/server/lib/supervisor/config.test.ts`

Expected: PASS (all 3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/lib/supervisor/config.ts src/server/lib/supervisor/config.test.ts
git commit -m "feat(supervisor): add config loader (preferences-backed)"
```

---

## Phase 2 — Watchdog (Tier 1)

### Task 2.1: Watchdog signal computations

**Files:**
- Create: `src/server/lib/supervisor/watchdog.ts`
- Create: `src/server/lib/supervisor/watchdog.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/server/lib/supervisor/watchdog.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/server/lib/supervisor/watchdog.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement `watchdog.ts`**

Create `src/server/lib/supervisor/watchdog.ts`:

```typescript
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
  // We approximate "stable game state" by checking that no successful tool_result for actionable
  // commands has been logged in the window. This avoids relying on multiple snapshots over time
  // (which would require state history tracking — out of scope for V1).
  if (minutesSinceActivity >= t.state_log_mismatch_minutes && snap.gameState !== null) {
    const productiveActions = countLogsMatching(profileId, 'tool_call', '%mine%', t.state_log_mismatch_minutes)
      + countLogsMatching(profileId, 'tool_call', '%trade%', t.state_log_mismatch_minutes)
    if (productiveActions > 0) {
      // logs say productive activity, but lastActivityChangeMs is old → mismatch
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/server/lib/supervisor/watchdog.test.ts`

Expected: PASS (all 6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/lib/supervisor/watchdog.ts src/server/lib/supervisor/watchdog.test.ts
git commit -m "feat(supervisor): add watchdog signal computations"
```

---

## Phase 3 — Supervisor Loop (Tier 2)

### Task 3.1: System prompt builder (`prompt.ts`)

**Files:**
- Create: `src/server/lib/supervisor/prompt.ts`
- Create: `src/server/lib/supervisor/prompt.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/server/lib/supervisor/prompt.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test'
import { buildSystemPrompt, buildUserContext } from './prompt'
import type { Signals } from './watchdog'
import type { Notes } from './notes'

describe('prompt builder', () => {
  it('default system prompt mentions authority levels', () => {
    const p = buildSystemPrompt('')
    expect(p).toContain('Nudges')
    expect(p).toContain('Directive')
    expect(p).toContain('Pause')
    expect(p).toContain('Resume')
    expect(p).toContain('notes')
  })

  it('uses user override if provided', () => {
    const p = buildSystemPrompt('CUSTOM PROMPT HERE')
    expect(p).toBe('CUSTOM PROMPT HERE')
  })

  it('user context includes notes, signals, logs, state', () => {
    const notes: Notes = { profile_id: 'p1', observations: 'obs', last_strategy: 'ls', open_concerns: 'oc', updated_at: '2026-05-15' }
    const signals: Signals = { activity_stuck: true, no_llm_progress: false, cost_spike: false, max_rounds_repeated: false, state_log_mismatch: false, error_burst: false }
    const ctx = buildUserContext({
      profileId: 'p1',
      profileName: 'TestProfile',
      notes,
      signals,
      logs: [{ id: 1, profile_id: 'p1', timestamp: '2026-05-15', type: 'tool_call', summary: 'mine()', detail: null }],
      gameState: { credits: 1234 },
      pendingProposals: [],
    })
    expect(ctx).toContain('TestProfile')
    expect(ctx).toContain('obs')
    expect(ctx).toContain('activity_stuck')
    expect(ctx).toContain('mine()')
    expect(ctx).toContain('1234')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/server/lib/supervisor/prompt.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement `prompt.ts`**

Create `src/server/lib/supervisor/prompt.ts`:

```typescript
import type { Signals } from './watchdog'
import type { Notes } from './notes'
import type { ProposalRow } from './proposals'
import type { LogEntry } from '../../../shared/types'

export const DEFAULT_SYSTEM_PROMPT = `You are the Admiral Supervisor. Your role is to observe sub-agents playing SpaceMolt and intervene when they are stuck, wasting resources, or pursuing failed strategies.

You see: persistent notes you wrote previously, the sub-agent's recent log entries, current game state, the heuristic signals that triggered this invocation.

Authority levels:
- Nudges are immediate. They inject a short message into the sub-agent's context. Use them for tactical hints ("there's a closer asteroid belt at...", "your fuel is low, refuel before traveling").
- Directive changes require human approval. They replace the sub-agent's high-level strategy. Use sparingly — only when the current strategy is clearly failing.
- Pause/Resume require human approval. Only when something is structurally broken (e.g., the sub-agent keeps hitting the same error).

Always update your notes at the end of every invocation. Be concise — single-sentence observations beat paragraphs. If everything looks fine, call \`do_nothing\` with a one-line reason. Never speculate without evidence in the logs or game state.`

export function buildSystemPrompt(override: string): string {
  return override.trim() ? override : DEFAULT_SYSTEM_PROMPT
}

export interface UserContextInput {
  profileId: string
  profileName: string
  notes: Notes
  signals: Signals
  logs: LogEntry[]
  gameState: Record<string, unknown> | null
  pendingProposals: ProposalRow[]
}

export function buildUserContext(input: UserContextInput): string {
  const firedSignals = (Object.keys(input.signals) as (keyof Signals)[])
    .filter(k => input.signals[k])
    .join(', ') || 'none'

  const logsSection = input.logs.length === 0
    ? '(no recent logs)'
    : input.logs.map(l => `[${l.timestamp}] ${l.type}: ${l.summary ?? ''}`).join('\n')

  const stateSection = input.gameState
    ? JSON.stringify(input.gameState, null, 2)
    : '(no game state)'

  const proposalsSection = input.pendingProposals.length === 0
    ? '(no pending proposals)'
    : input.pendingProposals.map(p => `#${p.id} ${p.action}: ${p.reasoning}`).join('\n')

  return `## Sub-Agent: ${input.profileName} (id: ${input.profileId})

### Triggering signals
${firedSignals}

### Your previous notes
- Observations: ${input.notes.observations || '(empty)'}
- Last known strategy: ${input.notes.last_strategy || '(empty)'}
- Open concerns: ${input.notes.open_concerns || '(empty)'}
- Last updated: ${input.notes.updated_at || '(never)'}

### Recent log entries (newest first)
${logsSection}

### Current game state
${stateSection}

### Pending proposals for this sub-agent
${proposalsSection}

Decide what to do. Call exactly the tools you need (often zero or one). Always end by calling update_notes with refreshed observations.`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/server/lib/supervisor/prompt.test.ts`

Expected: PASS (all 3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/lib/supervisor/prompt.ts src/server/lib/supervisor/prompt.test.ts
git commit -m "feat(supervisor): add prompt builder"
```

---

### Task 3.2: Supervisor tools (`tools.ts`)

**Files:**
- Create: `src/server/lib/supervisor/tools.ts`
- Create: `src/server/lib/supervisor/tools.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/server/lib/supervisor/tools.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'bun:test'
import { getDb, addLogEntry } from '../db'
import { executeSupervisorTool, supervisorToolDefinitions } from './tools'
import { listAudit } from './audit'
import { listProposals } from './proposals'
import { getNotes } from './notes'

process.env.ADMIRAL_DB_PATH = ':memory:'

function resetDb() {
  const db = getDb()
  db.exec('DELETE FROM supervisor_audit')
  db.exec('DELETE FROM supervisor_proposals')
  db.exec('DELETE FROM supervisor_notes')
  db.exec('DELETE FROM log_entries')
  db.exec(`INSERT OR IGNORE INTO profiles (id, name) VALUES ('p1', 'profile-one')`)
}

interface NudgeCall { profileId: string; message: string }
function makeAgentManagerMock() {
  const nudges: NudgeCall[] = []
  return {
    nudges,
    nudge: (profileId: string, message: string) => { nudges.push({ profileId, message }) },
  }
}

describe('supervisor tools', () => {
  beforeEach(resetDb)

  it('defines all six tools', () => {
    const names = supervisorToolDefinitions.map(t => t.name)
    expect(names).toEqual([
      'send_nudge',
      'propose_directive_change',
      'propose_pause',
      'propose_resume',
      'update_notes',
      'do_nothing',
    ])
  })

  it('send_nudge calls agentManager.nudge and logs to audit + sub-agent log', async () => {
    const mgr = makeAgentManagerMock()
    await executeSupervisorTool({ name: 'send_nudge', arguments: { message: 'try asteroid belt 7' } }, 'p1', mgr as any)
    expect(mgr.nudges).toEqual([{ profileId: 'p1', message: 'try asteroid belt 7' }])
    const audit = listAudit()
    expect(audit[0].event_type).toBe('nudge_sent')
    const logs = getDb().query(`SELECT * FROM log_entries WHERE profile_id = 'p1' AND type = 'supervisor_action'`).all()
    expect(logs).toHaveLength(1)
  })

  it('propose_directive_change creates a pending proposal', async () => {
    await executeSupervisorTool(
      { name: 'propose_directive_change', arguments: { new_directive: 'focus mining', reasoning: 'trading failed' } },
      'p1',
      makeAgentManagerMock() as any,
    )
    const proposals = listProposals({ status: 'pending' })
    expect(proposals).toHaveLength(1)
    expect(proposals[0].action).toBe('set_directive')
    expect(JSON.parse(proposals[0].payload)).toEqual({ directive: 'focus mining' })
    expect(proposals[0].reasoning).toBe('trading failed')
  })

  it('propose_pause and propose_resume create proposals with correct actions', async () => {
    await executeSupervisorTool({ name: 'propose_pause', arguments: { reasoning: 'looping' } }, 'p1', makeAgentManagerMock() as any)
    await executeSupervisorTool({ name: 'propose_resume', arguments: { reasoning: 'recovered' } }, 'p1', makeAgentManagerMock() as any)
    const proposals = listProposals({})
    expect(proposals.map(p => p.action).sort()).toEqual(['pause', 'resume'])
  })

  it('update_notes upserts notes', async () => {
    await executeSupervisorTool(
      { name: 'update_notes', arguments: { observations: 'A', last_strategy: 'B', open_concerns: 'C' } },
      'p1',
      makeAgentManagerMock() as any,
    )
    const n = getNotes('p1')
    expect(n.observations).toBe('A')
    expect(n.last_strategy).toBe('B')
    expect(n.open_concerns).toBe('C')
  })

  it('do_nothing only logs to audit', async () => {
    await executeSupervisorTool({ name: 'do_nothing', arguments: { reasoning: 'all good' } }, 'p1', makeAgentManagerMock() as any)
    const audit = listAudit()
    expect(audit[0].event_type).toBe('llm_call')  // do_nothing logs via audit
    // No proposals, no nudges
    expect(listProposals({}).length).toBe(0)
  })

  it('skips intervention if agent is disconnected', async () => {
    const mgr = { nudges: [] as NudgeCall[], nudge: () => { throw new Error('should not be called') } }
    await executeSupervisorTool({ name: 'send_nudge', arguments: { message: 'x' } }, 'nonexistent-profile', mgr as any)
    // It should not throw; instead log to audit as 'error' or 'supervisor_skip'
    const audit = listAudit()
    expect(audit.some(a => a.event_type === 'error' || a.event_type === 'supervisor_skip')).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/server/lib/supervisor/tools.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement `tools.ts`**

Create `src/server/lib/supervisor/tools.ts`:

```typescript
import { addLogEntry, getProfile } from '../db'
import { insertAudit } from './audit'
import { createProposal } from './proposals'
import { upsertNotes } from './notes'

export interface SupervisorToolDefinition {
  name: string
  description: string
  parameters: { type: 'object'; properties: Record<string, unknown>; required: string[] }
}

export const supervisorToolDefinitions: SupervisorToolDefinition[] = [
  {
    name: 'send_nudge',
    description: 'AUTONOMOUS. Sends a short message into the sub-agent\'s context. Use for tactical hints.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The nudge message (1-2 sentences)' },
      },
      required: ['message'],
    },
  },
  {
    name: 'propose_directive_change',
    description: 'PROPOSAL (needs human approval). Replaces the sub-agent\'s high-level strategy. Use sparingly.',
    parameters: {
      type: 'object',
      properties: {
        new_directive: { type: 'string', description: 'The complete replacement directive' },
        reasoning: { type: 'string', description: 'Why this change is needed' },
      },
      required: ['new_directive', 'reasoning'],
    },
  },
  {
    name: 'propose_pause',
    description: 'PROPOSAL. Pause the sub-agent. Only when structurally broken.',
    parameters: {
      type: 'object',
      properties: {
        reasoning: { type: 'string', description: 'Why pausing is needed' },
      },
      required: ['reasoning'],
    },
  },
  {
    name: 'propose_resume',
    description: 'PROPOSAL. Resume a paused sub-agent.',
    parameters: {
      type: 'object',
      properties: {
        reasoning: { type: 'string', description: 'Why resuming is appropriate now' },
      },
      required: ['reasoning'],
    },
  },
  {
    name: 'update_notes',
    description: 'AUTONOMOUS. Update your persistent notes for this sub-agent. Always call this at the end.',
    parameters: {
      type: 'object',
      properties: {
        observations: { type: 'string', description: 'What you observe now' },
        last_strategy: { type: 'string', description: 'Sub-agent\'s current apparent strategy' },
        open_concerns: { type: 'string', description: 'Issues to keep watching' },
      },
      required: ['observations', 'last_strategy', 'open_concerns'],
    },
  },
  {
    name: 'do_nothing',
    description: 'AUTONOMOUS. No action taken. Use when everything looks fine.',
    parameters: {
      type: 'object',
      properties: {
        reasoning: { type: 'string', description: 'Brief reason for inaction' },
      },
      required: ['reasoning'],
    },
  },
]

export interface AgentManagerLike {
  nudge(profileId: string, message: string): void
  getAgent(profileId: string): { isConnected: boolean } | undefined
}

export interface ToolCallInput {
  name: string
  arguments: Record<string, unknown>
}

export async function executeSupervisorTool(
  call: ToolCallInput,
  profileId: string,
  manager: AgentManagerLike,
): Promise<void> {
  const profileExists = !!getProfile(profileId)
  if (!profileExists) {
    insertAudit('error', profileId, `Tool ${call.name} skipped: profile not found`, { call })
    return
  }

  switch (call.name) {
    case 'send_nudge': {
      const message = String(call.arguments.message ?? '')
      const agent = manager.getAgent(profileId)
      if (!agent?.isConnected) {
        insertAudit('supervisor_skip', profileId, `Nudge skipped: agent disconnected`, { call })
        return
      }
      manager.nudge(profileId, message)
      insertAudit('nudge_sent', profileId, `Nudge sent: ${message.slice(0, 80)}`, { message })
      addLogEntry(profileId, 'supervisor_action', `Supervisor nudge: ${message}`)
      return
    }

    case 'propose_directive_change': {
      const newDirective = String(call.arguments.new_directive ?? '')
      const reasoning = String(call.arguments.reasoning ?? '')
      const id = createProposal({ profileId, action: 'set_directive', payload: { directive: newDirective }, reasoning })
      insertAudit('proposal_created', profileId, `Directive change proposed (#${id})`, { id, reasoning })
      return
    }

    case 'propose_pause': {
      const reasoning = String(call.arguments.reasoning ?? '')
      const id = createProposal({ profileId, action: 'pause', payload: {}, reasoning })
      insertAudit('proposal_created', profileId, `Pause proposed (#${id})`, { id, reasoning })
      return
    }

    case 'propose_resume': {
      const reasoning = String(call.arguments.reasoning ?? '')
      const id = createProposal({ profileId, action: 'resume', payload: {}, reasoning })
      insertAudit('proposal_created', profileId, `Resume proposed (#${id})`, { id, reasoning })
      return
    }

    case 'update_notes': {
      upsertNotes(profileId, {
        observations: String(call.arguments.observations ?? ''),
        last_strategy: String(call.arguments.last_strategy ?? ''),
        open_concerns: String(call.arguments.open_concerns ?? ''),
      })
      return
    }

    case 'do_nothing': {
      const reasoning = String(call.arguments.reasoning ?? '')
      insertAudit('llm_call', profileId, `do_nothing: ${reasoning.slice(0, 80)}`, { reasoning })
      return
    }

    default:
      insertAudit('error', profileId, `Unknown tool: ${call.name}`, { call })
  }
}
```

Note: this implementation references `getProfile` from `db.ts` — verify it's exported there. If not, add this export by editing `src/server/lib/db.ts` to add at the end of profile CRUD section:

```typescript
export function getProfile(id: string): Record<string, unknown> | null {
  const row = getDb().query('SELECT * FROM profiles WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ?? null
}
```

(Check first — `db.ts:145` already has `getProfile`. Use the existing one.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/server/lib/supervisor/tools.test.ts`

Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/lib/supervisor/tools.ts src/server/lib/supervisor/tools.test.ts
git commit -m "feat(supervisor): add tool definitions and handlers"
```

---

### Task 3.3: Supervisor loop (`loop.ts`)

**Files:**
- Create: `src/server/lib/supervisor/loop.ts`
- Create: `src/server/lib/supervisor/loop.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/server/lib/supervisor/loop.test.ts`:

```typescript
import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { getDb } from '../db'
import { runSupervisorTurn } from './loop'
import { saveConfig, DEFAULT_THRESHOLDS } from './config'
import { listAudit } from './audit'
import { getNotes } from './notes'
import { emptySignals } from './watchdog'

process.env.ADMIRAL_DB_PATH = ':memory:'

function resetDb() {
  const db = getDb()
  db.exec('DELETE FROM supervisor_audit')
  db.exec('DELETE FROM supervisor_notes')
  db.exec('DELETE FROM supervisor_proposals')
  db.exec('DELETE FROM log_entries')
  db.exec('DELETE FROM preferences')
  db.exec(`INSERT OR IGNORE INTO profiles (id, name) VALUES ('p1', 'profile-one')`)
  saveConfig({
    enabled: true, provider: 'anthropic', model: 'claude-opus-4-7',
    systemPrompt: '', tickIntervalSeconds: 60, thresholds: DEFAULT_THRESHOLDS,
  })
}

const fakeAgentManager = {
  nudge: () => {},
  getAgent: () => ({ isConnected: true }),
  getStatus: () => ({ connected: true, running: true, paused: false, activity: 'mining', gameState: { credits: 100 } }),
}

const fakeProvider = {
  resolveModel: () => ({ contextWindow: 200_000 } as any),
  resolveApiKey: () => 'test-key',
}

describe('supervisor loop', () => {
  beforeEach(resetDb)

  it('aborts if supervisor is disabled', async () => {
    saveConfig({
      enabled: false, provider: '', model: '',
      systemPrompt: '', tickIntervalSeconds: 60, thresholds: DEFAULT_THRESHOLDS,
    })
    const completeMock = mock(async () => ({ content: [], usage: { cost: { total: 0 } } } as any))
    await runSupervisorTurn('p1', emptySignals(), {
      manager: fakeAgentManager as any,
      provider: fakeProvider as any,
      complete: completeMock as any,
    })
    expect(completeMock).not.toHaveBeenCalled()
  })

  it('logs llm_call to audit and processes tool calls', async () => {
    const completeMock = mock(async () => ({
      content: [
        { type: 'toolCall', id: 't1', name: 'update_notes', arguments: { observations: 'o', last_strategy: 's', open_concerns: 'c' } },
        { type: 'toolCall', id: 't2', name: 'do_nothing', arguments: { reasoning: 'fine' } },
      ],
      usage: { input: 100, output: 50, cost: { total: 0.1 } },
      model: 'claude-opus-4-7',
      provider: 'anthropic',
      stopReason: 'end_turn',
    } as any))
    await runSupervisorTurn('p1', emptySignals(), {
      manager: fakeAgentManager as any,
      provider: fakeProvider as any,
      complete: completeMock as any,
    })
    expect(completeMock).toHaveBeenCalled()
    expect(listAudit().some(a => a.event_type === 'llm_call')).toBe(true)
    expect(getNotes('p1').observations).toBe('o')
  })

  it('handles LLM call failure gracefully', async () => {
    const completeMock = mock(async () => { throw new Error('rate limit') })
    await runSupervisorTurn('p1', emptySignals(), {
      manager: fakeAgentManager as any,
      provider: fakeProvider as any,
      complete: completeMock as any,
    })
    const errors = listAudit({ eventType: 'error' })
    expect(errors).toHaveLength(1)
    expect(errors[0].summary).toContain('rate limit')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/server/lib/supervisor/loop.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement `loop.ts`**

Create `src/server/lib/supervisor/loop.ts`:

```typescript
import type { Model, Context, AssistantMessage } from '@mariozechner/pi-ai'
import { getProfile, getLogEntries } from '../db'
import { loadConfig } from './config'
import { getNotes } from './notes'
import { listProposals } from './proposals'
import { insertAudit } from './audit'
import { buildSystemPrompt, buildUserContext } from './prompt'
import { supervisorToolDefinitions, executeSupervisorTool, type AgentManagerLike } from './tools'
import type { Signals } from './watchdog'

export interface ProviderResolver {
  resolveModel(provider: string, modelId: string): Model<any>
  resolveApiKey(provider: string): string
}

export interface CompleteFn {
  (model: Model<any>, context: Context, opts: { apiKey: string; maxTokens: number; tools: unknown[] }): Promise<AssistantMessage>
}

export interface RunSupervisorTurnDeps {
  manager: AgentManagerLike & { getStatus(profileId: string): { gameState: Record<string, unknown> | null } }
  provider: ProviderResolver
  complete: CompleteFn
}

export async function runSupervisorTurn(
  profileId: string,
  signals: Signals,
  deps: RunSupervisorTurnDeps,
): Promise<void> {
  const cfg = loadConfig()
  if (!cfg.enabled) return

  const profile = getProfile(profileId)
  if (!profile) {
    insertAudit('error', profileId, 'Supervisor run skipped: profile not found')
    return
  }
  const profileName = String((profile as { name?: unknown }).name ?? profileId)

  const notes = getNotes(profileId)
  const logs = getLogEntries(profileId, undefined, 30)
  const gameState = deps.manager.getStatus(profileId).gameState
  const pendingProposals = listProposals({ profileId, status: 'pending' })

  const systemPrompt = buildSystemPrompt(cfg.systemPrompt)
  const userContent = buildUserContext({
    profileId, profileName, notes, signals, logs, gameState, pendingProposals,
  })

  const context: Context = {
    systemPrompt,
    messages: [{ role: 'user', content: userContent, timestamp: Date.now() }],
  }

  insertAudit('llm_call', profileId, `Supervisor invoked for ${profileName}`, { signals })

  let response: AssistantMessage
  try {
    const model = deps.provider.resolveModel(cfg.provider, cfg.model)
    const apiKey = deps.provider.resolveApiKey(cfg.provider)
    response = await deps.complete(model, context, {
      apiKey,
      maxTokens: 1500,
      tools: supervisorToolDefinitions,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    insertAudit('error', profileId, `LLM call failed: ${message}`, { error: message })
    return
  }

  const toolCalls = (response.content as Array<{ type?: string; id?: string; name?: string; arguments?: Record<string, unknown> }>)
    .filter(c => c.type === 'toolCall')

  for (const call of toolCalls) {
    if (!call.name) continue
    try {
      await executeSupervisorTool(
        { name: call.name, arguments: call.arguments ?? {} },
        profileId,
        deps.manager,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      insertAudit('error', profileId, `Tool ${call.name} failed: ${message}`, { error: message })
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/server/lib/supervisor/loop.test.ts`

Expected: PASS (all 3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/lib/supervisor/loop.ts src/server/lib/supervisor/loop.test.ts
git commit -m "feat(supervisor): add stateless supervisor loop"
```

---

## Phase 4 — Manager, Event Hook, Bootstrap

### Task 4.1: Supervisor manager (`manager.ts`)

**Files:**
- Create: `src/server/lib/supervisor/manager.ts`
- Create: `src/server/lib/supervisor/manager.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/server/lib/supervisor/manager.test.ts`:

```typescript
import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { getDb } from '../db'
import { SupervisorManager } from './manager'
import { saveConfig, DEFAULT_THRESHOLDS } from './config'
import { listAudit } from './audit'
import { emptySignals } from './watchdog'

process.env.ADMIRAL_DB_PATH = ':memory:'

function resetDb() {
  const db = getDb()
  db.exec('DELETE FROM supervisor_audit')
  db.exec('DELETE FROM supervisor_notes')
  db.exec('DELETE FROM supervisor_proposals')
  db.exec('DELETE FROM log_entries')
  db.exec('DELETE FROM preferences')
  db.exec(`DELETE FROM profiles WHERE id IN ('p1', 'p2')`)
  db.exec(`INSERT INTO profiles (id, name) VALUES ('p1', 'profile-one')`)
  db.exec(`INSERT INTO profiles (id, name) VALUES ('p2', 'profile-two')`)
  saveConfig({
    enabled: true, provider: 'anthropic', model: 'claude-opus-4-7',
    systemPrompt: '', tickIntervalSeconds: 60, thresholds: DEFAULT_THRESHOLDS,
  })
}

function makeManager() {
  const runs: string[] = []
  const runSupervisorTurn = mock(async (profileId: string) => { runs.push(profileId) })
  const fakeAgentManager = {
    listActive: () => ['p1', 'p2'],
    getStatus: (id: string) => ({ connected: true, running: true, paused: false, activity: 'idle', gameState: null }),
    nudge: () => {},
    getAgent: () => ({ isConnected: true }),
  }
  const mgr = new SupervisorManager({
    agentManager: fakeAgentManager as any,
    runSupervisorTurn: runSupervisorTurn as any,
    getActivitySnapshot: () => ({ lastActivityChangeMs: Date.now() - 999_999_999 }),  // very old → activity_stuck fires
  })
  return { mgr, runs, runSupervisorTurn }
}

describe('SupervisorManager', () => {
  beforeEach(resetDb)

  it('tick runs supervisor for all active sub-agents with fired signals', async () => {
    const { mgr, runs } = makeManager()
    await mgr.tick()
    expect(runs.sort()).toEqual(['p1', 'p2'])
    expect(listAudit({ eventType: 'tick' })).toHaveLength(1)
    expect(listAudit({ eventType: 'anomaly_detected' })).toHaveLength(2)
  })

  it('tick is a no-op when supervisor is disabled', async () => {
    saveConfig({ enabled: false, provider: '', model: '', systemPrompt: '', tickIntervalSeconds: 60, thresholds: DEFAULT_THRESHOLDS })
    const { mgr, runs } = makeManager()
    await mgr.tick()
    expect(runs).toHaveLength(0)
    expect(listAudit({ eventType: 'tick' })).toHaveLength(0)
  })

  it('semaphore caps concurrent runs', async () => {
    saveConfig({
      enabled: true, provider: 'anthropic', model: 'claude-opus-4-7',
      systemPrompt: '', tickIntervalSeconds: 60,
      thresholds: { ...DEFAULT_THRESHOLDS, max_concurrent_supervisor_runs: 1 },
    })
    let resolveFirst: (() => void) | null = null
    const slow = new Promise<void>(r => { resolveFirst = r })
    const runMock = mock(async (profileId: string) => {
      if (profileId === 'p1') await slow
    })
    const fakeAgentManager = {
      listActive: () => ['p1', 'p2'],
      getStatus: () => ({ connected: true, running: true, paused: false, activity: 'idle', gameState: null }),
      nudge: () => {}, getAgent: () => ({ isConnected: true }),
    }
    const mgr = new SupervisorManager({
      agentManager: fakeAgentManager as any,
      runSupervisorTurn: runMock as any,
      getActivitySnapshot: () => ({ lastActivityChangeMs: Date.now() - 999_999_999 }),
    })
    const p = mgr.tick()
    // p2 should be dropped because p1 holds the only slot
    await new Promise(r => setTimeout(r, 20))
    const skips = listAudit({ eventType: 'supervisor_skip' })
    expect(skips.length).toBeGreaterThanOrEqual(1)
    resolveFirst!()
    await p
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/server/lib/supervisor/manager.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement `manager.ts`**

Create `src/server/lib/supervisor/manager.ts`:

```typescript
import { loadConfig } from './config'
import { computeSignals, anyFired, signalSummary, type Signals, type AgentSnapshot } from './watchdog'
import { insertAudit } from './audit'
import { expireOldProposals } from './proposals'
import { runSupervisorTurn as defaultRunSupervisorTurn } from './loop'
import type { AgentManagerLike } from './tools'

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
      manager: this.deps.agentManager as any,
      provider: this.buildProvider(),
      complete: this.buildComplete(),
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
      : Date.now()  // pessimistic default
    return {
      isRunning: status.running,
      isPaused: status.paused,
      lastActivityChangeMs,
      gameState: status.gameState,
    }
  }

  private buildProvider() {
    // Lazy import to avoid circular deps with existing model.ts
    const m = require('../model') as typeof import('../model')
    const p = require('../providers') as typeof import('../providers')
    return {
      resolveModel: (provider: string, modelId: string) => m.resolveModel(provider, modelId),
      resolveApiKey: (provider: string) => p.getProviderApiKey(provider),
    }
  }

  private buildComplete() {
    const piAi = require('@mariozechner/pi-ai') as typeof import('@mariozechner/pi-ai')
    return piAi.complete
  }
}

export const supervisorManager: { instance: SupervisorManager | null } = { instance: null }
```

**Note on the lazy `require`s in `buildProvider`/`buildComplete`:** they exist to avoid circular import cycles with `model.ts` and `providers.ts`. If those modules don't actually have circular dependencies with supervisor, refactor to top-level `import`s. Run `bun build` after to verify no cycles.

Also: this file references `getProviderApiKey` from `providers.ts` and `resolveModel` from `model.ts`. Check those exports exist; if names differ, adapt this code to match. Add a quick check:

```bash
grep -E "^export (function|const) (resolveModel|getProviderApiKey)" src/server/lib/model.ts src/server/lib/providers.ts
```

If `resolveModel` or `getProviderApiKey` don't exist with those names, find the equivalent (e.g. `getApiKey`, `lookupModel`) and adapt.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/server/lib/supervisor/manager.test.ts`

Expected: PASS (all 3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/lib/supervisor/manager.ts src/server/lib/supervisor/manager.test.ts
git commit -m "feat(supervisor): add singleton manager with tick + semaphore"
```

---

### Task 4.2: Event hook in `addLogEntry`

**Files:**
- Modify: `src/server/lib/db.ts:195-200` (`addLogEntry` function)

The hook checks cost-spike on `llm_call` insertion and triggers the Supervisor without waiting for the next 60s tick.

- [ ] **Step 1: Add an optional hook in `db.ts`**

Modify `addLogEntry` to call an optional global hook. Replace lines 195-200:

```typescript
export function addLogEntry(profileId: string, type: string, summary: string, detail?: string): number {
  const result = getDb().query(
    'INSERT INTO log_entries (profile_id, type, summary, detail) VALUES (?, ?, ?, ?)'
  ).run(profileId, type, summary, detail ?? null)
  const id = Number(result.lastInsertRowid)
  if (type === 'llm_call' && logEntryHook) {
    try { logEntryHook(profileId, type) } catch { /* swallow */ }
  }
  return id
}

let logEntryHook: ((profileId: string, type: string) => void) | null = null
export function setLogEntryHook(fn: ((profileId: string, type: string) => void) | null): void {
  logEntryHook = fn
}
```

- [ ] **Step 2: Add wiring in `manager.ts`**

Add a method to `SupervisorManager`:

```typescript
onLlmCall(profileId: string): void {
  const cfg = loadConfig()
  if (!cfg.enabled) return
  const snap = this.buildSnapshot(profileId)
  const signals = computeSignals(profileId, cfg.thresholds, snap)
  if (signals.cost_spike) {
    insertAudit('anomaly_detected', profileId, `Cost spike (event hook): ${signalSummary(signals)}`, signals)
    this.enqueue(profileId, signals).catch(() => {})
  }
}
```

- [ ] **Step 3: Test it**

Add to `manager.test.ts`:

```typescript
it('onLlmCall triggers supervisor when cost_spike fires', async () => {
  const { mgr, runs } = makeManager()
  // Insert llm_call logs totaling > $0.50
  for (let i = 0; i < 3; i++) {
    const db = getDb()
    db.query('INSERT INTO log_entries (profile_id, type, summary, detail) VALUES (?, ?, ?, ?)').run(
      'p1', 'llm_call', 'x', JSON.stringify({ usage: { cost: { total: 0.20 } } }),
    )
  }
  mgr.onLlmCall('p1')
  await new Promise(r => setTimeout(r, 10))
  expect(runs).toContain('p1')
})
```

Run: `bun test src/server/lib/supervisor/manager.test.ts`

Expected: PASS including the new test.

- [ ] **Step 4: Commit**

```bash
git add src/server/lib/db.ts src/server/lib/supervisor/manager.ts src/server/lib/supervisor/manager.test.ts
git commit -m "feat(supervisor): event hook for cost-spike fast path"
```

---

### Task 4.3: Bootstrap in `src/server/index.ts`

**Files:**
- Modify: `src/server/index.ts`

- [ ] **Step 1: Wire the manager into server startup**

Add these imports near the top of `src/server/index.ts`:

```typescript
import { SupervisorManager, supervisorManager } from './lib/supervisor/manager'
import { agentManager } from './lib/agent-manager'
import { setLogEntryHook } from './lib/db'
import supervisorRoutes from './routes/supervisor'  // will be created in Phase 5
```

Add this somewhere after the existing route registrations (around line 22) and before the `const port` line:

```typescript
// Supervisor wiring (additive — no impact if supervisor is disabled in config)
supervisorManager.instance = new SupervisorManager({
  agentManager: agentManager as any,
  getActivitySnapshot: (profileId) => {
    const agent = agentManager.getAgent(profileId)
    return { lastActivityChangeMs: agent ? (agent as any).lastActivityChangeMs ?? Date.now() : Date.now() }
  },
})
supervisorManager.instance.start()
setLogEntryHook((profileId, type) => {
  if (type === 'llm_call') supervisorManager.instance?.onLlmCall(profileId)
})

app.route('/api/supervisor', supervisorRoutes)
```

Note: `getActivitySnapshot` relies on an `Agent` field `lastActivityChangeMs` that may not exist yet. Add it to the existing `Agent` class.

- [ ] **Step 2: Track `lastActivityChangeMs` in `Agent`**

In `src/server/lib/agent.ts`, find the `activity` setter (or wherever `this.activity` is set) and add a sibling timestamp:

```typescript
private _lastActivityChangeMs = Date.now()
get lastActivityChangeMs() { return this._lastActivityChangeMs }

setActivity(newActivity: string) {
  if (newActivity !== this.activity) this._lastActivityChangeMs = Date.now()
  this.activity = newActivity
}
```

Find all assignments to `agent.activity = ...` in `agent.ts` and replace with `agent.setActivity(...)`. There should be only 2-3 sites.

- [ ] **Step 3: Test that the server still boots**

Run: `bun run src/server/index.ts &`
Then: `curl -sf http://localhost:3031/api/health` → expect `{"ok":true}`
Then: kill the process.

(Note: `supervisorRoutes` doesn't exist yet — temporarily comment out the `app.route('/api/supervisor', ...)` line and the matching import until Phase 5 is done, or simply create an empty stub `routes/supervisor.ts` exporting `new Hono()` so the import resolves.)

- [ ] **Step 4: Commit**

```bash
git add src/server/index.ts src/server/lib/agent.ts
git commit -m "feat(supervisor): bootstrap manager + activity timestamp"
```

---

## Phase 5 — REST API

### Task 5.1: `/api/supervisor` routes

**Files:**
- Create: `src/server/routes/supervisor.ts`

- [ ] **Step 1: Implement the route file**

Create `src/server/routes/supervisor.ts`:

```typescript
import { Hono } from 'hono'
import { loadConfig, saveConfig, type SupervisorConfig } from '../lib/supervisor/config'
import { listAudit } from '../lib/supervisor/audit'
import { listProposals, getProposal, setProposalStatus } from '../lib/supervisor/proposals'
import { getNotes } from '../lib/supervisor/notes'
import { agentManager } from '../lib/agent-manager'
import { supervisorManager } from '../lib/supervisor/manager'
import { emptySignals } from '../lib/supervisor/watchdog'

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
      // Apply the directive: this assumes a function exists to update profile directive + restart turn
      // Use existing agentManager.restartTurn() + setDirective on profile
      const { updateProfile } = await import('../lib/db')
      updateProfile(p.profile_id, { directive: payload.directive } as any)
      agentManager.restartTurn(p.profile_id)
    } else if (p.action === 'pause') {
      agentManager.pauseLLM(p.profile_id)
    } else if (p.action === 'resume') {
      agentManager.resumeLLM(p.profile_id)
    }
    setProposalStatus(id, 'applied')
    const { insertAudit } = await import('../lib/supervisor/audit')
    insertAudit('proposal_applied', p.profile_id, `Proposal #${id} applied (${p.action})`)
    const { addLogEntry } = await import('../lib/db')
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
  const { insertAudit } = await import('../lib/supervisor/audit')
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
```

Note: this references `updateProfile` from `db.ts` — confirm signature matches (see `db.ts:185`). If the signature differs, adapt the call.

- [ ] **Step 2: Smoke-test the routes**

Start the server: `bun run src/server/index.ts &`

Test:
```bash
curl -sf http://localhost:3031/api/supervisor/config | jq .
curl -sf http://localhost:3031/api/supervisor/status | jq .
curl -sf -X PUT http://localhost:3031/api/supervisor/config \
  -H 'content-type: application/json' \
  -d '{"enabled":true,"provider":"anthropic","model":"claude-opus-4-7"}' | jq .
curl -sf http://localhost:3031/api/supervisor/audit | jq .
```

Expected: all return valid JSON, config PUT echoes the updated config.

Kill the server.

- [ ] **Step 3: Commit**

```bash
git add src/server/routes/supervisor.ts
git commit -m "feat(supervisor): add REST API endpoints"
```

---

## Phase 6 — UI

### Task 6.1: `SupervisorPanel` component

**Files:**
- Create: `src/frontend/src/components/SupervisorPanel.tsx`

- [ ] **Step 1: Implement the panel**

Create `src/frontend/src/components/SupervisorPanel.tsx`:

```typescript
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
```

- [ ] **Step 2: Add the panel to the main layout**

Open `src/frontend/src/pages/Home.tsx` (or wherever the main panel layout lives — likely `App.tsx` or `Dashboard.tsx`). Add a tab/section/route for `<SupervisorPanel />`. Minimal integration: add a route entry in `main.tsx` for `/supervisor` and a nav link.

Check `src/frontend/src/main.tsx` for the router setup, add:

```typescript
import { SupervisorPanel } from './components/SupervisorPanel'

// Inside the <Routes> block:
<Route path="/supervisor" element={<SupervisorPanel />} />
```

Then add a nav link in the header (likely `src/frontend/src/App.tsx`):

```tsx
<Link to="/supervisor" className="text-sm">Supervisor</Link>
```

- [ ] **Step 3: Visual smoke test**

Start dev server: `bun run dev`

Open browser to http://localhost:3031/supervisor — expect to see the SupervisorPanel rendering with "Loading…" then real data.

Per CLAUDE.md: use Playwright MCP for verification. Take a screenshot to confirm.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/components/SupervisorPanel.tsx src/frontend/src/main.tsx src/frontend/src/App.tsx
git commit -m "feat(supervisor): add SupervisorPanel UI"
```

---

### Task 6.2: `SupervisorBadge` in ProfileView

**Files:**
- Create: `src/frontend/src/components/SupervisorBadge.tsx`
- Modify: `src/frontend/src/components/ProfileView.tsx`

- [ ] **Step 1: Create the badge component**

Create `src/frontend/src/components/SupervisorBadge.tsx`:

```typescript
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Badge } from './ui/badge'

export function SupervisorBadge({ profileId }: { profileId: string }) {
  const [pendingCount, setPendingCount] = useState(0)

  useEffect(() => {
    const refresh = async () => {
      const r = await fetch(`/api/supervisor/proposals?status=pending&profileId=${encodeURIComponent(profileId)}`)
      const data = await r.json() as { id: number }[]
      setPendingCount(data.length)
    }
    refresh()
    const id = setInterval(refresh, 5_000)
    return () => clearInterval(id)
  }, [profileId])

  if (pendingCount === 0) return null

  return (
    <Link to="/supervisor">
      <Badge variant="destructive" className="cursor-pointer">
        ⚠ {pendingCount} supervisor proposal{pendingCount > 1 ? 's' : ''}
      </Badge>
    </Link>
  )
}
```

- [ ] **Step 2: Embed in `ProfileView.tsx`**

Open `src/frontend/src/components/ProfileView.tsx`. Find the header section (where profile name is shown) and add:

```tsx
import { SupervisorBadge } from './SupervisorBadge'

// Inside the header, near the profile name:
<SupervisorBadge profileId={profile.id} />
```

- [ ] **Step 3: Smoke test**

Restart dev server, visit a profile page that has pending proposals (create one manually via curl if none exist). Verify the badge appears and clicks through to the Supervisor panel.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/components/SupervisorBadge.tsx src/frontend/src/components/ProfileView.tsx
git commit -m "feat(supervisor): add SupervisorBadge in ProfileView"
```

---

## Phase 7 — Verification

### Task 7.1: End-to-end manual verification

**Files:** None modified.

- [ ] **Step 1: Run all tests**

Run: `bun test`

Expected: All tests pass. No failures.

- [ ] **Step 2: TypeScript typecheck**

Run: `bunx tsc --noEmit`

Expected: No errors. (If errors exist, fix them inline — do not skip.)

- [ ] **Step 3: Build the full bundle**

Run: `bun run build`

Expected: Build succeeds, produces `dist/` artifacts.

- [ ] **Step 4: Manual UI walkthrough (Playwright MCP per CLAUDE.md)**

1. Start dev server.
2. Open `/supervisor`. Enable supervisor. Configure provider/model (e.g., anthropic + claude-opus-4-7) via UI or curl.
3. Create or use an existing sub-agent profile. Start it on a directive that is impossible to satisfy (e.g., "Travel to a nonexistent system").
4. Wait for ~5-8 minutes (or accelerate by temporarily lowering `activity_stuck_minutes` in `watchdog_thresholds` to 1).
5. Verify in `/supervisor`:
   - "Recent Activity" shows tick + anomaly_detected + llm_call events.
   - A pending proposal appears (likely directive change).
   - Notes show observations.
6. Click Apply on the proposal. Verify:
   - Sub-agent's directive updates.
   - Sub-agent's log shows `supervisor_action` entry.
   - Proposal status flips to `applied`.
7. Click Reject on a different proposal. Verify status flips to `rejected`.

Take screenshots at each step.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit --allow-empty -m "test(supervisor): manual e2e verification complete"
```

---

### Task 7.2: Open PR or merge to main

**Files:** None modified.

- [ ] **Step 1: Push branch (user decides)**

Ask the user whether to push the branch and open a PR, or merge directly to main. Do NOT push without explicit user instruction.

Example: `gh pr create --title "feat: Supervisor Agent" --body-file docs/specs/2026-05-15-supervisor-agent-design.md`

---

## Notes on potential gotchas

1. **`bun install` sandbox block.** The very first task may hit a sandbox permission error. Retry with sandbox disabled — it is a known, harmless install.

2. **`Agent.lastActivityChangeMs` may not exist.** Task 4.3 adds it. If the `Agent` class is already large and refactoring `activity` setters causes friction, an alternative is to derive the timestamp from the most recent `log_entries` row for the profile — slightly less precise but zero refactoring.

3. **Circular imports.** The `manager.ts` uses lazy `require()` for `model.ts`/`providers.ts`. If your codebase enforces ESM-only, replace `require()` with dynamic `await import(...)` inside the methods.

4. **`updateProfile` signature mismatch.** Task 5.1's Apply handler calls `updateProfile(id, { directive })`. Verify against `db.ts:185`. The existing function may accept a different shape (e.g., a whole `Profile` row); adapt the call.

5. **Test runner is `bun test`, NOT `vitest`.** Despite CLAUDE.md mentioning a PostToolUse vitest hook, the repo's actual tests (`tools.test.ts`) use `bun:test` imports, which vitest cannot resolve. All test commands in this plan use `bun test`. If the vitest hook fires automatically on edits and fails, that's expected — it does not block our work.

6. **Pi-AI's `complete()` tool format.** Verify the shape of `tools` parameter — the spec assumes pi-ai accepts an array of `{ name, description, parameters }`. If pi-ai expects a different shape, adapt `supervisorToolDefinitions` accordingly. Run a single integration call to confirm before relying on it in the full loop.
