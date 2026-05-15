# Admiral: Supervisor Agent

**Date:** 2026-05-15
**Status:** Draft (pending user review)
**Goal:** Add an LLM-based Supervisor Agent (Opus 4.7) that monitors running sub-agents, detects stagnation and anomalies via cheap heuristics, and intervenes strategically via nudges and directive-change proposals.

## Context

Admiral's `AgentManager` already supplies most of the infrastructure a supervisor needs: per-profile LLM loops, auto-restart with backoff, log persistence, game-state tracking, and a complete set of intervention APIs (`nudge`, `restartTurn(directive)`, `pauseLLM`, `resumeLLM`). What's missing is a higher-level component that **decides when and how to use those interventions**.

Sub-agents running on Haiku/Sonnet can get stuck in loops, pursue failed strategies, or burn tokens in tactical sinkholes that the agent itself cannot detect (because the model that's stuck cannot diagnose its own stuckness). A more capable model (Opus) running periodically on top is a well-known multi-agent pattern (hierarchical agents, model cascading) and fits Admiral's architecture cleanly.

The Supervisor is **additive**: no breaking changes to existing agents, profiles, or API routes. Sub-agents continue working identically whether the Supervisor is enabled or not.

## Decisions

- **Pattern:** Two-tier monitoring — cheap deterministic Watchdog (Tier 1) gates an expensive LLM Supervisor (Tier 2).
- **Hierarchy:** 1 Supervisor → N sub-agents. No supervisor-of-supervisor.
- **Authority (Hybrid):**
  - **Nudges** are executed autonomously (low-risk, one-message effect).
  - **Directive changes** and **Pause/Resume** are stored as proposals; user clicks Apply in UI.
- **Trigger:** `setInterval(60s)` for stagnation + event hook in `addLogEntry` for cost-spike detection.
- **State model:** Stateless per tick. Persistent `supervisor_notes` table provides "memory" without long conversation contexts.
- **Identity:** Singleton config stored in `preferences` table (no `supervisors` table; only one Supervisor per Admiral instance).
- **Model:** Default Opus 4.7. User can override via config.
- **Scope discipline:** Supervisor has no game-state tools (cannot mine/trade/travel). Read-only on game-state, write-only on sub-agent meta-controls.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Admiral Server (Bun Process)                           │
│                                                         │
│  ┌──────────────┐    ┌──────────────┐    ┌───────────┐ │
│  │ Sub-Agent A  │    │ Sub-Agent B  │    │   ...     │ │
│  │ (Haiku/Sonn) │    │ (Haiku/Sonn) │    │           │ │
│  └──────┬───────┘    └──────┬───────┘    └───────────┘ │
│         │ logs / state       │ logs / state            │
│         ▼                    ▼                          │
│  ┌─────────────────────────────────────────────────┐   │
│  │  Tier 1: Watchdog                               │   │
│  │  Trigger: setInterval(60s) + event hook on      │   │
│  │           llm_call log entries                  │   │
│  │  Pure heuristics, no LLM, sub-millisecond cost  │   │
│  │                                                 │   │
│  │  Checks: stagnation, cost spike, max_rounds,    │   │
│  │  state-vs-log mismatch, error burst             │   │
│  └──────────────────┬──────────────────────────────┘   │
│                     │ if anomaly detected               │
│                     ▼                                   │
│  ┌─────────────────────────────────────────────────┐   │
│  │  Tier 2: Supervisor (Opus, stateless per run)   │   │
│  │                                                 │   │
│  │  Reads:  notes + recent logs + game-state +     │   │
│  │          signals + pending proposals            │   │
│  │  Tools:  send_nudge (autonomous),               │   │
│  │          propose_directive_change (proposal),   │   │
│  │          propose_pause / propose_resume,        │   │
│  │          update_notes, do_nothing               │   │
│  │  Writes: notes update + audit log + proposals + │   │
│  │          sub-agent log entry (type=             │   │
│  │          'supervisor_action')                   │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### File layout

```
src/server/
├── lib/
│   └── supervisor/
│       ├── manager.ts         # Singleton lifecycle, tick orchestration, semaphore
│       ├── watchdog.ts        # Tier 1 heuristics + signal computation
│       ├── loop.ts            # Tier 2 single-pass LLM invocation
│       ├── tools.ts           # Supervisor tool definitions + handlers
│       ├── notes.ts           # supervisor_notes CRUD
│       ├── proposals.ts       # supervisor_proposals CRUD + apply logic
│       ├── audit.ts           # supervisor_audit insert helpers
│       └── prompt.ts          # System prompt builder
├── routes/
│   └── supervisor.ts          # /api/supervisor/* endpoints

src/frontend/src/components/
├── SupervisorPanel.tsx        # Status + config + pending proposals
└── SupervisorBadge.tsx        # In-ProfileView indicator for active supervisor attention
```

## Data Model

### `preferences` entries (Singleton config)

All values stored as TEXT (the existing schema is key-value with TEXT values).

| Key | Value format | Example |
|---|---|---|
| `supervisor.enabled` | `"true"` / `"false"` | `"false"` (default: opt-in) |
| `supervisor.provider` | Provider name from `providers` table | `"anthropic"` |
| `supervisor.model` | Model id | `"claude-opus-4-7"` |
| `supervisor.system_prompt` | Override of default system prompt (empty = use default) | `""` |
| `supervisor.tick_interval_seconds` | Watchdog tick interval | `"60"` |
| `supervisor.watchdog_thresholds` | JSON with all heuristic thresholds | (see below) |

API keys are resolved through the existing `providers` table — no duplication of key management.

#### Default `watchdog_thresholds` JSON

```json
{
  "activity_stuck_minutes": 5,
  "no_llm_progress_minutes": 8,
  "cost_spike_window_minutes": 10,
  "cost_spike_threshold_usd": 0.50,
  "max_rounds_window_hours": 1,
  "max_rounds_count_threshold": 2,
  "state_log_mismatch_minutes": 10,
  "error_burst_window_minutes": 10,
  "error_burst_count_threshold": 5,
  "proposal_expiry_hours": 6,
  "max_concurrent_supervisor_runs": 2
}
```

### New tables

```sql
CREATE TABLE supervisor_notes (
  profile_id    TEXT PRIMARY KEY,
  observations  TEXT NOT NULL DEFAULT '',
  last_strategy TEXT NOT NULL DEFAULT '',
  open_concerns TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

CREATE TABLE supervisor_proposals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id  TEXT NOT NULL,
  action      TEXT NOT NULL,        -- 'set_directive' | 'pause' | 'resume'
  payload     TEXT NOT NULL,        -- JSON: action-specific fields
  reasoning   TEXT NOT NULL,        -- Opus's justification
  status      TEXT NOT NULL DEFAULT 'pending',
                                    -- 'pending' | 'applied' | 'rejected' | 'expired'
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

CREATE INDEX idx_proposals_pending ON supervisor_proposals(status, created_at)
  WHERE status = 'pending';

CREATE TABLE supervisor_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp  TEXT NOT NULL DEFAULT (datetime('now')),
  event_type TEXT NOT NULL,
              -- 'tick' | 'anomaly_detected' | 'llm_call' | 'nudge_sent'
              -- | 'proposal_created' | 'proposal_applied' | 'proposal_rejected'
              -- | 'proposal_expired' | 'supervisor_skip' | 'error'
  target_profile_id TEXT,           -- nullable: some events are global (e.g. tick)
  summary    TEXT NOT NULL,
  detail     TEXT,                  -- optional JSON detail
  FOREIGN KEY (target_profile_id) REFERENCES profiles(id) ON DELETE SET NULL
);

CREATE INDEX idx_audit_timestamp ON supervisor_audit(id DESC);
CREATE INDEX idx_audit_target ON supervisor_audit(target_profile_id, id DESC);
```

Migration strategy: tables are created with `CREATE TABLE IF NOT EXISTS` in `db.ts initDb()`. Purely additive — no changes to existing tables.

### Foreign-key actions, deliberately mixed

- `supervisor_notes`, `supervisor_proposals` → `CASCADE`: they have no meaning without the sub-agent.
- `supervisor_audit` → `SET NULL`: audit trail survives profile deletion (forensic value).

### Side-effect logs on sub-agent

When the Supervisor sends a nudge or a proposal is applied, an entry is **also** written to the sub-agent's `log_entries` with `type='supervisor_action'`. This is purely for UX (intervention visible in the normal LogPane); the source of truth is `supervisor_audit`.

## Tier 1: Watchdog

Pure heuristic check, synchronous, no async work. Decides whether to invoke the (expensive) Supervisor.

### Signals (per running sub-agent)

| Signal | Computation | Default threshold |
|---|---|---|
| `activity_stuck` | `now - agent.lastActivityChange > X` | 5 min |
| `no_llm_progress` | No `llm_call` log entry in last X min while running and not paused | 8 min |
| `cost_spike` | Sum of `usage.cost.total` from `llm_call` logs in last 10 min | $0.50 / 10min |
| `max_rounds_repeated` | Count of `Reached max tool rounds` log entries | ≥ 2 in 1h |
| `state_log_mismatch` | Logs mention productive activity but `gameState.cargo_used` and `gameState.credits` unchanged | > 10 min |
| `error_burst` | Count of `type='error'` log entries | ≥ 5 in 10 min |

Thresholds live in `preferences.supervisor.watchdog_thresholds` (JSON) so they're tunable without redeploy.

### Tick lifecycle (pseudo-code)

```typescript
function watchdogTick() {
  if (!isSupervisorEnabled()) return
  insertAudit('tick', null, 'Watchdog tick started')

  for (const profileId of agentManager.listActive()) {
    const signals = computeSignals(profileId)
    if (signals.anyFired()) {
      insertAudit('anomaly_detected', profileId, signals.summary(), signals.detail())
      enqueueSupervisorRun(profileId, signals)
    }
  }
  expireOldProposals()  // mark proposals > expiry_hours old as 'expired'
}
```

### Event-hook (cost-spike short path)

Inside `db.addLogEntry()`, when an entry with `type='llm_call'` is inserted, the Watchdog runs a **single check** (cost-spike only) for that profile. If it fires, the Supervisor is triggered immediately instead of waiting up to 60 s for the next tick.

This addresses the failure mode where a sub-agent burns tokens fast — periodic-only polling would miss the spike for nearly a minute.

### Concurrency control

- `SupervisorManager` holds `Map<profileId, Promise>` of in-flight runs.
- If a sub-agent is already being supervised when a new anomaly fires for it, the new one is **dropped** and logged as `event_type='supervisor_skip'`.
- Global semaphore: `MAX_CONCURRENT_SUPERVISOR_RUNS = 2`. Excess runs are dropped (they'll fire again next tick).

This is "backpressure via drop" — acceptable here because the underlying anomaly persists and will retrigger.

## Tier 2: Supervisor Loop

**Stateless, single-pass** LLM invocation. Not a multi-round loop. It runs, makes 0–N tool calls, finishes.

### Lifecycle

```typescript
async function runSupervisorTurn(profileId: string, signals: Signals) {
  const cfg = loadSupervisorConfig()
  const model = resolveModel(cfg.provider, cfg.model)

  const context = buildContext({
    notes: getNotes(profileId),
    logs: getRecentLogs(profileId, 30),
    gameState: agentManager.getStatus(profileId).gameState,
    signals,
    pendingProposals: getPendingProposals(profileId),
  })

  insertAudit('llm_call', profileId, 'Supervisor invoked', { signals })

  const response = await complete(model, context, {
    apiKey: resolveApiKey(cfg.provider),
    maxTokens: 1500,
    tools: supervisorToolDefinitions,
  })

  for (const toolCall of extractToolCalls(response)) {
    await executeSupervisorTool(toolCall, profileId)
  }

  // Notes update always happens (Opus may have nothing else to do but observations evolve)
  updateNotes(profileId, extractObservationsFromResponse(response))
}
```

### Context budget

Target: **~3–5 k tokens per Opus call**.

| Section | Approx tokens |
|---|---|
| System prompt (role + tool descriptions) | ~500 |
| Notes snapshot for this sub-agent (capped) | ~300 |
| Last 30 log entries, slimmed | ~1.5–3 k |
| Game state (existing `slimGameState`) | ~200 |
| Triggering signals | ~100 |
| Pending proposals for this sub-agent | ~100 |

Cost estimate at Opus 4.7 pricing: ~$0.15 per invocation.

### Tool inventory

| Tool | Authority | Handler effect |
|---|---|---|
| `send_nudge(message)` | **Autonomous** | `agentManager.nudge(profileId, message)` + audit + sub-agent log |
| `propose_directive_change(new_directive, reasoning)` | **Proposal** | Insert pending row in `supervisor_proposals` |
| `propose_pause(reasoning)` | **Proposal** | Insert pending row |
| `propose_resume(reasoning)` | **Proposal** | Insert pending row |
| `update_notes(observations, last_strategy, open_concerns)` | **Autonomous** | UPSERT `supervisor_notes` |
| `do_nothing(reasoning)` | **Autonomous** | Log to audit only ("all fine, false alarm") |

The tool descriptions explicitly state the authority level so Opus picks correctly.

### System prompt (default)

> You are the Admiral Supervisor. Your role is to observe sub-agents playing SpaceMolt and intervene when they are stuck, wasting resources, or pursuing failed strategies.
>
> You see: persistent notes you wrote previously, the sub-agent's recent log entries, current game state, the heuristic signals that triggered this invocation.
>
> Authority levels:
> - **Nudges** are immediate. They inject a short message into the sub-agent's context. Use them for tactical hints ("there's a closer asteroid belt at...", "your fuel is low, refuel before traveling").
> - **Directive changes** require human approval. They replace the sub-agent's high-level strategy. Use sparingly — only when the current strategy is clearly failing.
> - **Pause/Resume** require human approval. Only when something is structurally broken (e.g., the sub-agent keeps hitting the same error).
>
> Always update your notes at the end of every invocation. Be concise — single-sentence observations beat paragraphs. If everything looks fine, call `do_nothing` with a one-line reason. Never speculate without evidence in the logs or game state.

## Action Authority & Proposal Flow

### Authority matrix

| Action | Authority | Justification |
|---|---|---|
| `send_nudge` | Autonomous | Single message in sub-agent context; small blast radius; reversible by the sub-agent itself ignoring it. |
| `set_directive` | Proposal | Persistent change to sub-agent behavior; large blast radius. |
| `pause` | Proposal | Stops sub-agent indefinitely; high impact on running missions. |
| `resume` | Proposal | Restarts intentional pauses set by user; user must confirm intent matches. |
| `update_notes` | Autonomous | Supervisor's own internal state; no effect on sub-agents. |

### Proposal lifecycle

```
                  Opus calls propose_*
                        │
                        ▼
              status = 'pending'
                        │
        ┌───────────────┼────────────────────┐
        │               │                    │
   user Apply       user Reject       6h timeout
        │               │                    │
        ▼               ▼                    ▼
  status =          status =            status =
  'applied'        'rejected'           'expired'
        │
        ▼
  agentManager call
  (restartTurn / pause / resume)
        │
        ▼
  log entry in sub-agent's
  log_entries (type=
  'supervisor_action')
```

### REST endpoints (`/api/supervisor`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/config` | Get current supervisor config |
| PUT | `/config` | Update config (enabled, provider, model, thresholds, system_prompt) |
| GET | `/status` | Enabled / running / last tick / pending proposal count |
| GET | `/proposals` | List proposals (filter by status query param) |
| POST | `/proposals/:id/apply` | Apply a pending proposal |
| POST | `/proposals/:id/reject` | Reject a pending proposal |
| GET | `/audit` | Audit log (paginated, optional target_profile_id filter) |
| GET | `/notes/:profileId` | Read notes for a sub-agent |
| POST | `/run` | Manual trigger (force a supervisor run on a profile; bypasses Watchdog signals but still respects `MAX_CONCURRENT_SUPERVISOR_RUNS` semaphore) |

## UI Integration

### `SupervisorPanel` (new component, top-level)

Lives as an additional pane / tab in the main layout (next to existing `LogPane`/`CommandPanel`). Shows:

- **Status row:** Enabled toggle, model picker, last-tick timestamp, in-flight indicator.
- **Pending proposals list:** card per proposal with action type, target sub-agent, payload preview, reasoning, Apply/Reject buttons.
- **Recent audit feed:** scrollable list of last 50 audit entries (filterable by event type).
- **Per-profile notes accordion:** click sub-agent name → expand to show current notes.
- **Manual trigger:** "Run Supervisor Now" button per sub-agent (calls `POST /api/supervisor/run`).

### `SupervisorBadge` (small, embedded)

Lives inside `ProfileView` (sub-agent view). Shows a small badge when:

- There's a pending proposal for this sub-agent ("⚠ 1 Supervisor proposal awaiting approval"), or
- The Supervisor flagged this sub-agent in the most recent tick.

Clicking the badge opens the Supervisor Panel scoped to that sub-agent.

### Configuration UI

Reuses existing `ModelPicker` and `ProviderSetup` components — these will need to be made provider-context-agnostic (currently coupled to profile context). Small refactor identified as part of this work.

## Error Handling & Edge Cases

| Scenario | Handling |
|---|---|
| Supervisor LLM call fails (network, rate limit) | Log `event_type='error'` to audit; do NOT retry within this tick; next anomaly will retrigger |
| Sub-agent disconnected mid-supervisor-run | Run completes; tool handlers check `agentManager.getAgent(profileId)?.isConnected` before calling intervention APIs; skip with audit entry if disconnected |
| Proposal applied to disconnected sub-agent | Apply endpoint returns 409 Conflict; UI shows error toast; proposal stays `pending` until user retries or rejects |
| Provider/model deleted from `providers` table | Supervisor auto-disables (sets `supervisor.enabled=false`) and writes audit entry on next tick |
| User toggles supervisor off mid-run | In-flight Supervisor runs complete normally; new ticks skip until re-enabled |
| Watchdog computes signal before first log entry for sub-agent | Signals return false; no anomaly; standard quiet path |
| `supervisor_notes` row missing for a sub-agent | Treated as empty notes; `update_notes` handler does UPSERT |
| Database write failure mid-tick | Each insertion wrapped in `try/catch`; failures logged but don't crash the tick |
| Supervisor and user submit conflicting actions (user clicks Pause while supervisor proposes Resume) | Last write wins on `agentManager`; proposals targeting a state-different sub-agent are still valid, the user can Apply/Reject knowing current state |

## Testing Strategy

Three layers, matching repo's existing pattern (`tools.test.ts`):

### Unit tests

- `watchdog.test.ts` — each signal computation with synthetic log/state fixtures. Pure functions; trivial to test.
- `proposals.test.ts` — proposal CRUD, status transitions, expiry logic.
- `audit.test.ts` — audit insertion helpers.
- `notes.test.ts` — UPSERT semantics, cascade on profile delete.
- `tools.test.ts` (supervisor variant) — tool handlers with mocked `agentManager`.

### Integration tests

- `loop.test.ts` — full supervisor turn with a fake LLM (mock `complete()`); assert tool calls fire correct handlers and DB writes happen.
- `manager.test.ts` — tick orchestration, semaphore behavior, event-hook short-path.

### Manual / UI verification (per CLAUDE.md guidance: Playwright MCP)

- Enable supervisor in UI, set provider/model, verify config persisted.
- Force a stagnant sub-agent (point it at a directive that's impossible to satisfy), wait for supervisor to fire.
- Verify pending proposal appears in UI, Apply works and triggers `restartTurn`, Reject works.
- Verify audit feed updates in realtime.

Coverage target: each new file ≥ 70 % line coverage for non-trivial code paths.

## Out of Scope (explicit non-goals)

- **Supervisor can play the game itself** — no game tools, supervisor is meta-only.
- **Multiple supervisors / supervisor hierarchy** — singleton only.
- **Cross-Admiral-instance supervisor (cluster mode)** — single-process.
- **Supervisor learns / fine-tunes** — purely zero-shot Opus, no training loop.
- **Auto-applying high-risk proposals after N successful manual applies** — explicit out-of-scope for V1. Could be a V2 feature once trust data accumulates.
- **Supervisor for the supervisor** — no recursive monitoring.
- **Per-sub-agent custom system prompts for supervisor** — single global system prompt; per-sub-agent context comes from notes.
- **Proactive cost caps** (e.g., "auto-pause sub-agent X when daily spend exceeds $Y") — distinct feature, can be built later on top of audit data.

## Open Questions (to revisit during implementation)

- Should the Watchdog also re-evaluate signals **after** a nudge is sent (to detect "the nudge didn't help" within 1-2 ticks)? Could be a follow-up enhancement.
- For `state_log_mismatch`, should we also include `gameState.ship.hull` / `shield` (no combat progress while logs say "fighting")? Open during implementation.
- Should `propose_directive_change` payload include diff vs. current directive, or full replacement? Initial proposal: full replacement (simpler to reason about, displays better in UI).

## Implementation Sketch (high-level)

The detailed step-by-step plan lives in `2026-05-15-supervisor-agent-plan.md` (companion document). High-level phases:

1. **Schema + persistence layer** — DB tables, `notes.ts`, `proposals.ts`, `audit.ts`.
2. **Watchdog** — signal computations, tick orchestration, event hook in `addLogEntry`.
3. **Supervisor loop** — `runSupervisorTurn`, tools, prompt.
4. **Manager + lifecycle** — `setInterval` registration in `index.ts`, semaphore.
5. **REST endpoints** — `/api/supervisor/*` routes.
6. **UI** — `SupervisorPanel`, `SupervisorBadge`, config integration.
7. **Tests + manual verification.**
