---
title: "0165: Ambient cost visibility and the optimization loop"
description: "One writer owns the usage ledger and its budget projection, one projection feeds every ambient surface, external agents' spend is indexed separately and never touches a Cognia budget, and every efficiency claim carries the evidence it rests on."
---

# ADR 0165: Ambient cost visibility and the optimization loop

**Status:** Accepted
**Date:** 2026-09-03
**Builds on:** [ADR-0025](./0025-unified-subscription), [ADR-0062](./0062-agent-session-import), [ADR-0090](./0090-unified-agent-execution), [ADR-0130](./0130-cost-and-trace), [ADR-0136](./0136-cross-device-placement)

## Context

CodeBurn's valuable pattern is not another dashboard. It is an ambient control loop: collect usage locally, keep it glanceable in the taskbar, explain what is inefficient, offer a reversible fix, then measure whether the fix worked. Cognia already had stronger foundations than CodeBurn for every step, and a defect underneath all of them.

The defect: `sessionUsage` and `providerCostDaily` were written by different code on different clocks. Each surface recorder wrote the per-turn ledger row while `recordProviderOutcome` independently incremented the daily rollup from its own cost estimate. The two disagreed by construction. A retried turn overwrote its ledger row in place and added a **second** increment to the rollup. A turn whose SDK cost was zero but whose tokens were priceable landed in the rollup and not in the ledger. Nothing detected either, because no reader ever compared them, and the budget gate reads the rollup.

Above that, the tray could answer only "how much of my plan is left". It could not answer "what have I spent", which is the question a menu-bar readout is actually good at. Any surface that wanted to would have derived its own totals and disagreed with the others at the edges.

## Decision

1. **One writer owns the money.** `lib/usage/usage-ledger.ts` is the only path that commits a usage row. Cost is frozen once, the prior row is read inside the same transaction so an overwrite applies a delta rather than a second increment, and both tables commit together or neither does. `providerCostDaily` becomes a projection of `sessionUsage` rather than a parallel guess. `recordProviderOutcome` keeps health, rate limits, the breaker and affinity, and stops touching cost. A one-time idle rebuild converges projections that already drifted, and leaves its marker unset if it fails so the next boot retries. Conservation is asserted per surface in `usage-ledger.test.ts`.

2. **One projection feeds every ambient surface.** `UsageGlanceSnapshotV1` is what the tray title, tooltip, menu, quick panel, Capacity Dock, CLI and MCP tools all read. It enforces two things structurally. Unknown cost is never folded in as zero, so a partially priced window renders as a lower bound and an entirely unpriced one renders a dash. And the OS-facing object carries no session content at all: only numbers, ids and enums, because it is pushed into a Rust process and painted into a menu bar.

3. **External spend is indexed, separated, and never budgeted.** A `scanUsage` seam on `AgentSessionSourceAdapter` plus a generic bounded scanner gives all eleven first-party session sources external spend indexing with no adapter edits. Every row it writes is `imported: true`, which is the predicate the budget already excluded. `usageSourceStates` records why a scan degraded, so "we could not read this tool" stops rendering as "this tool has no spend". The all-tools scope is opt-in and is the only thing that reads another agent's files.

4. **The Capacity Dock is a second ambient surface, not a second truth.** It reuses the island's overlay recipe and anchors to the work area rather than the full monitor frame. Its placement math is pure and unit-tested on every platform, and every coordinate is pixel-aligned, which is where CodeBurn's documented idle relayout drift comes from. Visibility has exactly one source of truth, the renderer's `enabled` preference: Rust persists geometry and deliberately not visibility, so a failed write on either side cannot make them disagree. Linux reports its capabilities rather than assuming them, and a Wayland session that refuses window positioning gets a disabled card explaining why with the tray named as the fallback.

5. **Every efficiency claim carries its evidence.** Work-unit metrics report `null` and a named gap for anything the available evidence cannot support, rather than a zero that reads like a measurement. Outcome attribution joins spend to the Task Workspace adoption ledger, which records what was accepted, partially accepted, rejected or reverted. Absence of evidence is never rejection, coverage is reported beside every bucket, and `canJudgeWaste` is a separate function so no caller reaches that verdict by eyeballing a ratio. An imported session is always `unknown` and cannot be called wasteful.

6. **Findings are deterministic and reversible.** No detector asks a model: a recommendation that costs money to produce and answers differently on a re-run over identical data is not something to act on. A finding says whether its impact was measured or estimated, and carries the turn, unit and day counts it rests on. Applying a Cognia-owned setting is a compare-and-swap against the value the preview saw. Measurement needs three days and twenty comparable turns before it grades anything, and below that the answer is `inconclusive`, never `no-effect`. Auto-revert is opt-in and only ever touches a value that still hashes to what the action wrote.

7. **External agents read, and only read.** `usage_query`, `session_health` and `optimization_findings` sit behind one new `usage:read` scope, default OFF. Session ids come back pseudonymized and the settings key behind a fix is withheld, so an agent can discuss the spend without learning the project or how to reconfigure the app.

## Consequences

- Dexie **v218**: `usageSourceStates` (derived, local-only, rebuildable), plus `sourceId` and `[sourceId+sourceSessionId]` indexes on `sessionUsage`, and five additive row fields.
- A new `gateway` usage surface. Gateway traffic now writes a canonical ledger row instead of reaching the rollup through the telemetry sink.
- Tray defaults are unchanged on upgrade: quota, this app only. Both spend and the all-tools scope are explicit opt-ins.
- Idle installs perform no polling and no filesystem work. Local spend is a Dexie live query, and external scanning runs on entering the scope, on explicit refresh, or on a source invalidation.
- **Declared dormancy:** the apply/undo action machine is complete and no shipped detector emits a `fix` finding, so nothing routes into it yet. Pinned by a test that must be updated rather than deleted by whoever adds the first fix.

## Non-goals

Parity with all 41 CodeBurn providers, a second MCP server, a second desktop binary, external spend affecting Cognia budgets, raw usage synchronized to the companion, automatic edits to another agent's global configuration, and timestamp-only productivity verdicts. CodeBurn is design and algorithmic prior art. Any directly ported MIT code must retain attribution.
