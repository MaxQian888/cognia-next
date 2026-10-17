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
the future slash-command or composer send; it never sends a second parent
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
The confirmation is bound to the ledger version; stale approval must be repeated.
Selection pins the candidate ID and captured head SHA and stops unfinished
attempts. There is no AI judge. A new result branch is the default; an existing
branch requires an explicit target choice. Nothing pushes a branch.

The changeset capture path recognizes candidate workspace/session ownership
before candidate progress attaches a changeset ID. Capture compares against
the frozen base, even before the result branch exists. Integration preparation
and publication independently reject non-selected candidates, changed heads,
wrong targets and multi-changeset or non-stop conflict policies. Publication
uses the existing ADR-0227 queue with one winner and `onConflict: "stop"`.

## Delivery boundary

Phase 1 provides the ledger, Host commands and catalogs, fixed driver, recovery,
budgets and publish guard. The slash command, composer chip, comparison UI,
selection-to-integration interaction, heterogeneous external agents and public
CLI/plugin product surfaces remain later phases. The internal command schemas
are ready for those callers; they do not grant selection authority.

Focused tests cover allocation retries, frozen-base capture, owner/CAS races,
physical alias locking, independent failure, early cancellation, unknown cost,
manual exact-head selection and the integration prepare/publish guards.
