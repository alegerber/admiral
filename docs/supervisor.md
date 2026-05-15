# Supervisor Agent — Operator Guide

The Admiral **Supervisor Agent** watches your running sub-agents, notices when they get stuck or burn money, and intervenes — either autonomously via short "nudges" or by proposing higher-impact changes (like swapping their directive) for you to approve.

This guide explains what the Supervisor does, when it acts, how to configure it, and how to observe and debug it.

For the underlying design rationale see [`docs/specs/2026-05-15-supervisor-agent-design.md`](specs/2026-05-15-supervisor-agent-design.md). For implementation details see [`docs/plans/2026-05-15-supervisor-agent-plan.md`](plans/2026-05-15-supervisor-agent-plan.md).

---

## Mental Model in 60 Seconds

The Supervisor is a **two-tier** system inside Admiral's server process:

```
Tier 1 — Watchdog               Tier 2 — Supervisor
(cheap, deterministic,           (expensive, LLM-based,
 runs every 60s + on every       runs ONLY when Tier 1 finds
 llm_call log entry)              something interesting)
        │                                │
        ▼                                ▼
 6 heuristic signals              Opus reads notes + logs +
 (activity, cost, errors, ...)    game state, decides:
                                  - send_nudge (autonomous)
                                  - propose change (needs you)
                                  - update notes
                                  - do nothing
```

The point of the split is **cost discipline**. Opus calls cost ~$0.15 each. Polling 5 sub-agents every minute with Opus would be ~$45 / day even at idle. So the Watchdog filters first; Opus only runs when there's something worth thinking about.

---

## When the Supervisor Intervenes

The Supervisor only runs when **at least one signal** fires for a sub-agent during the Watchdog's check. There are **6 signals**, each independently configurable:

| Signal | What it detects | Default trigger | When it usually fires |
|---|---|---|---|
| `activity_stuck` | Sub-agent's `activity` string hasn't changed in N minutes | > 5 min unchanged | Sub-agent looping in one phase ("Mining...") without progressing |
| `no_llm_progress` | No `llm_call` log entry in N minutes AND activity is stale | > 8 min idle | Sub-agent waiting forever for a tool result that never returns |
| `cost_spike` | Sum of `usage.cost.total` across `llm_call` logs in a window exceeds threshold | > $0.50 / 10 min | Sub-agent stuck in a tight LLM-loop burning tokens |
| `max_rounds_repeated` | Count of "Reached max tool rounds" system logs in last hour | ≥ 2 in 1 h | Sub-agent's tasks consistently exhaust the per-turn tool budget |
| `state_log_mismatch` | Logs mention productive activity ("mine", "trade") but `gameState.cargo` / `credits` unchanged for N minutes | > 10 min mismatched | Sub-agent *thinks* it's mining but is actually re-rolling errors |
| `error_burst` | Count of `type='error'` log entries in a window ≥ threshold | ≥ 5 in 10 min | Sub-agent in error-storm (bad directive, connection issues) |

**Guard conditions:** No signal fires if the sub-agent is currently paused (`isPaused`) or not running (`isRunning === false`). The supervisor doesn't interrupt deliberate pauses.

**Where defaults live:** `DEFAULT_THRESHOLDS` in [`src/server/lib/supervisor/config.ts`](../src/server/lib/supervisor/config.ts). They're stored in the `preferences` table under `supervisor.watchdog_thresholds` (JSON) and can be tuned via `PUT /api/supervisor/config`.

---

## What the Supervisor Can Do (Tools)

When a signal fires, the Watchdog hands control to **Opus** (default `claude-opus-4-7`). Opus sees: persistent notes, last 30 log entries, current game state, the firing signals, any pending proposals. It then picks **0 or 1** of these tools:

| Tool | Authority | What happens |
|---|---|---|
| `send_nudge(message)` | **Autonomous** | A short hint is injected into the sub-agent's next LLM context |
| `propose_directive_change(new_directive, reasoning)` | **Proposal** | Saved as `pending` in `supervisor_proposals`; you Apply/Reject in the UI |
| `propose_pause(reasoning)` | **Proposal** | Pending until you Apply |
| `propose_resume(reasoning)` | **Proposal** | Pending until you Apply |
| `update_notes(observations, last_strategy, open_concerns)` | **Autonomous** | Refreshes the supervisor's persistent memory for this sub-agent |
| `do_nothing(reasoning)` | **Autonomous** | Records a "looked, all fine" event |

**Hybrid authority** is deliberate: nudges have small blast radius (one message in one sub-agent's context), so the Supervisor sends them directly. Directive changes and pause/resume have larger blast radius, so they require your explicit Apply click.

Once you click Apply on a `set_directive` proposal:
1. The sub-agent's `directive` field in the DB is updated
2. `agentManager.restartTurn(profileId)` kicks the current turn to pick up the new directive
3. A `supervisor_action` log entry appears in the sub-agent's normal LogPane

---

## A Day in the Life — Worked Example

Say Sub-Agent `mineralis` is running with the directive "mine iron in Solarian asteroid belts and sell at Marsport". You enable the Supervisor.

Timeline:

```
T=0      You enable Supervisor                        →  audit: (waiting for first tick)
T=15s    Watchdog tick fires                          →  audit: tick (no anomalies)
T=75s    Watchdog tick again                          →  audit: tick
T=2:30   mineralis hits 3 mining errors in a row      →  sub-agent log_entries: 3x 'error'
T=2:32   Server adds another 2 errors via the LLM    →  sub-agent log_entries: 5x 'error'
T=2:35   Watchdog tick:
           - error_burst signal: 5 errors in 10min ≥5 →  audit: anomaly_detected (error_burst)
           - enqueues supervisor run                  →  audit: llm_call (Opus invoked)
T=2:40   Opus responds:
           - Reads logs: sees "asteroid not found" pattern
           - Reads state: ship is intact, fuel ok, location matches directive
           - Conclusion: directive points at a depleted belt
           - Calls propose_directive_change(...)      →  audit: proposal_created
           - Calls update_notes(...)                  →  audit: notes_updated
T=2:40   SupervisorBadge appears on mineralis's profile: "⚠ 1 supervisor proposal"
T=2:55   You click the badge → Supervisor overlay opens scoped to the proposal
T=3:00   You click Apply:
           - mineralis.directive ← "mine iron in Nebula Collective belts"
           - mineralis.restartTurn()                  →  audit: proposal_applied
           - mineralis's normal log: "Supervisor proposal applied: set_directive"
T=3:01   mineralis continues with the new directive
```

The whole intervention takes ~1 minute from anomaly detection to your decision. Cost: ~1 Opus call (~$0.15).

---

## Configuration

### Via UI (recommended for V1)

Open the Supervisor overlay (Dashboard top bar → "Supervisor" button) and:

- **Provider** — only providers with `status='valid'` (configured API key, validated) appear in the dropdown
- **Model** — narrowed to models available for the selected provider (uses the same `ModelPicker` as the rest of Admiral)
- **Enable/Disable** — single toggle

Both Provider and Model auto-save on change (no Save button).

### Via REST API

For anything not exposed in the UI (system prompt, tick interval, thresholds):

```bash
# Get current config
curl -s http://localhost:3031/api/supervisor/config | jq

# Adjust a single threshold (partial PUT — merges with current)
curl -X PUT http://localhost:3031/api/supervisor/config \
  -H 'content-type: application/json' \
  -d '{"thresholds":{"activity_stuck_minutes":3}}'

# Set a custom system prompt
curl -X PUT http://localhost:3031/api/supervisor/config \
  -H 'content-type: application/json' \
  -d '{"systemPrompt":"You are an extra-cautious supervisor..."}'

# Change tick interval (requires server restart to take effect — known limitation)
curl -X PUT http://localhost:3031/api/supervisor/config \
  -H 'content-type: application/json' \
  -d '{"tickIntervalSeconds":30}'
```

### Persistence

All supervisor config lives in the `preferences` table under keys prefixed `supervisor.*`:
- `supervisor.enabled` — `"true"` / `"false"`
- `supervisor.provider` — provider id
- `supervisor.model` — model id
- `supervisor.system_prompt` — override (empty = use default)
- `supervisor.tick_interval_seconds` — integer string
- `supervisor.watchdog_thresholds` — JSON blob with all 11 numeric thresholds

API keys are NOT stored in supervisor preferences — they're resolved at runtime from the `providers` table (same place sub-agents read them).

---

## Observing the Supervisor

In rough order of immediacy:

| Where | Latency | Detail | Use when |
|---|---|---|---|
| Supervisor Overlay → "Recent Activity" | up to 5s polling | Last 20 audit events | Default — everyday observation |
| Supervisor Overlay → "Pending Proposals" | up to 5s polling | Each pending proposal with Apply/Reject | When you need to act |
| `SupervisorBadge` on `ProfileView` | up to 5s polling | "⚠ N proposals" pill | When you want passive notification per sub-agent |
| Sub-agent's normal LogPane | live | Entries of type `supervisor_action` (only nudges + applied proposals) | When you want intervention shown in agent context |
| `GET /api/supervisor/audit?limit=100&profileId=X` | direct | Full audit feed with filters | Forensics across all sub-agents or beyond last 20 |
| `sqlite3 data/admiral.db "..."` | direct | Raw rows incl. `detail` JSON (usage, cost, signals) | Cost analysis or schema-level debugging |

### Event types you'll see in audit

- `tick` — Watchdog heartbeat (also fires when nothing else happens; proves Supervisor is alive)
- `anomaly_detected` — One or more signals fired; the `summary` field names which
- `llm_call` — Opus invocation about to start (logged BEFORE the call so failed calls still appear)
- `nudge_sent` / `proposal_created` / `notes_updated` / `do_nothing` — Tool outcomes
- `proposal_applied` / `proposal_rejected` / `proposal_expired` — Proposal lifecycle
- `supervisor_skip` — Concurrency cap reached or sub-agent disconnected when an intervention was attempted
- `error` — LLM call failed, profile missing, or any other handler exception

### Heartbeat sanity check

If the Supervisor is enabled, you should see a `tick` audit row **at most every `tickIntervalSeconds` seconds**. If you don't:
- Config might be `enabled: false` — check `GET /api/supervisor/status`
- Server might not have been restarted since you changed the interval (known limitation, see below)
- `supervisorManager.instance` might be null due to a startup error — check server stdout

---

## Triggering an Anomaly Manually (Testing)

Three ways, from fastest to most realistic:

### Fastest — inject log entries

```bash
# Trigger error_burst on profile <id>
sqlite3 data/admiral.db "
  INSERT INTO log_entries (profile_id, type, summary) VALUES
    ('<id>', 'error', 'manual test 1'),
    ('<id>', 'error', 'manual test 2'),
    ('<id>', 'error', 'manual test 3'),
    ('<id>', 'error', 'manual test 4'),
    ('<id>', 'error', 'manual test 5');
"
```

Next Watchdog tick (≤ 60s) will fire `error_burst → anomaly_detected → llm_call`. Make sure the sub-agent is `running` and not `paused`, otherwise the Watchdog's guard suppresses all signals.

### Direct — call the manual `/run` endpoint

```bash
curl -X POST http://localhost:3031/api/supervisor/run \
  -H 'content-type: application/json' \
  -d '{"profileId":"<id>"}'
```

Bypasses the Watchdog and runs the Supervisor with empty signals. Opus will likely respond with `do_nothing` since there's no triggering anomaly in its context — but it proves the LLM connection works.

### Realistic — give a sub-agent a bad directive

Set extreme thresholds via API, then give a sub-agent a directive guaranteed to fail (e.g., "Travel to system NONEXISTENT-XYZ"). The sub-agent will error-storm, the Watchdog will see it, and the Supervisor will be called for real.

---

## Cost Model

Per Supervisor run (single Opus invocation):

| Section | Approx tokens | Approx $ at Opus 4.7 pricing |
|---|---|---|
| System prompt | ~500 | ~$0.008 in |
| Notes snapshot | ~300 | ~$0.005 in |
| 30 recent log entries (slim) | ~1.5–3 k | ~$0.025–0.045 in |
| Game state | ~200 | ~$0.003 in |
| Triggering signals + pending proposals | ~200 | ~$0.003 in |
| **Total input** | ~2.7–4.2 k | ~$0.04–0.06 in |
| Output (tools + reasoning) | ~300–1 k | ~$0.02–0.075 out |
| **Total per run** | — | **~$0.06 – 0.15** |

Concurrency cap: at most `max_concurrent_supervisor_runs` (default 2) parallel Opus calls. Excess runs are dropped (`supervisor_skip` event) — they will retrigger at the next tick if the anomaly persists.

Cost ceiling for a typical setup (2 sub-agents, default thresholds, mostly healthy): expect **< $1/day** of Supervisor cost. If you see more, that's a signal something is unhealthy and the Supervisor is firing too often — investigate via the audit feed.

---

## Known Limitations (V1)

These are deliberate trade-offs. They're noted in the PR and tracked for post-merge follow-up.

1. **`setInterval` doesn't re-arm on config change.** Changing `tickIntervalSeconds` via the API takes effect only after a server restart. The supervisor still works at the original interval until restart.
2. **No SSE / live push.** The UI polls every 5s. Up to 5s lag between an event happening and appearing in the overlay.
3. **No in-flight guard on Apply/Reject buttons.** Rapid double-clicks send duplicate POSTs; the backend's `setProposalStatus` guard catches this with a 409, so impact is cosmetic.
4. **`state_log_mismatch` is intentionally simplified.** It checks log-content for "mining/trading" mentions vs. stale activity, not actual game-state diffs over time. A full version would need state snapshots.
5. **No retry on LLM failure.** A single failed Opus call writes an `error` audit row; the next tick will retry if the anomaly persists.
6. **The Supervisor cannot play the game.** Read-only on game state, no `mine()` / `travel()` tools. By design — it's a meta-layer, not a meta-player.
7. **No proactive cost caps per profile.** You can see costs in the audit; auto-pausing a sub-agent that exceeds $/day is a separate future feature.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Audit feed stays empty after enabling | Config not actually saved, or server not restarted | `curl /api/supervisor/config` to verify; check server stdout for startup errors |
| `tick` events appear but no `anomaly_detected` | Thresholds too high for your situation | Lower thresholds via `PUT /api/supervisor/config`; default thresholds expect minutes-scale problems |
| `anomaly_detected` appears but no `llm_call` | Supervisor enabled but provider/model not set | Configure in the overlay or `PUT /api/supervisor/config` |
| `llm_call` followed by `error` event | API key missing / invalid, or model name typo | Check the `detail` JSON of the error event; verify `/api/providers` for the key |
| Proposal appears but Apply returns 409 | Sub-agent disconnected when you clicked Apply | Reconnect the sub-agent, then Apply again |
| Same nudge repeating every tick | Opus doesn't see the nudge worked (sub-agent ignored it) | Either the directive is fundamentally wrong (try Apply a directive proposal), or the heuristic is over-firing — tune thresholds |
| Tons of `supervisor_skip` events | Concurrency cap hit by N misbehaving sub-agents | Pause some sub-agents to free up cap; consider raising `max_concurrent_supervisor_runs` if your budget allows |
| Costs higher than expected | Supervisor firing too often | Inspect `audit?limit=100` for spurious `anomaly_detected` events; raise the triggering threshold |

---

## Architecture Reference

For implementers; operators can skip.

```
src/server/lib/supervisor/
├── manager.ts         Singleton lifecycle, tick + semaphore + onLlmCall event hook
├── watchdog.ts        Tier 1 — 6 signal computations, pure given DB+snapshot
├── loop.ts            Tier 2 — stateless single-pass LLM invocation with DI
├── tools.ts           6 tool definitions + handlers (autonomous vs proposal)
├── prompt.ts          System prompt + per-tick user context builder
├── audit.ts           supervisor_audit CRUD helpers
├── notes.ts           supervisor_notes UPSERT helpers
├── proposals.ts       supervisor_proposals CRUD + status transitions
└── config.ts          preferences-backed config loader + defaults

src/server/routes/supervisor.ts   9 REST endpoints under /api/supervisor

src/frontend/src/components/
├── SupervisorPanel.tsx           Overlay (Configuration + Status + Pending + Activity)
├── SupervisorBadge.tsx           Pending-proposal indicator in ProfileView
├── SupervisorOverlayContext.tsx  Open() callback for any component to open the overlay
└── ui/overlay.tsx                Shared overlay wrapper (used by Settings + Wizard + Supervisor)
```

Data flow:

```
sub-agent log entry inserted (db.addLogEntry)
       │
       │ if type='llm_call', synchronous hook fires
       ▼
SupervisorManager.onLlmCall(profileId)
       │ computes signals; if cost_spike, enqueues
       │
   OR  │
       │
SupervisorManager.tick()  (every tickIntervalSeconds)
       │ for each active profile: compute signals; if anyFired, enqueue
       ▼
SupervisorManager.enqueue(profileId, signals)
       │ checks per-profile inflight + global semaphore
       │ writes 'anomaly_detected' audit
       ▼
runSupervisorTurn(profileId, signals, deps)
       │ writes 'llm_call' audit
       │ buildSystemPrompt + buildUserContext (notes + logs + state + proposals)
       │ complete(opus, context, supervisorTools)
       │ for each toolCall in response:
       │    executeSupervisorTool(call, profileId, manager)
       │      ├─ send_nudge:  agentManager.nudge() + audit + sub-agent log
       │      ├─ propose_*:    createProposal() + audit
       │      ├─ update_notes: upsertNotes() + audit
       │      └─ do_nothing:   audit only
       ▼
User opens Supervisor overlay, sees pending proposal, clicks Apply
       │
       ▼
POST /api/supervisor/proposals/:id/apply
       │ verifies pending + agent connected
       │ dispatches based on action:
       │    set_directive → updateProfile + agentManager.restartTurn
       │    pause         → agentManager.pauseLLM
       │    resume        → agentManager.resumeLLM
       │ setProposalStatus('applied') + audit + sub-agent log
       ▼
Sub-agent reacts to the new directive / pause state on next turn
```
