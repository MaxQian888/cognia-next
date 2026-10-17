---
title: "0232 — A long run shows an estimate, never a budget"
description: "A read-only estimator derives cost and duration ranges for long agent runs from the local usage ledger; it advises and never gates."
---

# ADR 0232 — A long run shows an estimate, never a budget

**Status:** Accepted
**Date:** 2026-10-17
**Related:** ADR-0019, ADR-0022, ADR-0090, ADR-0165, ADR-0188, ADR-0230

## Context

A person launching a long agent run (a `/goal`, an Agent Team, a best-of-N
group, a bot run, a scheduled task) has no sense of what it will cost or how
long it will take until it has finished. Everything needed to answer that from
history is already recorded:

- `sessionUsage` is the single usage ledger (ADR-0165). Each row carries
  `runId`, `surface`, `model`, `providerId`, input, output, cache-read and
  TTL-split cache-write tokens, and the price it was frozen at.
- `executionRuns` records `kind`, `startedAt`, `endedAt` and a terminal status
  for every run (ADR-0090).
- `lib/usage/pricing.ts` prices tokens for any model at today's rates.
- External harness history is indexed as `imported` rows and never budgeted.

Spend enforcement is also already covered: the cost-budget gate, gateway
tickets and the passthrough ledger, the Router + Fusion ledger (ADR-0188),
`RunBudgetGovernor` (ADR-0090) and the per-surface caps on goals, teams,
best-of-N and bots. A heavier design was considered: per-request
reservation, gradient-boosted quantile regression, conformal calibration,
remaining-cost forecasting, success-within-budget probability and model
predictive control. It was rejected. Its control half duplicates what exists.
Its learning half needs far more labelled trajectories than one local install
produces, there is no Python runtime to train or serve it, and most runs have
no verifiable success label.

## Decision

Cognia adds one read-only estimator. It sets expectations; it never changes
execution.

**Advisory only.** No estimate gates, reserves, routes, compacts, re-plans or
stops anything. The existing budget mechanisms remain the only enforcement.
No success probability is shown.

**Where it appears.** Only on the launch surfaces of long runs: the new-goal
dialog and the `/goal` created card (the slash command has no confirm step),
the squad's start controls, the best-of-N start dialog (summed over the
candidates' agents), the scheduled-task form, and the bot run button (dormant,
see below). Ordinary chat sends show nothing.

**What it shows.** A typical value and a P10–P90 range for cost, tokens and
wall-clock duration, a confidence label, and the share of comparable runs
that stopped early. Cost is always worded "at API prices": for an API-key user
that is the bill, for a subscription user the equivalent, so neither needs to
be detected. Quota percentages are never derived from tokens.

**Samples.** One sample is one finished run, aggregated over its run tree
(child runs and teammates included). A sample holds the per-category token
counts jointly, not their separate quantiles. Each sample is priced at
today's rates for the launch's model (or its own model when the launch names
none) through `lib/usage/pricing.ts`, then quantiles are taken over those
per-sample totals, so price changes do not distort history. Cancelled,
failed and limit-stopped runs are included; the estimate means "what a run
like this costs until it ends". Censoring is not modelled.

Each surface keeps its history in a different place, so each has its own
sample builder (`lib/usage/run-estimate/samples.ts`):

| Surface | Tokens | Status and duration | Model |
|---|---|---|---|
| goal | usage rows under `goal:<goalId>` | the goal row | the conversation's chat rows during the goal's lifetime; none for a headless goal |
| team (squad) | usage rows under `team:<runId>` | the team `ExecutionRun` | the rows' dominant model |
| best-of-N | none: candidates write no usage rows | each candidate | the candidate's agent |
| scheduled | the conversation a task created (`origin.kind === "scheduled-task"`), minus scheduled goals | the rows' time span | the rows' dominant model |
| external session | imported rows per source session | the rows' time span | the rows' dominant model |

Best-of-N candidates carry only a frozen dollar figure, so their samples
cannot be re-priced; one candidate is one sample and a launch of N multiplies.
Native bot agent turns record no usage at all, so the bot surface is
intentionally dormant: documented on `RunEstimateSurface`, rendered as "no
estimate yet" beside the bot's run button, and pinned by `estimate.test.ts`.
Both gaps are ledger bugs (ADR-0165) to fix separately; when bot turns write
usage rows, the bot surface gets a sample builder.

**Buckets.** Launch surface × harness × model family. Lookups fall back from
the fine bucket to surface × harness, then to the surface alone; a key the
query cannot fill is skipped rather than matched against "unknown". Model
families normalize concrete model ids (`claude-sonnet-4-5-20250929` →
`claude-sonnet`). No run record stores a harness, so it is recovered where a
source carries one (a teammate's `runtime`, a best-of-N candidate's
external-agent preset, an import's `sourceId`); every Codex surface maps to
one key. A run whose harness cannot be recovered joins only the buckets that
ignore harness. Prompt length and repository binding were considered as
refinements and dropped: only goals record their prompt, so they would empty
almost every bucket. Features come from the launch configuration and
existing metadata only; estimation makes no model call.

**External history.** Imported Claude Code and Codex sessions count as one
sample per session, in a separate "external interactive session" surface
bucket. They are consulted only for a launch on the same external harness,
after that surface's own history on the harness, and never mix into goal,
team or other buckets. They remain excluded from budgets.

**Drift.** Only the last 90 days are used, weighted with a 30-day half-life.

**Confidence.** The finest bucket with at least 5 samples answers: 5–19
samples are labelled "few", 20 or more "based on N runs". When no bucket
reaches 5, the fullest one answers and the result is labelled "rough" (until
phase 3, when a bundled prior fills that gap). With no usable source, show
"no estimate yet". Quantiles are weighted (midpoint interpolation), so recent
runs pull harder.

**Computation.** `lib/usage/run-estimate/load-samples.ts` reads the existing
tables (`sessionUsage`, `chatGoals`, `executionRuns`, `agentTeamChildRuns`,
`bestOfNRuns`, `sessions`) inside the window on demand, behind a five-minute
in-memory cache; pure functions do the rest. No new Dexie table and no
schema bump.

**During a run.** The run surface shows "spent X of a typical Y" and notes when
spend exceeds the bucket's usual range. There is no remaining-cost model.

**Bundled priors.** A fixed long-task set run through `packages/eval-core`
per harness × model family produces a quantile JSON that ships with the app,
regenerated and gated like the price catalog. Priors only fill buckets that
local history cannot.

## Phases

1. Local bucketed estimator and its display on the long-run launch surfaces.
2. The running "spent vs typical" comparison.
3. eval-core priors, their generator script and their gate.

## Consequences

- Estimates are honest about their footing: every number carries its sample
  count or a "rough" label, and nothing is presented as a guarantee.
- A fresh install shows mostly rough or missing estimates until phase 3 ships
  priors or local history accumulates.
- Because runs that stopped early are included, ranges describe cost to
  termination, not cost to success. The early-stop share is shown so that the
  difference is visible.
- If labelled outcomes later become plentiful (for example from acceptance
  checks), a success-aware estimate can be revisited in a new ADR.
