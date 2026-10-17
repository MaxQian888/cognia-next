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

**Where it appears.** Only on the launch surfaces of long runs: `/goal`, Agent
Team, best-of-N, bots and scheduled tasks. Ordinary chat sends show nothing.

**What it shows.** A typical value, a P10–P90 range and a confidence label,
for both cost and wall-clock duration, plus the share of comparable runs that
stopped early. API-key users see USD. Subscription users see tokens with the
equivalent API price. Quota percentages are never derived from tokens.

**Samples.** One sample is one launched run, aggregated over its run tree
(child runs and teammates included). A sample holds the per-category token
counts jointly, not their separate quantiles. Each sample is priced at
today's rates through `lib/usage/pricing.ts`, then quantiles are taken over
those per-sample totals, so price changes do not distort history. Cancelled,
failed and budget-stopped runs are included; the estimate means "what a run
like this costs until it ends". Censoring is not modelled.

**Buckets.** Launch surface × harness × model family, refined by a coarse
prompt-length band and whether a repository is bound. Lookups fall back from
the fine bucket to harness × model family, then to global. Model families
normalize concrete model ids (for example `sonnet-*`). Features come from the
launch configuration and existing metadata only; estimation makes no model
call.

**External history.** Imported Claude Code and Codex sessions count as one
sample per session, in a separate "external interactive session" surface
bucket. They inform only launches of the same external harness and never mix
into goal, team or other buckets. They remain excluded from budgets.

**Drift.** Only the last 90 days are used, weighted with a 30-day half-life.

**Confidence.** Fewer than 5 samples: fall back to a coarser bucket or to the
bundled prior and label the result "rough". 5–19 samples: show the range and
label it "few samples". 20 or more: show P10–P90 labelled "based on N runs".
With no usable source, show "no estimate yet".

**Computation.** Pure functions aggregate `sessionUsage` and `executionRuns`
on demand at launch, behind an in-memory cache. No new Dexie table and no
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
