---
title: "0230 — Best-of-N attempts share a frozen base"
description: "A Host ledger owns independent attempts, physical workspace leases, budgets and manual winner authorization."
---

# ADR 0230 — Best-of-N attempts share a frozen base

**Status:** Accepted
**Date:** 2026-10-17
**Related:** ADR-0198, ADR-0217, ADR-0227, ADR-0229

## Decision

One request allocates two to four independent attempts on one Host and one Git
repository. `task-workspaces.sqlite` owns `best_of_n_groups` and
`best_of_n_candidates`; renderer and future synced projections are rebuildable.
The request ID is unique. The Host resolves a committed base SHA exactly once
and records whether the source checkout was dirty. Uncommitted edits are never
copied into attempts. Each candidate owns a child session and a managed bundle
acquired with `base: { kind: "gitRef", gitRef: baseSha }`.

`lib/best-of-n/service.ts` exposes the single `startBestOfN` entry. It consumes
the slash-command or composer send; it never sends a second parent
message. The pure driver schedules a fixed N tasks through durable team
dispatch, with no planner, sibling messages, automatic selection or synthesis.
Profiles and models pass through capability grants into `resolveSendOptions`.
Returned send options are never modified by this feature.

## Ownership, budgets and recovery

Each Host mutation carries a group version and an expiring owner lease.
Allocation and compare-and-swap updates use SQLite transactions. The driver
renews its lease while running and stops execution if renewal fails. Recovery
rebinds to the ledger and marks interrupted or missing-workspace attempts
`recoveryRequired`; uncertain writes are never automatically replayed.

Durable write locks use Host-canonicalized physical roots across runs and
repository aliases. Independent roots may change the same relative path.
Aliases of one root share a lock. Existing isolated-parallel ownership checks
still apply within that root. Port blocks use the ADR-0229 allocator.

A finite duration bounds the group. An optional USD budget is divided equally
among the fixed attempts and forwarded as a narrow-only capability grant.
Known costs accumulate in the Host ledger; unknown costs remain `null`.
The resolved runtime must enforce a configured USD cap; phase 1 rejects that
combination before sending on runtimes without this capability. Duration-only
attempts remain available, and an AI-SDK default zero cost is treated as unknown.
The Host also checks cumulative spend and elapsed execution time. A failed
candidate does not park its siblings: durable dispatch's `isolateFailure`
option preserves the child's evidence/checkpoint without parking the run.
Zero successful candidates requires recovery. No-change successes remain
visible but cannot become publishable winners.

## Selection and publication

The normal phases are `preparing → running → awaitingSelection → publishing →
published`, with `cancelling`, `cancelled` and `recoveryRequired` exits.
Archive status is separate; cleanup failure cannot replace a published result.

Only a trusted interactive app invocation can select a candidate. Companion,
plugin and unattended callers cannot assert an interactive origin in JSON.
Because frontend plugins share the main renderer, the Host also requires a
native user confirmation naming the candidate, recorded head and target branch.
The confirmation is bound to the business version; stale approval must be repeated.
Waiting for the dialog does not hold the progress queue. Lease-only renewal keeps
that version unchanged; candidate progress, ownership changes and substantive
recovery advance it. After approval, the Host rereads and validates the state
before the selection CAS. Explicit cancellation persists independently of budget
exhaustion, so a budget-stopped run can still become cancelled and be archived.
Selection pins the candidate ID and captured head SHA and stops unfinished
attempts. There is no AI judge. A new result branch is the default; an existing
branch requires an explicit target choice. Nothing pushes a branch.

The changeset capture path recognizes candidate workspace/session ownership
before candidate progress attaches a changeset ID. Capture compares against
the frozen base, even before the result branch exists. Integration preparation
and publication independently reject non-selected candidates, changed heads,
wrong targets and multi-changeset or non-stop conflict policies. Publication
uses the existing ADR-0227 queue with one winner and `onConflict: "stop"`.
Integration normalizes short branch names before the winner guard, so `main`
and `refs/heads/main` name the same explicitly chosen target.

## Delivery boundary

Phase 1 provides the ledger, Host commands and catalogs, fixed driver, recovery,
budgets and publish guard. Phase 2 adds the slash command, one-shot composer
chip, comparison dock, manual selection/check/publication flow and synced
summary. Phase 3 (below) adds heterogeneous agents, the CLI and plugin
surfaces, paired stop requests and restart recovery; schemas never grant
selection authority.

Both starts preview the committed base, excluded uncommitted edits and editable
target. The default new branch is `best-of-n/<requestId>` using the group's
persisted request identity. Selecting an existing branch is explicit. The
parent assistant ID is that request ID, allowing its run-card binding to be
rebuilt from durable messages without sending the parent prompt to a model.

The comparison dock renders read-only diffs and changeset details. Picking
stops unfinished attempts and runs approved ADR-0188 profiles. `checks.ts`
provisions a fresh checkout of the recorded changeset head; it never treats a
mutable execution directory as proof of that commit. Deterministic SCM review
runs without an AI reviewer. Publish is a separate manual action: recheck the
head, record user approval, and call `createScmRuntime.integrate` with one
changeset and `onConflict: "stop"`. Integration checks its composed commit too.

After publication only losers are archived. Host workspace archive status and
session cleanup errors remain independent of publication and can be retried.
Explicit archive cancels unfinished, unselected runs first. The winner remains
available. `bestOfNRuns` is a disposable Dexie projection in the governance
catalog and Companion sync registry. It carries Host state, parent binding,
exact-head evidence and summaries, never write authority. Refresh/rebuild
rehydrates it from Host evidence. Paired clients render the mirror read-only;
the account E2E authority registry is unchanged.

Focused tests cover allocation retries, frozen-base capture, owner/CAS races,
physical alias locking, independent failure, early cancellation, unknown cost,
manual exact-head selection and the integration prepare/publish guards.

## Phase 3: agents, surfaces, devices and restarts

**Heterogeneous candidates.** Each candidate records its own agent descriptor.
A choice is `session` (the conversation's agent, model and provider), an exact
external-agent configuration id, or a preset id (`claude-code`, `codex`) that
resolves to the first enabled, non-gateway-bound configuration of that runtime
in the shared binding order. The slash command takes `--agents a,b,...`, one
entry per candidate; the start dialog has one picker per attempt. Choices are
resolved before the preview and again before start; an unknown or disabled
name is refused, never replaced. An external candidate is stored as the
conversation's agent plus the `cognia:external-agent:<configId>` provider.

External candidates run through the external-agent manager, the launch path
Agent Team teammates use, with the candidate's workspace root as the working
directory and the group's remaining duration as a deadline. No MCP servers are
forwarded, so the candidate grant's tool denials hold. The external execute
contract reports no cost and enforces no dollar cap: cost stays `null`
(shown as unknown) and a USD budget is refused before the attempt starts. A
Cognia agent whose own resolved runtime is external takes the same lane; the
legacy unscoped external marker is refused.

**CLI.** `cognia-agent best-of-n start|status|list|cancel|select|publish|archive`
drives the desktop through `POST /api/dev/best-of-n/{action}` on the CLI
bridge, answered by the renderer that owns orchestration. Start uses the same
preview/start path as the composer. Select and publish are refused with
`--yes`, under `CI`, or without a TTY; they ask on the terminal and then still
meet the Host's native approval, because no bridge field can assert that a
person chose. Existing Host commands keep their catalog entries.

**Plugins.** `ctx.team` gains `startBestOfN` (`agent:dispatch`, always a new
result branch), `getBestOfN` and `listBestOfN` (`team:read`, from the synced
projection) and `cancelBestOfN` (`agent:control`). There is no select or
publish; a test pins that no such method exists. Reads return a public
projection without owner lease, version, physical roots or workspace ids.

**Paired devices.** `BestOfNDeviceRole` names the two roles. A paired
observer renders the projection and may ask the Host to stop a run: the Host
accepts a cancel from a non-owner without taking the owner's lease (version
CAS still applies), and the owner settles each attempt on its next poll.
Select, publish, checks and archive are inert there, labelled in the UI and
pinned by tests.

**Restart and refused publication.** A desktop initializer runs recovery once
per process. It waits for the previous process's lease to lapse (bounded),
then rebinds every unfinished group: running attempts become
`recoveryRequired`, attempts that never started fail, and a missing workspace
is reported by the Host. A publish the Host refuses after prepare (for
example a dirty checked-out target) used to leave the winner `integrating`,
which review refuses. Abort now returns a best-of-N winner to `approved`;
publication releases the held run right after the refusal and again on any
retry or restart, so the retry re-runs exact-head checks and prepares a fresh
integration. A run still `publishing` is never aborted. `/best-of-n` inside a
multi-command batch is refused before any command runs.

