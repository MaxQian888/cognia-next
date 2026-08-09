---
title: ADR-0066 — Agent-Team task board & cross-surface integration (CQRS)
description: "Gives the Agent-Team task model its kanban surface and de-silos it across the app: a guarded drag board in the workspace, a one-way Dexie projection (v104) that carries the board to mobile over the companion sync pipeline, control-plane RPCs for phone-side edits, a ctx.team plugin API with team:read/team:write, twin-binding visibility, and a shared completion-linkage core."
---

# ADR-0066 — Agent-Team task board & cross-surface integration (CQRS)

**Status**: Accepted (2026-07-08)
**Authors**: Max Qian + Claude Fable 5
**Builds on**: the team runtime (ADR-0022), the plugin integration (ADR-0032), the mobile sync orchestrator (ADR-0027), the Companion control plane (ADR-0061), and the twin runtime glue (`lib/ai/agent/team/twin-context.ts`, ADR-0003).

## Context

`AgentTeamTask` was always board-shaped — 8 statuses (`pending → blocked → claimed →
in_progress → review → completed | failed | cancelled`), `assignedTo`/`claimedBy`,
`dependencies`, an explicit `order`, comments and attachments — but the only surface
was a flat card grid, and the model was siloed: plugins could not see the team store
(no `ctx.team`, in contrast to the mature `ctx.goals`), the three workspace extension
points were read-only, and the mobile workspace read the **phone's own** empty
localStorage store, so a desktop-authored team was invisible on a paired phone.
ADR-0022 had also deferred manual retry and pause/resume ("v2"), and declared
"no new Dexie tables" for team runs.

## Decision

### 1. One guard, every surface

`lib/ai/agent/team/task-move-guard.ts:canMoveTask(task, from, to, teamStatus)` is the
single source of truth for human-owned transitions, consumed by the desktop drag
board, the mobile action sheet, the companion RPCs, and the plugin API:

- same-column reorder: always allowed (`order` renumbering via `reorderColumn`);
- `pending → cancelled`, `review → completed | failed` (human verdict),
  `failed → pending` (**manual retry** — closes the ADR-0022 deferral);
- `blocked` is dependency-derived and read-only in both directions;
- `claimed` / `in_progress` are runtime-owned while a run is active
  (`planning`/`executing`); at rest they may be pushed back to `pending`.

The store actions `moveTask` / `reorderTask` apply the guard plus side effects
(claim release + timestamp resets on `→ pending`, completion stamps on terminal).
On the board, illegal drop targets grey out at drag start
(`allowedMoveTargets` → dnd-kit `useDroppable.disabled`).

### 2. Board UI

The workspace tasks tab gains a persisted list/board toggle
(`components/agent/workspace/board/`). All decision logic lives in the pure
`lib/ai/agent/team/board-model.ts` (columns, per-teammate swimlanes,
tag/priority/assignee filters, WIP hint vs `maxConcurrentTeammates`,
dependency-lock badges, and the `resolveDrop` reducer); components are thin
shells. Swimlane mode is a read view — dragging across lanes would imply
reassignment, which the board deliberately does not do. Two new canonical
extension points ship with their mounts: `agent.team.task.actions` (card ⋯ menu)
and `agent.team.board.toolbar`; `agent.team.panel`'s context bag is enriched
with roster/task aggregates.

### 3. Team-board CQRS: state down, commands up

The Zustand agent-team-store stays the **single write source** (ADR-0022's stance
on runtime state is unchanged). Cross-device visibility is a **one-way projection**:

- **Dexie v104 `agentTeamBoard`** (`lib/db/agent-team-board.ts`): task rows
  (id = taskId) + one team-meta row per team (`team:<teamId>`, carrying status,
  capacity, roster incl. twin bindings, `knowledgeTwinIds`). Epoch-ms timestamps,
  capped comment threads, truncated result/error previews.
- **Desktop-only projector** (`lib/db/agent-team-projection.ts`): a store
  subscription identity-diffs `tasks`/`teams`/`teammates`, coalesces to a
  microtask flush, `bulkPut`s changes, and pairs deletions with sync tombstones;
  a full reconcile on install prunes orphans. Installed by the desktop
  sync-source provider and the headless brain runtime — never on the phone,
  whose empty store would wipe the mirror.
- **Sync**: `agentTeamBoard` joins `SyncableTable`, the desktop delta reader
  (cursors `updatedAt`), the handler registry, and the Rust `sync_registry`
  (tombstoned). Dexie never writes back to the store.
- **Control plane**: six Companion-control-gated RPCs (`team_task_move|create|comment`,
  `team_run_pause|resume|stop`) travel the generic desktop-writes bridge. The TS
  arms (`lib/companion/agent-team-write-handlers.ts`) revalidate through the live
  `canMoveTask`, answering `{ ok, reason }` — a stale phone snapshot can never
  push a move the desktop board would refuse. They are deliberately **not** in the
  mobile offline queue: a command must validate against live run state, not replay
  hours later. `team_run_resume` acks fire-and-forget (the lifecycle runs long).
- **Mobile board** (`components/mobile/agent-teams/team-board-mobile.tsx`): renders
  the mirror via liveQuery (works offline on the last-synced snapshot), moves via
  an action sheet whose targets come from the same guard, comments via RPC. The
  mobile workspace falls back to this board when the local store is empty but a
  synced meta row exists — fixing the desktop-invisible bug.

### 4. Pause / resume (closes the second ADR-0022 deferral)

`agentTeamManager.pause` existed (abort + mark `paused`); `resume` now re-enters
the lifecycle: stranded `claimed`/`in_progress` tasks reset to `pending` (claims
released), stuck teammates reset, the blackboard is re-seeded from persisted
`task.result` (shared memory is in-memory only — a restart would otherwise starve
dependent tasks; `autoPublishTaskResult` re-applies the PII gate), and
`RunTeamLifecycleDeps.taskFilter` drops done work — filtered ids thread into
`synthesizeTeamWorkflow` as `satisfiedDependencyIds` so surviving dependents
synthesize cleanly. `review` tasks are never auto-resumed (they await the board
verdict). Relatedly, the wave path (adaptive re-plan / progress ledger) now
re-opens its reused run row between waves — the ADR-0061 P4 ownership guard
("terminal rows are never resurrected") silently skipped every wave after the
first; companion soft-cancel (a `cancelled` row) is still honored.

### 5. Plugin + twin de-siloing

- **`ctx.team`** (`lib/plugin/api/team-api.ts`, modeled on `goal-api.ts`): reads +
  `subscribe` behind `team:read`; `createTask`/`addComment`/`moveTask`-through-guard
  behind `team:write` (non-dangerous tier, like `goal:write`). **No run control**
  for plugins — starting a team consumes real compute and stays a human /
  Companion control-plane decision.
- **Twin visibility**: the deep runtime integration (per-teammate twin injection,
  `twin_knowledge_search`) was invisible in the UI. The board now shows twin badges
  on swimlanes/cards, a knowledge-twins chip row, and ranks the create-form
  assignee picker by naive token overlap with each bound twin's expertise blurb
  (`twin-expertise-hints.ts` — pure, zero LLM calls, zero new data flows).
- **Completion-linkage dedup**: the goal and team completion fan-outs share
  `lib/runtime/completion-linkage-core.ts` (lazy runtime load, per-match isolation,
  `gateModelText` PII red-line). Goal↔team task-model unification remains an
  explicit **non-goal**.

## Consequences

- The board's guard semantics are enforced in exactly one function; UI, RPC, and
  plugin surfaces cannot drift apart.
- ADR-0022's "no new Dexie tables **for team runs**" stands; `agentTeamBoard` is a
  read mirror with a single writer, not a second source of truth — divergence is
  structurally impossible (the projector always projects the store).
- The phone can watch and steer a desktop team, but never becomes a second writer;
  conflict semantics were avoided by construction, not resolved.
- Plugins can feed external work (issue trackers) onto the board and react to it,
  within task-level bounds.

## Non-goals

Cross-team portfolio boards, a cloud team runtime, drag-reassignment across
swimlanes, plugin-controlled runs, and goal↔team task-model unification.
