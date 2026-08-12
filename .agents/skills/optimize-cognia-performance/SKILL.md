---
name: optimize-cognia-performance
description: >-
  Run evidence-driven performance optimization experiments in cognia-next after
  a bottleneck or target is known. Use for explicit optimize/性能优化,
  benchmark/压测, or performance-budget requests; bundle, startup, interaction,
  memory, CPU, storage, IPC, sidecar, mobile, Rust, or build performance; and
  post-diagnosis performance work. Do not use as the primary workflow for an
  unexplained slowdown, 卡顿, or regression (use diagnosing-bugs), Slardar daily
  reports (use performance-daily-report), or generic correctness review.
---

# Optimize Cognia Performance

Treat each performance-motivated change as an experiment. Prove a user-visible
bottleneck, change the smallest responsible seam, remeasure the original user
path, and retain no performance claim that the evidence does not support.

## Route specialized work

- Route an unexplained slowdown or regression through `diagnosing-bugs` first.
  Return here after its feedback loop identifies a bottleneck or produces a
  stable performance baseline.
- Route Slardar collection, interpretation, cards, and delivery through
  `performance-daily-report`.
- Load `next-best-practices` before changing Next.js routes, images, fonts,
  client boundaries, bundling, or static-export behavior. Keep the main app's
  static export distinct from the server-mode `docs/` app.
- Load `dexie-migration` before adding or changing a Dexie table, index, schema
  version, or backfill. Performance does not relax its migration contract.
- Run `preflight` for final repository gates instead of duplicating its auditor
  and test matrix here.

## Run the experiment

### 1. Name the user outcome

State the end-to-end user path and one primary metric before choosing a layer
to inspect. Track relevant guardrail metrics such as p95, memory, CPU, bundle
size, battery, startup, and complexity so a local win cannot hide a system
regression.

If the request leaves a choice that materially changes the platform, workload,
or success threshold, ask one concise question in Chinese. Otherwise state the
assumption and continue.

### 2. Inspect before instrumenting

Read the relevant ADR and current implementation. Search `lib/`, `components/`,
`hooks/`, `src-tauri/`, and the affected package for existing marks, spans,
profilers, scripts, fixtures, and benchmarks before adding new ones.
Read [references/measurement-matrix.md](references/measurement-matrix.md) for
the applicable surface and the limitations of Cognia's existing tools.

Inspect `rtk git status` before editing. Treat these as different promises:

- **No source edits:** measurement may still create `.next/`, `out/`, Cargo
  artifacts, copied assets, downloaded files, caches, traces, or reports.
- **Read-only filesystem:** run only commands verified not to write. If useful
  measurement requires generated artifacts, disclose the exact side effects
  and obtain any authority the current request does not provide.

Do not clean caches merely to make a benchmark convenient. Cold-cache cleanup
can affect unrelated work and is destructive in a shared tree.

### 3. Pre-register the comparison

Fill the contract in
[references/experiment-contract.md](references/experiment-contract.md) before
editing code. Fix the workload, data, device, build mode, cache state, sample
count, statistic, noise rule, practical threshold, guardrail limits, allowed
side effects, and verification commands before seeing the result.

Measure the end-to-end outcome first. Use layer metrics only to attribute the
bottleneck, then remeasure the original outcome after the change.

### 4. Establish the baseline

Run the exact declared workload under representative conditions. Keep baseline
and result comparable: same machine or device, build mode, data, network,
provider, cache state, and command. Do not compare a development trace with a
production build, a desktop browser with Capacitor, or a cold run with a warm
run.

Capture raw evidence or its reproducible location. Never rely on a screenshot,
single timing, or remembered number when machine-readable output is available.

### 5. Change one cause

Form a falsifiable statement: "If X is the bottleneck, changing Y will improve
metric Z under contract C." Make the smallest change that tests it. Separate
independent optimizations so each result remains attributable.

Do not remove required work, weaken validation, skip an `await`, serve stale
data, or change the user-visible behavior to manufacture a faster number.

### 6. Remeasure and decide

Run the same comparison and correctness checks. Apply the decision rules to
every performance claim and performance-motivated hunk, even when bundled with
a bug fix or refactor:

| Evidence | Action |
| --- | --- |
| Improvement clears the predeclared threshold and noise rule; guardrails and correctness pass | Keep and report the measured claim. |
| Result is within noise or below the practical threshold | Remove the performance-only change and report the inconclusive attempt. |
| Primary or guardrail metric worsens | Remove the responsible change. |
| Correctness or shell-parity check fails | Remove or revise the change; do not trade correctness for speed. |
| A refactor has a separate non-performance benefit | Justify that benefit separately; make no unsupported performance claim. |

Remove only agent-owned hunks with a targeted patch. Never use whole-tree
checkout, reset, stash, or cleanup to undo an experiment in a shared worktree.
Remove temporary instrumentation unless it becomes an intentional, bounded,
tested observability seam.

### 7. Guard without adding flakes

Prefer deterministic structural budgets, representative benchmark suites on a
pinned runner, bounded instrumentation, or correctness regression tests. Do
not add wall-clock CI thresholds to noisy shared runners. If no reliable
automated performance guard exists, state that limitation and preserve the
reproducible manual command and evidence instead.

### 8. Verify and report

Run focused correctness checks plus the affected platform or shell checks, then
run `preflight`. Do not claim Web, Tauri, Capacitor, docs, service, or plugin
parity unless that surface was actually exercised.

Report results in Chinese using the evidence template in
[references/experiment-contract.md](references/experiment-contract.md). Include
baseline, result, delta, noise, verdict, guardrails, verification commands,
artifact locations, and unverified surfaces. Record failed attempts in the
task or PR evidence; do not create a repository-wide `PERF.md` by default.

## Non-negotiable checks

- Require before-and-after numbers for every performance claim.
- Require the same end-to-end metric before and after layer optimization.
- Require improvement beyond both measurement noise and practical relevance.
- Preserve user changes and disclose measurement side effects.
- Keep correctness, data freshness, privacy, and shell parity as hard gates.
- Never turn generic budgets from an external checklist into Cognia policy
  without a product-specific baseline and owner-approved target.
