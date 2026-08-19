---
title: ADR-0102 — Unified observability and crash diagnostics
description: "Adopt a versioned cross-runtime event contract, local-first crash-safe spools, bounded recovery, consented diagnostic uploads, and a self-hosted multi-tenant diagnostic service."
---

# ADR-0102 — Unified observability and crash diagnostics

**Status**: Accepted (2026-08-01)

## Context

Cognia already has a capable renderer logging package, IndexedDB and native
transports, a Tauri panic hook and out-of-process minidump monitor, crash report
UI, and OpenTelemetry integration. Those parts use different persisted shapes,
retention rules, correlation boundaries, and user surfaces. The Capacitor app,
CLI, Sidecars, plugins, and remote services do not yet share one crash lifecycle
or one capability model. Routine log export and crash submission also need
separate consent and privacy controls.

The existing `StructuredLogEntry` and native crash report formats remain active
and contain user data that must stay readable. This decision therefore extends
the current owners and introduces compatibility adapters instead of replacing
the working pipeline.

## Decision

- Adopt `ObservabilityEventV1` as the versioned wire and spool envelope for
  `log`, `span`, `crash`, `lifecycle`, and `metric` events. New writers use V1;
  bidirectional adapters keep `StructuredLogEntry` readable during a staged
  dual-read/dual-write window.
- Carry W3C Trace Context explicitly across HTTP, Tauri IPC, child-process,
  Sidecar, Companion, mobile, CLI, and plugin boundaries. Async work uses an
  immutable scoped logger; shared mutable trace/span state is legacy-only and
  is removed after call-site migration.
- Every workflow run creates a root `traceId`; step spans, agents, LLM calls,
  subworkflows, and ensemble child runs inherit that context. Persisted
  `WorkflowRunLineage` (`rootRunId`, parent step/run, retry origin/mode) is the
  navigation and replay authority, while the trace tree is the telemetry view.
  Any external observability transport still passes the existing PII gate.
- Give every runtime a bounded crash-safe local spool. Low-severity events are
  batched; `warn` is forwarded promptly; `error`, `fatal`, crash markers, and
  terminal lifecycle events use the strongest flush available on the runtime.
- Keep routine remote logs disabled by default. Crash bundles are retained
  locally first and require previewed consent unless the user separately enables
  automatic submission. Minidumps and current-state screenshots are unchecked
  optional attachments.
- Apply one versioned privacy manifest before local persistence, IPC, export, or
  upload, then re-scan streams server-side. Raw prompts, messages, tool I/O, and
  file bodies are excluded outside a time-bounded local debug session.
- Use the existing Tauri panic/minidump pipeline as the desktop owner. Add a
  first-party Capacitor plugin around KSCrash plus MetricKit on iOS and ACRA plus
  `ApplicationExitInfo` on Android. Every surface reports actual capabilities.
- Enter safe mode after two unhealthy starts for one build within ten minutes.
  Renderer reloads and child restarts are bounded; ten healthy minutes reset the
  counter. Safe mode starts a diagnostics-first shell and progressively
  re-enables subsystems through health checkpoints.
- Build a dedicated Rust/Axum diagnostic service backed by PostgreSQL and
  S3-compatible storage. It provides tenant-scoped upload grants, resumable
  uploads, receipts, deletion, server redaction, symbolication, grouping,
  retention, alerts, audit, and an OIDC-protected service console.
- Consolidate local inspection under `/logs`. Settings only configure policy and
  link into that responsive workspace. CLI/TUI expose equivalent log and crash
  operations with human, JSON, and NDJSON output.
- Exclude diagnostic state from normal business-data backup and sync. The only
  portable format is a validated, optionally encrypted `.cognia-diagnostic`
  package with a signed SHA-256 manifest.

## Consequences

One incident can be correlated across renderer, Rust, Sidecars, services, CLI,
plugins, Companion, and Capacitor without silently uploading routine activity.
Crash recovery becomes bounded and inspectable instead of an unbounded restart
loop. Support receives stable receipts and symbolized groups while users retain
preview, withdrawal, and deletion controls.

The system adds a new service, object storage, symbol pipeline, mobile native
dependencies, retention operations, and multi-tenant security obligations.
Rollout must therefore remain feature-gated and backward-readable; disabling
remote processing must never remove local reports or make V1 spools unreadable.

## Alternatives rejected

- Replace the existing logger and crash monitor: rejected because it would
  discard tested transports, formats, and native capture behavior.
- Send all logs to a hosted third party: rejected because routine logs are
  local-first, deployment must be self-hostable, and deletion/tenant isolation
  are product requirements.
- Route mobile incidents through the paired desktop: rejected because standalone
  mobile must remain functional and pairing cannot become a crash-delivery
  dependency.
- Enable minidumps or screenshots by default: rejected because they have a larger
  privacy surface than metadata, stacks, and redacted breadcrumbs.
- Use one global async trace stack in the browser: rejected because concurrent
  turns and nested processes can contaminate correlation.

## Implementation record

The 2026-08-19 PostHog integration follows this ADR's local-first and
destination-specific consent rules. It does not change crash upload consent or
the diagnostic service. Product events and AI spans fan out only to explicitly
enabled managed/BYO destinations. The PostHog export boundary applies the same
content-free allowlist as generic remote OTLP, including removal of exception
message and stack text.

The source-accurate contracts, state machines, rollout gates, limits, and
verification matrix live in
[`docs/plans/2026-08-01-unified-observability-crash-diagnostics.md`](../../../../plans/2026-08-01-unified-observability-crash-diagnostics.md).
