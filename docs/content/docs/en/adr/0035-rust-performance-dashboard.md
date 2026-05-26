---
title: 0035 — Rust Performance Dashboard
description: A Task-Manager-style /performance panel backed by a Rust perf subsystem — live process-tree + Tokio runtime sampling plus an opt-in span hotspot registry — for finding backend performance hotspots.
---

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
