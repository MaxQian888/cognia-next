---
title: "0204 — A project coordinator runs threads in the background"
description: "A workspace can enable project coordination. One long-lived coordinator conversation delegates work to background thread conversations. Each thread uses its own worktree and branch within a git root, reports when its turn ends, and appears with its pull requests on a threads board. Coordinator and thread are roles on ordinary direct sessions. Background holds allow sessions to run without a pane. Reports use lifecycle-linked peer messages. PR watching extends the Agent Team observer. The project has its own budget, usage tab, pause, notification rule and settings."
---

# ADR 0204 — A project coordinator runs threads in the background

**Status:** Accepted
**Date:** 2026-09-29
**Related:** [ADR-0144](./0144-workspace-as-the-unit-of-work) (the workspace), [ADR-0022](./0022-agent-team-runtime-hardening) (PR feedback loop), [ADR-0042](./0042-unified-notification-center) (notifications), [ADR-0188](./0188-a-routed-turn-spends-only-what-its-ledger-reserved) (spend), [ADR-0059](./0059-cloud-deployment-headless-brain) and [ADR-0182](./0182-a-project-names-the-image-it-runs-in) (where cloud execution would come from)

## Context

Claude Code's Projects make one long-running conversation the coordinator of a
body of work. The coordinator splits the work into parallel threads, each
thread works on its own branch and reports back, an overview shows every
thread's state and pull request, and the project carries its own instructions,
goal, memory and usage.

Cognia already had most of the parts:

- the workspace (ADR-0144) with instructions, roots, environments, schedules
  and memory scope;
- managed worktrees and branches from Squad runs;
- `AttachedChildSession`, which lets a child conversation hand a summary back
  to its parent;
- session peer messaging, with a PII gate, dedupe and untrusted-data framing;
- the Agent Team `PrFeedbackController`;
- `sessionUsage.projectId` with a `[projectId+at]` index.

They were not connected, and one gap blocked the rest: **a conversation with
no pane could not run.** Its approvals were auto-denied, peer messages to it
were refused as "target unavailable", and nothing kept its store slice alive.

## Decision

### 1. Roles on direct sessions, not a new session kind

A coordinator and its threads are ordinary `kind: "direct"` sessions marked
with `ChatSession.projectRole` (`"coordinator" | "thread"`). A thread also
carries `projectThread` (its coordinator, brief, root, who proposed it,
resolution, last report, declared state, PR reference). A new `SessionKind`
would have rippled through exposure, export and every kind branch in the chat
controller; a role does not, and a thread stays a conversation a person can
open, read and steer.

The workspace row carries the configuration, `Project.coordinator`: enabled,
the coordinator's session id, goal, where threads run, preferences (soft
concurrency limit, propose-before-start, daily thread cap, auto-fix PRs),
pause, default model and effort for each role, icon, and when the one-off
setup offer was made. Every reader goes through `resolveCoordinatorConfig`, so
an absent or partial config means one thing. One source of truth per setting:
the budget lives in the cost-budget policy and the notification rule in the
notification preferences (§9, §11), never on the row.

`ensureCoordinatorSession` resolves the coordinator by pointer, then by role,
and only then creates one (local, not activated, `rememberChoice: false` so it
does not rewrite the user's defaults). Concurrent callers share one creation.

### 2. A thread is an attached child with its own worktree

`createThreadSession` builds on `createAttachedSession`: the thread's
`attachedChild` names the coordinator as parent and lifecycle owner with an
independent workspace, and its brief is staged as `spawnedTask.pendingPrompt`.
The brief passes the PII gate before anything is created.

Where it runs follows `threadExecution`: `auto` (the default) gives a thread its
own managed worktree and branch when the chosen root is a git repository and
the folder otherwise; `managedWorktree` and `local` force one or the other. A
thread may target any workspace root (`rootId`); the coordinator's status
digest lists the roots when there is more than one.

### 3. Background holds keep a session live without a pane

The chat store gains `backgroundHolds`: `holdInBackground(sessionId, holder)`
keeps a session's slice and makes `isSessionOpen` true; the last release drops
an idle, unkept slice. A hold never takes decision ownership from a real pane.
With that:

- a held session's approvals are no longer auto-denied — they wait in the
  Attention panel, behind a 24-hour backstop for a session held with no pane
  at all;
- the controller projects subagents and drains peer messages for held
  sessions like open ones.

Threads are held while their turn runs; the host holds the coordinator while
any of its threads is active, so a report can wake it.

### 4. Starting a thread goes through the same send

A thread moves `staged → running → completed | interrupted`, recorded on
`attachedChild.status`. `startThread` admits it, marks it running, holds it and
submits the staged brief with `sendChatMessage` — the full-fidelity send a
person's message takes, so the worktree, leases, budget and every send-time
gate apply. While the brief is still present the thread is "started but
undelivered", and the host redelivers it after a reload
(`resumeProjectThreads`); a running thread whose turn died with the previous
process is marked interrupted.

Admission (`admission.ts`) refuses creation when coordination is off, the
project is paused, or the daily cap is reached; starting also checks the soft
concurrency limit, which a person's explicit Start bypasses.

### 5. Reports are peer messages between lifecycle-linked sessions

When a thread's turn ends (`thread-watcher`, a chat-store subscriber), its
result is reported to the coordinator as a session peer message, so it gets the
channel's PII gate, dedupe, capacity, untrusted-data framing and a visible row.
Sessions linked by `lifecycleOwnerSessionId` pass each other's peer hold
(`resolveInboundPolicy`), and a message to a linked receiver that is not
reachable stays queued instead of failing.

Two bounds prevent a report storm: reports within 5 seconds are coalesced into
one message, and past 6 triggered turns per coordinator per hour a report is
delivered as a note (visible, no turn). A paused project's coordinator receives
every report as a note. A stop the user asked for is not reported.

### 6. The coordinator's tools, protocol and per-turn status

Builtin tools follow the existing plugin-tool pattern (manifest with a
hand-written schema, a runner that never throws, one IPC branch, gating in
`resolveSendOptions`): `spawn_thread`, `propose_threads`, `start_thread`,
`message_thread`, `list_threads`, `read_thread_report`, `stop_thread`,
`resolve_thread`, `remember_project_note`, `set_project_preference` for the
coordinator, and `report_to_coordinator` for a thread. All are allowed except
`set_project_preference`, which asks.

Prompt layout keeps the cache stable: the project goal is a PII-gated section
after the workspace instructions; the role protocol is session-stable. The
project status digest (preferences, roots, up to 12 recent threads with state,
branch, PR and last result, capped at 6,000 characters) goes in the dynamic
tail. On a new project's first coordinator turn the tail also carries a one-off
setup offer — an exploration thread per root and the workspace's existing
schedules — asked for as `propose_threads`, and recorded in `setupOfferedAt`.

### 7. The threads board

Board states are derived, never stored: waiting (an approval or a declared
block), ready-for-review, working, staged, landing, idle, resolved, from the
slice status, pending approvals, the thread's declared state and its PR
status. A thread quiet for 7 days is resolved automatically. The board sits in
the workspace overview beside the coordination card; each row is an ordinary
conversation link with start, stop, resolve, reopen and PR actions.

### 8. Thread pull requests reuse the Agent Team observer

`PrFeedbackController` is made generic over its binding (`PrWatchTarget` plus
an `identify` function and `untrack`); the Agent Team keeps its behavior.
`ProjectPrWatch` tracks every live thread with a branch on a github.com
repository, persists observations to a new `sessionPrObservations` table
(schema v233), and mirrors the PR reference onto the thread. When the
project's `autoFixPr` is on, CI failures, requested changes and conflicts are
sent into the thread; otherwise the board shows them. Create PR (draft) and
merge (squash, confirmed) are explicit actions.

### 9. A project budget and usage

The cost-budget policy gains per-project daily and monthly ceilings
(`costBudget.perProjectDailyUsd` / `perProjectMonthlyUsd`), judged against the
sending workspace's own spend read from `sessionUsage[projectId+at]` (local
spend only). Chat turns now stamp `projectId` on their usage rows, which is
what makes that spend exist. The project scope is only evaluated when asked
about, so callers that never name a project are unaffected. The workspace page
gains a Usage tab: the workspace's budget meters, 30-day total and heatmap,
and spend by conversation and by model, all from the shared aggregators.

### 10. Pause

Pausing stops the coordinator's turn and every thread with a turn in flight
(marking it interrupted and dropping its hold) and stops PR watching. What
keeps the project stopped lives where each kind of turn starts: the chat
controller refuses any send into a paused project's coordinator or threads
(`projectPaused` diagnostic), admission refuses thread starts, `sendToThread`
and reload reconciliation skip the project, a scheduled goal run targeting one
of its sessions is refused, and reports arrive as notes. Ordinary
conversations in the same workspace keep running. Resuming delivers the briefs
that were held back. A banner above the composer and in the coordination card
says why and offers Resume.

### 11. Notifications

The session notification watcher follows every live slice — open panes and
held sessions — and notifies when a session the user is not watching
finishes, fails or waits for approval (an approval is `directed`, so it counts
on the badge). Notification preferences gain per-workspace rules
(`perProject`: mute, channels, a stricter OS gate), and `notify` resolves the
workspace before routing when such a rule exists.

### 12. Settings and continuing an existing conversation

The workspace manager gains a written-through Project coordination section:
the goal (held back while it would trip the PII gate), icon, where threads
run, limits, propose-first, auto-fix PRs, the default model and effort per
role, the workspace's spending limit and notification rule, and a link to the
memory page filtered to the workspace (`/memory?workspace=`).

"Continue as project" in the conversation menu turns an idle, unlinked direct
conversation into the first thread of its workspace's project: it is
re-parented under the coordinator as a completed thread (nothing is copied),
and the coordinator's first turn carries the conversation's handoff
projection, PII-gated, and is asked to propose what remains.

## Not adopted, and blockers

- **Cloud-resident threads.** A thread runs where the chat controller runs,
  which is the renderer. Running threads with no device open needs the
  controller's send path on the headless brain (ADR-0059) and an environment
  per thread (ADR-0182). Until then a thread's work pauses with the app, and
  resume redelivers or marks it interrupted.
- **Automatic pushes of work in progress.** A thread's branch is pushed when a
  PR is created from the board. Pushing continuously needs a per-root push
  policy and credentials that do not exist yet.
- **Pausing the whole workspace.** Pause covers project work: the coordinator,
  its threads and goal runs targeting them. Schedules and ordinary
  conversations in the workspace are not paused.

## Consequences

- A session held in the background can hold an approval for up to a day; the
  board, the Attention panel and a notification make that visible.
- Threads accumulate worktrees and branches. Nothing is deleted
  automatically; resolving a thread keeps its branch, transcript and worktree.
- The `sessionPrObservations` table (v233) is added to the data-governance
  catalog.
- Coordination can be turned off at any time; sessions keep their roles and
  behave as plain conversations until it is turned back on.
