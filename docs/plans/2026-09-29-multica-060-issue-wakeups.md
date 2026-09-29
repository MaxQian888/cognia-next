# Multica v0.6.0 refresh — issue wakeups and remaining deltas

Researched 2026-09-29 against upstream `multica-ai/multica` main @
`4736a85d41b966b10ce9f60778cbfc47cecad4cb` (v0.6.0, published 2026-09-28).
Prior snapshots: `2c0912b` (source research, 2026-08-14, `.codex-research/
multica-source-research.md`) and `b904e6b` (gap analysis, 2026-08-12,
`docs/research/multica-cognia-gap-analysis-2026-08-12.md`). Upstream moved
**+755 commits** since then. Every load-bearing claim was verified against
upstream source/docs (GitHub API + raw files) and Cognia HEAD; nothing was
copied from release notes alone. Two re-verification passes corrected the
Phase-0 design toward existing machinery and sharpened the safety model —
see "Corrections".

## Verdict

The August conclusions still hold — the gap is product/contract surface, not
capability. Upstream shipped one genuinely new product axis worth borrowing:
**issue wakeups** — agent-self-service event/condition/timer subscriptions
scoped to an issue that deliver an ordinary run when the input arrives. The
sophisticated part is not the trigger; it is the _run-management contract_
around it: cross-rule loop detection, per-hour rate caps, inputs that join an
in-flight run instead of queueing a second one, and check-ins that settle a
run without advancing the issue.

Cognia's scheduler already implements most of the machinery: event triggers
with `eventSource` filtering, per-task concurrency guards, `maxRuns`/`endAt`
lifecycle bounds, `once→expired` consumption, and timing drivers on all three
hosts. A wakeup is a `ScheduledTask` of a new `issue-wakeup` type whose
executor delegates to `IssueRunRegistry` — the remaining work is the
run-management contract above plus a bridge, not a new subsystem.

Everything else upstream shipped is parity (search index, steer, inbox,
presence), narrower than ours (plugin API surface, collab publish
allowlisting), or deliberately not ours (server-authoritative scoping,
unsandboxed daemon, hosted cloud runtime). License is still restrictive
source-available — **patterns, never code**.

## Implementation status (2026-09-30)

Phase 0 and Phase 1 are implemented; the seam Phase 4 needed for joined runs
landed with them. Where the build departed from the design above, the
departure is deliberate and recorded here.

- **Lives in** `types/issues/wakeup.ts`, `lib/issues/wakeups/{model,service,
gate,executor,bridge}.ts`, `lib/skills/built-in/issues/wakeup-*.ts`,
  `components/issues/wakeups/`, `components/issues/board/wakeup-cue-chip.tsx`.
- **No `TaskTrigger.eventFilter`.** Replaced by a per-type pre-execution
  fire gate (`registerEventFireGate` in `lib/scheduler/task-scheduler.ts`).
  An executor-side filter would have written an execution row and charged
  `maxRuns` for every non-matching event (a children-done rule would spend
  its budget on every child but the last); the gate answers first. Match,
  self-suppression, conditions and "hold for an unjoinable run" live there.
- **One scheduler event, `issue:activity`,** on `eventSource: "issue:<id>"`;
  the trail kind, actor, transition, attributed run and chain ride in the
  data. Children publish `child_status_changed` on the parent's source.
- **Lineage is on the run (`IssueRun.wakeup`), not the task** (Q4 resolved
  the other way): a loop runs through runs, and only the run that caused an
  event knows which rules led to it. A human actor resets the chain.
- **Joined runs** use a new optional `IssueRunAdapter.sessionIds`, which the
  agent-task adapter implements from live attempts; `steerIssueRun` steers
  the newest through the PII-gated `steerSession`. Runs that cannot be
  steered (squad, GitHub loop) get the input **held** on the rule and
  released when the run settles; nothing is dropped.
- **One-shot consumption is executor-controlled**, not `maxRuns: 1`, so a
  held input does not spend a one-shot rule. `maxRuns` is the fire budget.
- **Pause reasons** persist as `status: paused` + `lastTerminalReason:
wakeup-paused-{loop,rate,issue-closed}` (no schema change); the scheduler
  attention model has a `wakeup-paused` signal (the Verify item below).
- **Check-in note** is carried on the `run_checked_in` trail entry rather
  than a second `commented` entry. The skill is `write`-tier, so in an
  unattended run it meets the session's write-approval posture exactly as
  `issue.comment` does.
- **Wakeups are not a `schedule.create` type**; they have their own skills
  (`issue.wakeup_{create,list,set_enabled,delete,checkin}`) that still pass
  `authorizeTaskWrite`.
- **Phase 1 stages** (upstream re-fetched): `Issue.stage` (1–1000, local
  only, no Dexie bump — not indexed) with `setIssueStage` / `stage_changed`
  and a derived `child_stage_changed`. The gate fires a children-done rule
  only when the sub-issue barrier ADVANCES (`childrenBarrier` /
  `barrierAdvanced` in `model.ts`): the platform rule hands off stage by
  stage and ends with `all` (which also waits for unstaged children); an
  author's `stage: N` rule waits for stages ≤ N. Reopen + re-finish fires
  again. The reached barrier rides into the brief.
- **Phase 2 triage is an attribute, not a column** (departure): upstream
  models it as `triage_state`, and a seventh status would ripple through
  every category projection and the collab server enum for nothing.
  `Issue.triage = "pending"`, `setIssueTriage` / `triage_changed`, the
  `issue-in-triage` refusal for non-`interactive` origins
  (`isNamedRunOrigin`; `trackerVerdict` now takes the origin). Wakeups
  hold inputs while triage refuses and release them on accept. GitHub
  import opt-in: `GithubRepoSyncSettings.triageNewIssues`. ADR-0132 §1
  amended.
- **`until-pr` (Q2 resolved)**: `github-pr` refs now carry
  `meta.prState` (open/closed/merged), recorded by the import sweep on
  every issue carrying the link (`recordIssuePullRequestState`,
  `pr_state_changed`); settled runs link the PRs they opened
  (`linkRunPullRequests`). Condition `pr-merged`; the service refuses it
  on a container without an import-mode GitHub binding. Latency = the sync
  interval.
- **Phase 3**: `issue.link_artifact` (write; resolves the caller's run by
  session, like check-in), `IssueRunArtifact.{artifactId,sessionId,
deliverable,linkedAt}`, `lib/issues/deliverables.ts` (label-keyed
  versions), inspector Deliverables section previewing through the
  existing `ArtifactPreview`, run history strip, consecutive `run_failed`
  collapse (`lib/issues/activity-feed.ts`, both inspectors). No new
  CSV/JSON/YAML renderers were added: deliverables render through the
  artifact surface's own previews.
- **Stage and triage on every programmatic face** (2026-09-30): `ctx.issues`,
  the `action.issue.create/update` nodes, the External Bridge
  (`issues_create` / `issues_update`) and a paired phone's
  `issue_apply_action` / `issue_create` (wire schema widened; the host
  enforces the phone's own `REMOTE_ISSUE_ACTION_KINDS`, pinned against the
  schema). The External Bridge may send an issue into triage but is refused
  accepting one out: an external agent granting the acceptance the gate
  waits for would defeat it. The mobile inspector reuses `IssueTriageRow`
  and gets a commit-on-blur stage box; the create page takes a stage once a
  parent is picked.
- **Phase 4**: `IssueRunSteer` in the detail panel's run section steers the
  active run through `steerIssueRun`, the same path joined wakeups use: no
  third steer path. A run whose adapter reports no live session says its
  engine takes no input instead of offering a send it would refuse.
- **Verify results** (2026-09-30): (1) the IM permission ceiling never
  gated run start, it only narrows tools; shared sessions were already
  refused, but an issue card's Move/Run ran for anyone in the chat. Clicks
  now answer to the sender half of the trigger policy
  (`senderTriggerRefusal`, ADR-0132). (2) Notification Center history was
  bounded (count + age + coalescing, pruned on every write), but the
  in-memory feed kept pruned rows until reload; it now evicts them.
  (3) Paused-reason display was already covered.
- **Backlog hold** (2026-09-30): the platform children-done rule holds
  its hand-off in the fire gate while the parent sits in `backlog`, each
  stage that finishes meanwhile is held with the barrier it reached, and
  the parent is woken once, with all of them, when it leaves backlog. An
  author's children-done rule is not held.
- **Instruction fallback** (2026-09-30): the parent's own override
  (`IssueWakeupPayload.instructionOverride`, edited in the issue's
  wakeups section) → the CONTAINER's default
  (`IssueProject.childrenDoneInstruction`, project inspector and
  `issue.update_project`) → the built-in text, resolved when the rule
  fires. Departure: upstream's middle layer is the workspace; here it is
  the container, because the container already has the tracker's settings
  surface and the workspace has none.
- **Expiry and `on-timeout`** (2026-09-30): event tasks never honoured
  `endAt` — only timer paths checked it, so an event rule fired past its
  deadline and never expired while idle. The scheduler now arms a bounded
  event task for its `endAt`, refuses (expires) an event that reaches it
  late, and calls a per-type `registerTaskExpiryHandler`. A wakeup with
  `onTimeout: "wake"` (needs `expiresAt`) runs once more through
  `runTaskNow` with a timeout flag: the brief says the wait ran out, the
  trail's `wakeup_fired` carries `timedOut`, it is not charged to the rate
  cap, and what an expired rule could not deliver lands on the trail rather
  than being held forever. The dialog offers deadline presets.
- **`until-pr` `checks`** (2026-09-30): the import sweep now also reads
  the head commit's CI of each open linked pull request (check runs, up to
  three pages, plus commit statuses, rolled up by the Agent Team
  observer's `summarizeCi`; a read cut short never reports passing). It
  lands on the ref as `meta.ciState` (pending/passing/failing) through
  `recordIssuePullRequestChecks`, which appends `pr_checks_changed` once
  per change. Condition `pr-checks` (optional `result`) fires when the
  trail says the checks settled and an OPEN linked pull request's ref
  agrees; a merged or closed one's last CI is history. Same binding
  requirement and latency as `pr-merged`. Deliberately not the observer's
  own fetch: that one is ETag-cached per observation and also reads
  reviews and comments. Per-sweep CI reads are capped
  (`pullRequestCiLimit`, 10).
- **Not built:** Phases 5 and 6 (gated on demand by this plan). Checked
  2026-09-30: no multi-host or third-party-plugin use case yet, so the plan
  closes here; reopen either phase when one appears.

## Delta since the August snapshots

Upstream between `2c0912b`/`b904e6b` and `4736a85`:

- **Issue wakeup v2** (`docs/engineering/issue-wakeups.md`,
  `server/internal/daemon/wakeup.go`, `packages/core/issues/wakeups.ts`,
  ~20 `packages/views/issues/components/wakeup-*` files, e2e spec). An
  agent or member saves a subscription on an issue; on input it gets an
  ordinary run carrying `context.wakeup_id` + bounded `wakeup_evidence`.
  - **Triggers**: 25 event types (run lifecycle, issue fields, comments,
    reactions, attachments), timers (`at`/`every`/`cron` + timezone +
    `expires-in` + `on-timeout wake|drop`), and structured `condition`
    predicates (`until-status`, `until-pr` reads stored PR snapshot,
    `until-children-done` with `--stage`, `until-issue STATE`).
    Actor filters (member/agent) and run/agent source filters.
  - **Runaway protection, three layers** — the part easy to under-build:
    `max_fires` (default 20, 1–1000) → `paused_reason=max_fires`; a run
    stores `wakeup_chain` (the rules that led to it) and a rule revisited
    twice in one chain without a person between → `paused_reason=loop`;
    an event rule that started 12 runs in the past hour →
    `paused_reason=rate`. All also set `disabled_at` so queued runs are
    refused at claim. `GET /api/issue-wakeup-paused` feeds board cues.
  - **Joined runs**: if the wakeup's run is still pending/active when a
    new input lands, inputs merge — the run's `wakeup_chain` accumulates
    and `context.wakeup_joined` renders as a `[WAKEUP — joined this run]`
    block; a `once` rule whose input merged counts as fired.
  - **Check-ins**: `POST .../checkin` is accepted _only from the running
    task the rule started_ and only for every/cron rules — settles with a
    ≤500-char note without a delivery verdict.
  - **Self-suppression**: mutations and run events from a wakeup's own run
    never retrigger it. Terminal-category issues disable all wakeups;
    reopening does not re-enable; invoke rights re-checked at claim.
  - **System wakeups**: platform-owned rules (`agent_id`/`created_by`
    NULL). `child_done` makes a parent wait on its sub-issues — at fire
    time the target resolves by assignee kind (agent → run, squad leader
    → leader run, member → inbox notification, nobody → timeline only);
    instruction falls back issue → workspace → built-in default.
  - Authoring: `multica issue wakeup` CLI (agent-facing); UI: sidebar
    section, board cues, Autopilot `?tab=wakeups` workspace inventory.
- **Triage status + server-side guard** (`server/internal/service/
task_triage_guard.go`, migrations 476/477/483). Triage is a routing
  state with no executor; derived runs (inferred assignees, retries) are
  blocked from enqueuing while explicitly named runs proceed.
- **Deliverables + dynamic blocks** (`packages/core/attachments/
deliverables.ts`, `acp_deliverable.go`): comment uploads grouped into
  versions by normalized filename+type; viewers for CSV, JSON/YAML, code,
  HTML, Mermaid, images; runs on an issue timeline.
- **Live steer**: per-recipient composer steering of running agents,
  provider-specific handling, stale-instance cleanup.
- **Plugin platform** (`packages/plugin-sdk/`, `examples/plugins/
deploy-sentinel`): sandboxed iframe surfaces (no same-origin, no
  ambient storage, `multica.storage` mediated), MessagePort-bound bridge
  v2, `net:` network scopes, theme tokens, workspace/member-scoped
  storage, immutable published versions, hook + MCP transports, MCP
  schema-digest pinning at approval.
- **Local search index** (`packages/core/search-index/`); **multi-replica
  groundwork** (Redis relay, `*_redis_store.go`, MUL-1138 server side);
  **presence channel**; **`cloudruntime` client** to a hosted control
  plane (SaaS direction); provider matrix ~25; Telegram as 6th channel;
  Windows installer; fr UI + 5-language docs.

## Verified facts — Cognia side (HEAD)

- **Fact substrate is richer than upstream's**: `issueEvents` (append-only
  Dexie) records ~20 kinds (`status_changed`, `reassigned`, `assigned`,
  `label_*`, `priority_changed`, `due_date_changed`, `estimate_changed`,
  `description_changed`, `parent_changed`, `project_changed`,
  `cycle_changed`, `blocker_*`, `commented`, `external_linked`,
  `github_linked`, `run_*`, `artifact_linked`), fanned out by
  `lib/issues/event-bus.ts` `onIssueEvent(handler, {kinds, issueId})`.
- **The scheduler is most of a wakeup engine already**:
  - `TaskTrigger`: `event` + `eventSource` + `dependsOn` + `jitterMs`
    (`types/scheduler/index.ts:549`);
  - `triggerEventTask` eventSource match + `payload.event` merge
    (`task-scheduler.ts:3152`); `getActiveEventTasks` uses the
    `[status+eventType]` index (`scheduler-db.ts:338`);
  - `runningByTask` per-task guard + `concurrency-limit.ts` global cap;
  - `maxRuns` / `endAt` / `expireTask` = upstream `max_fires`-ish /
    `expires-in`; `once` settles to `expired`;
  - `getTaskExecutions(depTaskId, 1)` — execution-history queries needed
    for a per-hour rate cap already exist;
  - timing drivers for renderer/node/rust-daemon — wakeups fire on
    desktop **and** headless brain, matching upstream's daemon;
  - `upcoming-occurrences` + `types/scheduler/unified.ts` +
    `lib/scheduler/sources/` give a new task type dashboard/calendar
    surfaces for free.
- **Delivery adapter exists**: `IssueRunRegistry.startIssueRun`
  (refuse-or-dispatch, shared by Run button / IM card / reconciler),
  `lib/db/issue-runs.ts` (run rows, `run_*`/`artifact_linked` events,
  `hasActiveIssueRun`, settle-once). `IssueRunOrigin` = `"interactive" |
"im"` today — wakeup adds a third.
- **Settle semantics to extend**: `settleIssueRunAndIssue` always advances
  the issue — `in_review` on settle, `todo` on cancel (registry.ts:247).
  A periodic check-in must settle _without_ advancing; see Phase 0.
- **Authoring + check-in note**: `schedule.create` (HITL confirm +
  `SchedulerPermissionPolicy`); `lib/skills/built-in/issues/` already has
  `run`, `cancel-run`, `comment`, `update` — no artifact-linking skill.
- **Steer exists**: queued-follow-up steer in `lib/chat/` +
  `lib/connectors/live-steer.ts` — the exact channel upstream's "joined
  run" merge wants (a live input lands _inside_ the running agent, not in
  a queued second run).
- **Remote execution lane is real, but narrow**: `lib/ai/agent/external/
runtimes/remote/{remote-execute,remote-run-service,remote-host-configs,
a2a-client}.ts` — host-owned config plane: browser asks, host admits
  (`admitExternalAgentRun`, leased revision), executes via
  `ExternalAgentManager.execute`, streams back over the companion
  `EventBus`. General cross-host AgentTeam/issue-run dispatch is still
  unwired (`hostRef` appears only in `agent-team-bridge.ts` +
  `squad-review-decision.ts` team_recovery plumbing).
- **Collab plane exists and is stricter than upstream's broadcast**:
  `lib/collab/publish.ts` enforces allowlisted projections ("execution
  params, prompts, tool inputs, paths, runtime ids never cross this
  boundary"); `session-permissions.ts` has role→action sets including
  `session.startRun` / `session.steer` / `run.approveOrdinary`;
  `device-presence-registry.ts` covers presence. Inbound connector turns
  carry `buildImPermissionCeiling` (`lib/connectors/runtime.ts:1266`).
- **Search exists**: `lib/global-search/` engine + providers.
  **Artifact renderers exist**: `components/artifacts/
artifact-renderers.tsx` (Mermaid/Code/Markdown/Chart + plugin
  renderer-registry). Issue comments take **no attachments** — upstream
  deliverables group comment uploads; our scope is `IssueRun.artifacts`.
- **Plugins already contribute skills** (`capabilities:["skills"]` +
  `skills:[...]` manifest entries in 10+ in-tree plugins), matching
  upstream's plugin-skill resources.
- **No triage column**: `ISSUE_STATUSES` fixed by design (ADR-0132) with
  `IssueStatusCategory` as the projection anchor.

## Corrections from re-verification

1. **A dedicated `issueWakeups` table + own dispatcher is wrong.** The
   scheduler already does `eventSource` filtering, indexed matching,
   concurrency guards, lifecycle bounds, three-host timers, authoring
   skills, dashboard projection. A wakeup is a `ScheduledTask`.
2. **Check-in is not "just a comment".** The _note_ is `issue.comment`,
   but the _settle_ is new: upstream check-ins settle the run without a
   delivery verdict and without advancing the issue — our
   `settleIssueRunAndIssue` always promotes to `in_review`, so a check-in
   settle mode is required. Call-site restriction ("only from the running
   task the rule started, only every/cron") must also be enforced.
3. **The scheduler alone does not stop cross-rule loops.** `runningByTask`
   guards one task; wakeup A → run → `commented` → wakeup B → run →
   `commented` → wakeup A chains across rules. Upstream's `wakeup_chain`
   (revisit-twice → `paused_reason=loop`), `max_fires`, and the 12/h rate
   cap have no existing equivalent — they are Phase-0 build items, not
   reuse.
4. **Skipping a fire while a run is active drops the input.** Upstream
   merges it into the in-flight run (`wakeup_joined`). Cognia can do
   better than upstream here: inject the event as a _steer message_ into
   the live run via the existing steer path — the agent sees it now, not
   at the next dispatch.

## Phases

### Phase 0 — issue wakeups as a scheduled-task type

Owner: `lib/issues/` + `lib/scheduler/`. New task type + executor + bridge

- trigger field; everything else is wiring.

* **New `ScheduledTaskType` `"issue-wakeup"`**, payload
  `{ issueId, projectId, instruction, agentId?, wakeupRunId?,
wakeupChain?: string[] }`. Register in `TASK_TYPE_HOST_REQUIREMENTS`,
  executors index, `AGENT_SCHEDULABLE_TASK_TYPES`. Payload rides the task
  JSON blob — no Dexie bump (same as `notification.imTarget`).
* **Event bridge** in `lib/issues/boot.ts` (the host-neutral installer both
  desktop and cloud brain already boot): `onIssueEvent` →
  `emitSchedulerEvent("issue:<kind>", {issueId, ...payload}, "issue:<id>")`.
  Add `issue:*` types to `SchedulerEventType`. Facts land in
  `payload.event` — our `wakeup_evidence`.
* **`eventFilter` on `TaskTrigger`** (additive JSON field):
  `{ actorKind?, actorId?, runId?, kinds? }`, evaluated in
  `triggerEventTask` beside the `eventSource` check. Self-suppression
  lives here: skip when `data.runId === task.payload.wakeupRunId` or the
  event's `by` is the wakeup's own active run.
* **`issue-wakeup-executor.ts`**: re-read task + issue fresh; terminal
  `statusCategoryOf` → pause task (upstream: reopen does not re-enable —
  `paused` maps exactly); evaluate the condition predicate; then
  `startIssueRun` with `origin: "wakeup"`, instruction as the handoff
  note; write `wakeupRunId` back onto the task row.
* **Timers** = plain `cron`/`interval`/`once` triggers; `maxRuns: 1` for
  event one-shots; `endAt` for `expires-in`; missed-tick coalescing from
  `catchup-policy.ts`.
* **Runaway protection (build, per Correction 3)**: `wakeupChain` on the
  payload appends the firing task's id at each hop (executor writes it;
  spawned runs carry it); a task already on the chain twice → pause with
  reason `loop`. Rate cap: count this task's executions in the last hour
  via `getTaskExecutions` — pause with `rate` over threshold. `maxRuns`
  covers `max_fires`. Persist the pause reason on the task row for board
  cues (upstream's `issue-wakeup-paused` inventory).
* **Joined runs (per Correction 4)**: when `hasActiveIssueRun` for the
  issue, do not drop the input — deliver `payload.event` into the active
  run as a steer message through the existing steer path, and record it
  in the run's trail (`wakeup_joined` analogue). Fallback when steering
  is unavailable for that adapter: mark the fire consumed only if it
  merged, else skip (do not silently lose the fact).
* **Check-in (per Correction 2)**: extend `SettleIssueRunInput` with
  `{ status: "succeeded", mode: "checkin", note }` — settle the run,
  append a `checkin` trail event, do NOT call `applyRuntimeIssueStatus`.
  Accept check-in only from the run this task started (validate
  `wakeupRunId`) and only on `every`/`cron` triggers. The note lands via
  the existing `commented` write path.
* **Conditions**: compile to watched event types + executor predicate —
  `until-status` → `issue:status_changed`; `until-children-done` →
  children terminal via `statusCategoryOf` + `lib/issues/relations`;
  `until-issue-done` → `issue:status_changed` on the target; `until-pr`
  → predicate over the linked-PR snapshot (Q2).
* **Cascade**: `deleteIssue` (`lib/db/issues.ts:537`) → delete wakeup
  tasks by `payload.issueId`; same for project fan-out.
* **Skills**: `wakeup.{create,list,disable,delete,checkin}` under
  `lib/skills/built-in/issues/` reusing `resolveTaskWrite` +
  `buildConfirmSurface`.
* **UI**: `wakeups` section in `issue-detail-panel.tsx` (pattern after
  `IssuePlanningSection`) + board cue (enabled count / next fire /
  "waiting for event" / paused-reason). No separate dashboard — wakeup
  tasks surface in the unified schedule list via `lib/scheduler/sources/`
  - `run-mappers.ts`.
* Tests (Rule 3): bridge→match→execute, condition predicates,
  terminal-disable, `run-active` steer-join, self-suppression, chain/rate
  pause, check-in settle-without-advance, cascade delete, `maxRuns`.

### Phase 1 — system wakeup: parent waits for children

Owner: `lib/issues/`. Upstream's `child_done` system rule, minus the
workspace-instruction fallback chain (keep just issue-level + built-in
default — Cognia has no workspace settings bag for this yet; add it only
if asked).

- A platform-owned wakeup template created on first `parent_changed` /
  child link: watches children, fires when all reach terminal category.
- Target resolution at fire time (upstream's split): agent assignee →
  `startIssueRun`; human assignee → notification via existing
  `lib/issues/notify.ts`; no assignee → trail event only.
- `--stage` equivalent = optional stage scoping on the rule config.
- Skip chain detection (upstream exempts it — stage hand-offs cross
  issues by design); keep the hourly rate cap.

### Phase 2 — triage column + run guard

- Add `"triage"` to `ISSUE_STATUSES` (category `unstarted`); update
  ADR-0132 in the same PR — "fixed by design" becomes a justified
  exception; audit `board-model.ts` / `board-keyboard.ts` /
  `filter-chips.ts` column assumptions.
- New `IssueRunRefusalReason` `"issue-in-triage"`: derived origins
  (`"im"`, `"wakeup"`, retries) refuse in triage; explicit
  `"interactive"` assignee-picked runs proceed.
- GitHub sync opt-in: open+unassigned → `triage`; default stays `backlog`.

### Phase 3 — deliverables + agent artifact linking

- **`issue.link-artifact` skill** (precondition — agents cannot attach
  artifacts mid-run today; only adapters do at settle). Wraps
  `linkIssueRunArtifact` with the run's own `wakeupRunId`/issue-run id;
  idempotent per href for free.
- `lib/issues/deliverables.ts`: group `IssueRun.artifacts` by normalized
  label/basename → versions, latest-first.
- Detail-panel "Deliverables" section reusing
  `components/artifacts/artifact-renderers.tsx` + renderer-registry.
  CSV/JSON/YAML table+raw views are the likely missing renderers —
  add them to the artifact renderer set, not the issue surface.
- Run timeline strip over the existing `listIssueRuns` live query;
  dedupe consecutive `run_failed` trail entries (upstream MUL-7758).

### Phase 4 — uniform steer entry point

Extend `lib/connectors/live-steer.ts`'s coordinator (or expose the chat
steer path) so an issue run's detail surface can steer its underlying
agent-task/team execution. One seam read first; do not build a third
steer path. Phase 0's joined-run delivery rides whichever path survives.

### Phase 5 — cross-host issue/team dispatch (the old P0, narrowed)

The Aug gap-analysis P0 was "ExecutionBroker cross-host dispatch, built
but dormant". Status now: the **remote lane exists for external agents**
(`remote-run-service.ts` — admission stamp → `ExternalAgentManager.
execute` → companion `EventBus` replay subscription), but not for
AgentTeam/issue runs (`hostRef` only in team_recovery plumbing). The work
is extending that proven seam — host-owned admission + execute + replayed
event stream — to issue-wakeup and team dispatch. This remains the
largest strategic delta vs upstream's daemon-claim model; keep it gated
on a real multi-host use case.

### Phase 6 — third-party plugin lane (gated on demand)

Only when plugins come from outside this repo: sandboxed iframe surface
mode (MessagePort-bound bridge, host-mediated storage, `net:`-style
connect-src scopes), immutable published versions + workspace pinning +
consent screen over the existing `permissions` manifest array, MCP schema
digest pinned at approval.

## Explicitly rejected

- **A separate `issueWakeups` table / dispatcher / timer loop** —
  scheduler owns all of it (Correction 1).
- **Comment attachments** — built only to feed deliverables; out of scope.
- **Any code reuse** — restrictive source-available license (hosted
  service / commercial embedding / branding restrictions). Semantics only;
  legal review before anything stronger.
- Server-authoritative rewrite, Postgres, Redis relay, `cloudruntime` —
  local-first stands; our collab allowlist (`publish.ts`) is already
  stricter than their workspace broadcast.
- Unsandboxed daemon posture — unchanged upstream; do not regress.
- Provider-matrix chasing, Telegram connector, 5-language docs, Windows
  installer — distribution, not architecture.
- A second search stack or presence channel — both exist.
- Cross-workspace/external-event wakeups — upstream defers them too;
  v1 stays issue-scoped.

## Verify (claimed-recently-checked items worth a test)

- Inbound connector turns from collab members: `session.startRun` /
  `buildImPermissionCeiling` actually gates run start, not just tool
  permissions (upstream MUL-7710 made this a product rule — confirm ours).
- Notification retention/coalescing bounds in the Notification Center
  (upstream bounded theirs); check for unbounded growth.
- `paused_reason` display: confirm a paused `issue-wakeup` task renders
  its reason in the scheduler UI rather than a generic paused badge.

## Risks and open questions

- Q1: wakeup `agentId` in payload vs issue assignee fallback — leaning
  explicit-with-fallback (keeps the triage named-vs-derived rule clean).
- Q2: `until-pr` needs the issue-linked PR snapshot source —
  `pr-feedback/derive-status.ts` serves team runs; confirm whether
  `github-issue-loop` maintains per-issue PR state or a minimal
  `issue:pr_state` emitter goes on top of `pr-observe` polling.
- Q3: event bursts → execution-row noise. `runningByTask` + steer-join
  bound the damage, but a label burst still writes rows. If noisy,
  debounce in the bridge, not the scheduler.
- Q4: `wakeupChain` lives on the task payload (self-describing) vs on the
  IssueRun row (queryable per-run). Leaning payload — the chain belongs
  to the rule's lineage, and payload JSON needs no index.
- Q5 (Phase 2): ADR-0132 amendment for triage ships in the same PR.
- Q6 (Phase 5): the remote seam is external-agent-shaped today; general
  team runs need their own admission/persistence contract — scope it as
  a design doc before code.
- Upstream pins: paths at `4736a85`; wakeup internals still receive
  commits (actor filters in migrations 531–532 days ago) — re-fetch
  `docs/engineering/issue-wakeups.md` before Phase 0 implementation.

## Sources

Upstream (all at `4736a85` unless noted):

- `docs/engineering/issue-wakeups.md` — full wakeup contract: event
  catalog, conditions, `max_fires`/`wakeup_chain`/rate-cap runaway rules,
  joined runs, check-ins, system `child_done` rule, workspace inventory.
- `server/internal/handler/issue_system_wakeup.go` — system-rule API
  shape (staged waiting, target resolution).
- `server/internal/service/task_triage_guard.go` — triage guard.
- `packages/core/attachments/deliverables.ts`; `packages/plugin-sdk/
{README.md,protocol.ts}`; `examples/plugins/deploy-sentinel/`;
  `server/internal/cloudruntime/client.go`.
- GitHub API: `/releases` (v0.4.35…v0.6.0), `/compare` (+755/0).

Cognia (HEAD):

- `types/issues/{index,unified}.ts`; `lib/db/{issue-events,issue-runs,
issues}.ts`; `lib/issues/{event-bus,boot,notify,relations}.ts`;
  `lib/issues/run/{registry,types,install}.ts`.
- `types/scheduler/index.ts` (`TaskTrigger` :549, `ScheduledTaskType`
  :24); `lib/scheduler/{task-scheduler,scheduler-db,event-integration,
catchup-policy,concurrency-limit,cron-parser}.ts`;
  `lib/scheduler/timing/*-driver.ts`.
- `lib/skills/built-in/{scheduler/_core.ts,issues/}`;
  `lib/chat/turn-admission.ts`; `lib/connectors/{live-steer,runtime}.ts`.
- `lib/ai/agent/external/runtimes/remote/`; `lib/execution/
agent-team-bridge.ts`; `lib/collab/{publish,session-permissions}.ts`;
  `lib/companion/device-presence-registry.ts`.
- `components/issues/{issue-detail-panel,issue-comment-composer}.tsx`;
  `components/artifacts/artifact-renderers.tsx`; `lib/global-search/`.
- Prior research: `.codex-research/multica-source-research.md`,
  `docs/research/multica-cognia-gap-analysis-2026-08-12.md`.
