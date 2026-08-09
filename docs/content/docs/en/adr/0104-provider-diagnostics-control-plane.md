---
title: ADR-0104 — Provider diagnostics control plane
description: "Protocol-aware probes, paid benchmarks, balances, secure scripts, endpoint comparison, history, scheduling, and paired-device access."
---

# ADR-0104 — Provider diagnostics control plane

**Status**: Accepted (2026-08-01)

## Context

The former health panel treated model-list latency as model health and kept no comparable history. Balance readers used several transport shapes and could not represent multiple accounts without implying their values were additive. Diagnostics must be useful without contaminating production routing health, and extensions must not gain ambient filesystem, process, cookie, environment, or credential access.

This decision extends [ADR-0025](/docs/en/adr/0025-unified-subscription-module) and [ADR-0043](/docs/en/adr/0043-llm-provider-execution).

## Decision

- Resolve diagnostic targets through the production provider snapshot. Persist provider, model, credential-record fingerprint, endpoint identity, capability, metrics, pricing version, and redacted failures—never secrets, prompts, responses, headers, or response bodies.
- Record reachability, authentication, capability, and real execution independently. HTTP 400 and arbitrary response headers are not successful model tests.
- Run paid text and embedding samples through Sidecar `feature_call` and the same declarative or correlated code adapter as chat. Fixed versioned prompts pass the PII gate; tools, memory, fallback routing, and hidden retries are disabled. Quick is one sample; Precise is one auditable warm-up plus three measured samples.
- Enforce concurrency 1–5, per-sample timeouts, 64 output tokens, 50 requests, and a USD 0.25 known-price budget. Unknown prices require confirmation. Abort reaches active streams and partial state is persisted.
- Dexie v140 retains jobs, samples, balances, refresh state, and endpoint rollback journals for 90 days and at most 20,000 rows. Warm-ups do not enter summaries; P95 requires 20 comparable samples.
- Keep balance sources separate by account and native unit. Project legacy `subscriptionBalance` and `providerLimits` rows without destructive migration or summing. Show official, declarative, sandbox, plugin, and unsupported provenance.
- Native authenticated HTTP preserves real status with bounded headers and body. QuickJS uses a fresh 16 MiB runtime, 250 ms compute phases, at most three 1 MiB GET/POST responses, redirect/DNS revalidation, and explicit domain/HTTP/private-network grants. The host resolves only the source's own secure credential reference after evaluation.
- A Rust-driven scheduler clock runs free reachability every 15 minutes, primary balance every 30 minutes, and other balance sources every two hours. It pauses offline or while the vault is locked, honors `Retry-After`, never schedules paid benchmarks, and emits transition-only notifications with cooldown.
- Endpoint candidates are limited to catalog, current settings, explicit input, and read-only local CCSwitch rows. Free comparison ranks reachability; paid comparison is separately confirmed. Apply shows a diff and rollback is compare-and-swap protected.
- Paired devices receive sanitized captured-at/revision projections. Remote jobs require desktop opt-in, the relevant Companion device-control grant, an online unlocked host, and initiating-device cost confirmation. Remote payloads cannot carry endpoints, credentials, scripts, grants, or pricing.
- Diagnostic badges are advisory mirrors only. Passive production traffic remains the sole automatic routing and circuit-breaker health input.

## Verification

Co-located tests cover statistics, limits, cancellation, adapters, transport, sandbox policy, scheduling, persistence, rollback, responsive UI, and paired authorization. `provider-diagnostics:live` emits `verified`, `failed`, or `unverified` evidence for every required protocol and balance family; missing credentials never fall back to mocks.
