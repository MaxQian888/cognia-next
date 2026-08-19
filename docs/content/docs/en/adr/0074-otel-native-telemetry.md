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

## 2026-08-19 amendment — PostHog destinations

PostHog is an additional destination, not a replacement for generic OTLP,
Langfuse, local agent-trace storage, or native telemetry. Managed and
bring-your-own projects each expose separate product-analytics and AI-observability
consent switches; all four default off. Product events still pass the behavior
telemetry master switch, category filter, sampling, scalar validation, and PII
gate. AI observability has independent consent.

Product analytics posts directly to PostHog's batch capture API
(`POST {host}/batch/`) instead of embedding a browser SDK. The events are manual
captures — no autocapture, page lifecycle capture, session replay, surveys,
feature flags, person profiles, or automatic exception capture — so the SDK adds
nothing this integration uses, and it would open its own connection from the
renderer, which the desktop CSP blocks. The batch therefore leaves over the same
Rust leg as every other outbound request on Tauri (`telemetry_otlp_export` with
no credential; the project token travels in the body as `api_key`) and over
`fetch` on web and mobile. Events buffer until 20 are queued or 2s pass.

The headless brain (`cognia-agent serve`) installs the same exporter from
`COGNIA_POSTHOG_HOST` / `COGNIA_POSTHOG_PROJECT_TOKEN` (falling back to the
`NEXT_PUBLIC_POSTHOG_*` pair), alongside its OTLP logs sink. It has no
per-destination consent UI, so its PostHog destination is gated on the
account-wide remote-destination consent instead: an operator's environment
variable configures a destination, it does not grant permission to use one. Its
distinct id must be pinned through `COGNIA_OBSERVABILITY_INSTALLATION_ID` —
the brain's `localStorage` is an in-memory shim, so a generated id would be new
per process and report one install as a fresh person on every restart. Without
it the destination stays off and the brain logs why.

AI telemetry uses AI SDK 7 `OpenTelemetry` from
`@ai-sdk/otel` and provider-independent `PostHogTraceExporter` from
`@posthog/ai@8.8.0`. One sidecar `NodeSDK` owns a processor per enabled generic
OTLP or PostHog destination; PostHog always uses `/i/v0/ai/otel` and is never
used to derive logs or metrics endpoints.

The remote allowlist contains identifiers, runtime/version, provider/model,
usage, latency, cost, tool names, and success/failure state. Prompts,
completions, system instructions, tool schemas/arguments/results, file content,
URLs, and exception message/stack/body are stripped again immediately before
export. The random installation ID is the only PostHog `distinct_id` — carried
as the `distinct_id` field on product events and as the `posthog.distinct_id`
span attribute on AI spans from both the renderer and the sidecar, so one turn
resolves to one person; account, email, and hardware identifiers are prohibited. PostHog project tokens are
public ingestion tokens; Personal API Keys are rejected by policy and tokens are
masked in UI, logs, and diagnostics.

## Alternatives rejected

- Adding `https:` or runtime hosts to CSP: too broad and cannot express a
  user-supplied endpoint safely.
- Adding Tauri HTTP solely as a proxy: it would not establish the Rust tracing
  and secret boundary used by the rest of this decision.
- Span events for product analytics: they pollute latency waterfalls; OTel Logs
  match instantaneous events more closely.
