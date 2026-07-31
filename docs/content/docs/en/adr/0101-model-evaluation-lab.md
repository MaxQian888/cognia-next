---
title: "0101 — Complete Model Evaluation Lab"
description: "Local-first reproducible model and Agent evaluation with durable execution, calibrated judging, and portable evidence."
---

# ADR 0101 — Complete Model Evaluation Lab

**Status:** Accepted
**Date:** 2026-07-31

## Context

The original evaluation workspace was a useful regression runner, but a run was owned by one React promise, cases carried one text string, target snapshots omitted provider/runtime facts, and completion could outrun case persistence. It could not safely answer a model-selection question involving cost, latency, privacy, multimodal inputs, retries, or uncertainty. Comparisons across unrelated datasets also created misleading denominators.

## Decision

Cognia adds a project-oriented evaluation system while keeping all legacy datasets, versions, runs, calibration ids, workflow nodes, and plugin tools readable.

- `@cognia/eval-core` owns pure schemas, preflight, seeded paired bootstrap, Pareto selection, decision policies, blind assignments, calibration thresholds, adaptive repetitions, and `cognia-eval/v2` formats.
- Dexie v137 adds projects, immutable manifests, durable tasks, encrypted samples/assets, scores, reviews, adjudications, recommendations, configuration-apply records, and wrapped web keys. Legacy reports are labelled `legacy-non-reproducible` and cannot issue formal recommendations.
- Cloud target and judge payloads pass the shared PII gate; confirmed local targets may receive originals. Cloud media must be scanned or manually cleared. References remain scorer-side.
- Artifact plaintext uses a random AES-GCM data key. Desktop protects the account key in the OS keyring. Web wraps it with a PBKDF2 key held only while unlocked; password changes rewrap the data key.
- Execution persists `draft`, `preflight`, `queued`, `running`, `paused`, `interrupted`, `completed`, `failed`, and `cancelled`. It reserves worst-case cost before dispatch, requires cloud prices, honors `Retry-After` with exponential jitter and provider concurrency, and never silently re-spends an interrupted non-idempotent request.
- Pure-model execution uses `createProviderSettingsSnapshot → resolveFeatureProvider → createFeatureProviderModel → generateText`. Agent mode reuses isolated chat/team/workflow adapters.
- Formal selection runs every candidate once and adds up to two repetitions only near a constraint/ranking boundary. It uses seeded 95% paired-bootstrap intervals, builds a Pareto frontier, then applies utility weights only to candidates satisfying every hard constraint. Under 30 effective holdout cases, failed judge calibration, overlapping evidence, or no eligible candidate returns no conclusion.
- Subjective scoring is anonymous randomized A/B. Low-confidence, malformed, or conflicting verdicts escalate to a second judge and blind human adjudication. Formal calibration requires 30 anchors, Cohen's κ ≥ 0.6, and accuracy ≥ 0.8.
- Recommendation application previews a field-level diff, requires an explicit target, stores the previous configuration, and refuses unsafe rollback after unrelated edits.
- CLI `eval preflight/run/status/report/export` uses atomic checkpoints. Exit codes are 0 conclusive success, 2 no conclusion/gate failure, 1 configuration/execution failure, and 130 cancellation.

## User experience and rollout

`/eval` is a seven-step workbench: goal, data, variants, scoring, preflight, run, and review. Desktop has a project rail and resizable evidence pane; tablet collapses the rail; mobile uses single-step canvases, a persistent action bar, and sheets. Legacy dataset, comparison, trace, version, gate, and calibration tools remain secondary.

`NEXT_PUBLIC_EVAL_LAB=1` enables the workbench. `NEXT_PUBLIC_EVAL_LEGACY_ROLLBACK=1` restores the legacy workspace for one release. The switch is allowed only after unit, coverage, type, lint, i18n, static-export, PII, browser, Tauri, CLI, and credentialed provider gates pass.

## Consequences

Evaluation uses more local storage and raw evidence requires an unlocked account key. Formal recommendations take longer and often return no conclusion. In exchange, every recommendation has a reproducible denominator, explicit uncertainty, durable spend accounting, review provenance, and a reversible configuration change.
