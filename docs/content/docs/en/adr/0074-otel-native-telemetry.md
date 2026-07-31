---
title: ADR-0074 — Native OpenTelemetry pipeline
description: "Route desktop OTLP through Rust, keep secrets in the OS secret store, propagate W3C trace context through renderer, Rust, and sidecar, and keep product behavior telemetry explicitly opted in and separate from engineering traces."
---

# ADR-0074 — Native OpenTelemetry pipeline

**Status**: Accepted (2026-07-16)

## Context

Cognia already emitted agent spans, but desktop CSP prevented renderer `fetch`
from reaching collectors. A second OpenTelemetry switch wrapped only an absent
global provider and therefore exported nothing. Rust and the Node sidecar were
not part of the trace, credentials were persisted in renderer localStorage,
and no typed, consented product-event layer existed.

## Decision

- The desktop exporter is a narrow Tauri command backed by `reqwest`. It accepts
  only HTTP(S) endpoints, JSON payloads, and non-sensitive headers. Grafana and
  Langfuse authorization are constructed in Rust from the OS secret store;
  secrets are write-only from the renderer and never returned over IPC. The
  commands are explicitly listed in the application manifest and main-window
  telemetry capability.
- The existing agent-trace OTLP transport remains the sole trace-export switch.
  The non-functional `OtelTransport` and its duplicate settings surface are
  deleted.
- W3C `traceparent` is propagated explicitly. Renderer root spans remain the
  source of truth; Rust attaches the parent to `tracing` spans and the sidecar
  extracts it before AI SDK or Anthropic work begins.
- The sidecar uses NodeSDK and OTLP/HTTP. AI SDK telemetry records neither
  inputs nor outputs; the Anthropic path wraps its async query lifecycle in a
  manual span. Collector credentials enter the child process through its
  environment, never argv.
- Native Rust exporting uses the `otel-export` Cargo feature. It is **off by
  default** to preserve the compile-time improvements of ADR-0067. When enabled,
  `tracing-opentelemetry` bridges existing spans through a reloadable layer, so
  settings changes activate or replace the native provider without restarting.
  Each real performance registry observation is recorded directly into an OTLP
  histogram.
- Product behavior events use typed `<domain>.<object>.<action>` names and OTel
  Logs (`event.name`). They are default-off, require explicit consent, pass the
  shared PII gate, persist locally in Dexie v112, and can be exported or cleared
  independently. Engineering trace consent is a separate switch.
- Repository maintainers own catalog changes through CODEOWNERS.

## Consequences

Desktop telemetry no longer requires a permissive CSP, and stored credentials
are outside renderer-readable storage. One trace can join renderer, native, and
sidecar work. The optional Rust feature adds a heavier dependency graph only to
builds that select it. Behavior analytics cannot silently activate merely
because an endpoint is configured.

## Alternatives rejected

- Adding `https:` or runtime hosts to CSP: too broad and cannot express a
  user-supplied endpoint safely.
- Adding Tauri HTTP solely as a proxy: it would not establish the Rust tracing
  and secret boundary used by the rest of this decision.
- Span events for product analytics: they pollute latency waterfalls; OTel Logs
  match instantaneous events more closely.
