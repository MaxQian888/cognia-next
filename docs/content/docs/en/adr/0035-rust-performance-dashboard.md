---
title: 0035 — Rust Performance Dashboard
description: A Task-Manager-style /performance panel backed by a Rust perf subsystem — live process-tree + Tokio runtime sampling plus an opt-in span hotspot registry — for finding backend performance hotspots.
---

## Status

Accepted (2026-05-26). Superseded in implementation on 2026-08-13 by the capability-driven lease and capture model below; the original local commands remain one-release compatibility adapters only.

## Context

The app already had rich observability for *adjacent* concerns — unified logging
(`lib/logging/` + `src-tauri/src/logging/`), crash reporting (`src-tauri/src/crash/`),
connector heartbeats, Anthropic usage tracking, **frontend** perf timing
(`lib/perf/` — W3C marks, PerfHud, React.Profiler), and a `dial9-tokio-telemetry`
flight-recorder writing binary async traces to `<data_dir>/cognia/traces/`.

What was missing was a *live, Rust-runtime* view: how much CPU/memory the Rust
process tree uses right now, how loaded the Tokio runtime is, and which backend
operations are the slow ones. This ADR adds that view.

## Decision

A new Rust subsystem `src-tauri/src/perf/` plus a dedicated, Task-Manager-style
`/performance` route (guild-rail entry).

### Three data layers

1. **Process tree** (`perf/process.rs`) — `sysinfo` (the already-present `0.33`
   dep, `system` feature) samples the current PID plus every descendant
   (parent-PID walk), classified as `main` / `sidecar` (Node `claude-host.mjs`) /
   `child`. CPU is reported both raw and normalized to a 0–100 scale; disk I/O is
   derived as bytes/sec from the sampling interval. Reuses the
   `crash::system_info::gather()` host snapshot.
2. **Async runtime** (`perf/runtime.rs`) — Tokio `RuntimeMetrics` off
   `Handle::current().metrics()` (full surface available because
   `.cargo/config.toml` sets `--cfg tokio_unstable` for dial9). Headline is
   **worker busy %**, computed by diffing the monotonic per-worker busy
   durations against the previous sample.
3. **Span hotspots** (`perf/registry.rs` + `perf/span.rs`) — an opt-in,
   process-global metrics registry. Each instrumented span name accumulates
   count / errors / total / min / max plus a fixed **log-bucket histogram** for
   approximate p50/p95 (dependency-free, fixed-size — memory bounded by the
   small curated name set). Instrumentation is `crate::perf::guard("name")`
   (RAII, records on drop) / `timed(name, fut)` / `record(name, elapsed, ok)`,
   seeded at curated boundaries (`claude.send`, `ocr.extract`, `vector.query`,
   `connector.ws_send`, …) since Tauri has no generic command middleware.

### Sampler & transport

`perf/sampler.rs` composes the three layers into a `PerfSample` and emits it on
`perf://sample` ~1 Hz. The loop is **ref-counted**: started by
`perf_start_sampling` on panel mount, stopped by `perf_stop_sampling` on unmount
— so there is no sampling overhead while the panel is closed (the same model
Windows Task Manager uses). A bounded ring (`RING_CAP = 120`) backfills a freshly
opened panel's rolling graphs. Commands: `perf_snapshot`, `perf_start_sampling`,
`perf_set_interval`, `perf_stop_sampling`, `perf_hotspots`, `perf_reset_hotspots`,
`perf_system_details`, `perf_list_traces`, `perf_open_trace_dir`.

### Frontend

- Data layer: `lib/perf/backend/{types,commands,format}.ts`; live hook
  `hooks/perf/use-perf-stream.ts` (start → backfill → subscribe → rolling
  window; pause freezes the UI without stopping the backend).
- UI: `components/performance/` — `performance-dashboard.tsx` (four tabs:
  Overview graphs · Processes · Hotspots · Async Runtime), `perf-graph-card`,
  `perf-metric-tile`, `perf-overview-tab`, `perf-process-table`,
  `perf-hotspots-table`, `perf-runtime-tab`, `perf-toolbar`. Recharts +
  `useThemeColors`, matching `components/logging/log-stats-dashboard.tsx`.
- Route `app/performance/page.tsx`; guild-rail auxiliary entry; i18n under
  `performance.*` (en + zh-CN). Desktop-only: web/mobile renders an inert
  explainer.

### Explicitly rejected

- **In-process CPU sampling profiler / flamegraph.** On Windows, signal-based
  samplers (`pprof-rs`) are unavailable and carry safety/overhead risk. Instead
  the panel surfaces the existing dial9 flight-recorder trace files (open-folder
  affordance) for offline analysis and relies on the span hotspot table for live
  attribution.

## Consequences

- New per-operation visibility makes backend hotspots findable without an
  external profiler; the span layer is opt-in, so coverage grows incrementally
  as more boundaries are instrumented.
- The registry and process/runtime samplers are runtime-agnostic, so
  `cognia-server` (headless) can expose them later without rework; only the
  `app.emit` sampler is desktop-app-gated.
- Span recording is two `Instant::now()` calls plus a tiny mutex section —
  intended for coarse boundaries only, never inner loops.

## 2026-08-13 capability and evidence upgrade

`/performance` is no longer a desktop-only sampler view. It is a diagnostic
workspace with two deliberately separate source classes: the local Renderer
document and the selected execution host. Each source publishes a versioned
descriptor, capabilities, build/profile marker, independent clock origin and an
explicit connection state. Web and mobile therefore retain Renderer metrics and
encrypted captures offline; Rust/Tauri and Node/headless host sections appear
only when the selected host advertises them. Unsupported metrics are absent, not
zero.

Sampling ownership is a `PerfLease`. A visible live consumer or explicit capture
opens and heartbeats a lease; normal hide/unmount closes it immediately. Only an
abnormally disconnected remote device may retain demand until the fixed 15-second
TTL. The host admits a minimum 500 ms cadence, one live and one capture lease per
device and 16 leases per host, runs one physical sampler at the fastest admitted
cadence, and down-samples per lease. Frames carry immutable target/routing,
source/session/sequence, requested and actual interval, monotonic time, missed
ticks and reset/discontinuity flags. Event subscription precedes open/snapshot;
late target generations are rejected and sequence loss becomes a persisted gap.

Captures are target-database evidence with account-wide quota coordination. The
target schema v160 stores structural rows, AES-GCM chunks, attachments and gaps;
the account registry v2 stores conservative quota reservations and encrypted,
immutable named budget profiles. The performance domain key is separate from
evaluation artifacts. AAD binds account, target database, capture, ordinal and
content type, and the account-security generation is checked after WebCrypto and
inside the destination transaction. Plaintext contains structural IDs, state,
timestamps, sizes, capability bits and digests only; source/build/environment,
numeric data, names and budget snapshots stay encrypted.

`.cognia-perf` v1 is the sole full-fidelity portable format. Import validates
paths, duplicates, entry count, MIME, sizes, hashes, schema and P-256 signature
before a second-pass invisible `importing` transaction becomes `ready`. Default
exports reuse crash redaction plus performance pseudonymization and exclude trace
bytes. Raw export requires an unlocked account and a second confirmation bound to
the capture digest and explicit attachment selection. Imported evidence gets a
new local ID and retains immutable origin digest/scope/trust provenance.

The information architecture is Overview, Diagnose, Resources and Captures;
existing process, managed, hotspot, runtime, system and `perf.panel` plugin
surfaces remain nested within it. Captures continue across navigation and are
controllable from the desktop status bar or mobile safe-area shell. Comparison
uses one value per valid interval and always reports median, type-7 p95, MAD,
absolute and percent delta. Budget verdicts additionally require 10 valid
intervals, 90% coverage, matching definition/unit/source/schema/cadence,
continuous incarnation, an immutable selected budget and matching environment
unless the environment mismatch is explicitly recorded.

Normal production retains lightweight Renderer instrumentation without React
profiling. `pnpm build:profile` runs `next build --profile`, marks and moves the
static artifact to `out-profile/`; Tauri always consumes `out/` and its packaging
preflight rejects a profiling marker.
