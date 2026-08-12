# Cognia Performance Measurement Matrix

Start from the end-to-end user outcome. Select layer tools only after the
baseline shows where to drill down, and always remeasure the original outcome.

## Contents

- [Main renderer and shared static bundle](#main-renderer-and-shared-static-bundle)
- [Tauri and Rust runtime](#tauri-and-rust-runtime)
- [Capacitor and mobile](#capacitor-and-mobile)
- [Storage, Dexie, vector, and local data](#storage-dexie-vector-and-local-data)
- [Sidecars, services, CLI, agents, and provider calls](#sidecars-services-cli-agents-and-provider-calls)
- [Docs and official Web workspace](#docs-and-official-web-workspace)
- [Plugin, WASM, worker, and heavy-asset paths](#plugin-wasm-worker-and-heavy-asset-paths)
- [Development and build performance](#development-and-build-performance)

## Main renderer and shared static bundle

Applies to the Next.js static export consumed by Web, Tauri, and Capacitor.

- Measure route readiness, interaction latency, long tasks, layout shifts,
  decoded JavaScript, heap, and the user action named in the experiment.
- Reuse `lib/perf/perf-marker.ts`, `lib/perf/profiler-boundary.tsx`, and
  `lib/perf/perf-hud.tsx` when their existing namespace and lifecycle fit.
- Reuse `lib/perf/chat-turn-performance.ts` for dispatch, first-response,
  streaming, persistence, and total chat-turn timing.
- Use a production build for runtime claims. Development React and Next.js
  behavior is diagnostic evidence, not a production result.
- Treat browser, Tauri WebView, and Capacitor as separate measurement
  environments. A browser-only result proves no mobile or desktop-shell claim.
- Note that `PerfHud` auto-enables in development, is opt-in in production,
  keeps bounded samples, clears observed entries, and is unavailable in
  Capacitor. Capture raw traces when its aggregation would hide the behavior
  under investigation.

Load `next-best-practices` before changing bundle boundaries, static export,
images, fonts, scripts, or `next.config.ts`.

## Tauri and Rust runtime

- Use the `/performance` panel for process-tree CPU, memory, disk I/O, Tokio
  runtime pressure, and curated span hotspots.
- Read `docs/content/docs/en/adr/0035-rust-performance-dashboard.md` and current
  `src-tauri/src/perf/` code before relying on an ADR detail; implementations
  can move while stable re-exports remain.
- Remember that sampling runs only while the panel is open and is approximately
  one hertz. It cannot resolve short inner-loop events.
- Add `perf::guard` or `perf::timed` only at coarse operation boundaries. Never
  instrument every iteration or create unbounded metric names.
- Measure release-like binaries for CPU, memory, and startup claims. Remeasure
  the renderer-visible user path after changing a Rust or IPC layer.

## Capacitor and mobile

- Measure on the named representative device or emulator with a mobile build;
  do not substitute desktop CPU throttling for a final mobile claim.
- Track startup, interaction latency, memory pressure, battery-sensitive CPU or
  polling, bridge calls, offline behavior, and asset loading as applicable.
- State OS, device model, build type, power mode, and thermal condition.
- Use remote WebView tooling or platform traces when available. If unavailable,
  report the surface as unverified instead of extrapolating from Web or Tauri.

## Storage, Dexie, vector, and local data

- Measure with a fixed representative database shape and record counts.
- Separate cold-open, migration, indexed lookup, scan, serialization, and UI
  rendering time. A faster query that moves cost into rendering is not a win.
- Track memory and storage growth alongside latency for indexes and caches.
- Load `dexie-migration` before any schema or index change. Preserve its version
  claim, upgrade, and test requirements.
- For vector or model-backed operations, pin corpus, model, dimensions, device,
  warmup state, and result-quality checks.

## Sidecars, services, CLI, agents, and provider calls

- Measure the end-to-end action plus internal queue, IPC, process startup,
  first-response, throughput, and persistence stages that the path exposes.
- Separate application latency from remote-provider and network variance. Pin
  provider, model, input, region, and network conditions when making a claim.
- Prefer existing logs, spans, conformance fixtures, and smoke commands. Add
  bounded instrumentation only when existing seams cannot distinguish the
  hypotheses.
- Verify cancellation, concurrency, backpressure, memory, and cleanup; a faster
  happy path that leaks a child process or task is a regression.

## Docs and official Web workspace

- Treat `docs/` as a server-mode Fumadocs app, not as the main static export.
- Treat `web/` as its own workspace and deployment surface. Use its existing
  evidence and capture scripts when they match the requested user path.
- Use Lighthouse, field data, or CrUX only for a real web origin and state the
  percentile, device segment, sample window, and URL population. Do not apply
  field metrics to Tauri or Capacitor sessions.

## Plugin, WASM, worker, and heavy-asset paths

- Measure initialization, compilation, worker startup, transfer size, decoded
  size, task latency, and retained memory as applicable.
- Inspect lazy-chunk and asset-loading behavior before changing import syntax.
- Preserve sandbox, capability, and cross-shell contracts; performance does not
  justify moving privileged or Node-only work into the renderer bundle.

## Development and build performance

- Reuse `rtk pnpm dev:analyze` for Next development trace, root compilation, RSS,
  heap, Turbopack cache, and optional browser snapshots.
- Disclose that `pnpm dev` runs `predev`, which downloads, copies, builds,
  cleans stale cache state, and generates artifacts. It is not filesystem
  read-only.
- Keep persistent-cache state, boot profile, requested route, and warm/cold
  state identical across comparisons.
- Measure production build and test performance with identical cache and
  dependency state. Never delete shared caches or generated outputs without
  explicit authorization.
- Treat faster checks achieved by skipping type, test, coverage, i18n, static
  export, or Rust gates as correctness regressions.
