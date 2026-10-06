# Renderer performance diagnostics

Date: 2026-10-05. Status: implemented in the working tree; additional browser collection defaults off.

## User-facing result

`/performance` → Overview now includes Browser diagnostics. Its master switch and independent Resources, Interactions, Frame gaps, and Navigation switches persist locally and synchronize across tabs. Enabling a group starts measurement only while the existing panel, HUD, or capture holds sampling demand. The new module supplies optional browser observations to the existing renderer collector; it does not create a second timer or animation loop.

The metric catalog adds eleven chartable observations, also available to the existing capture comparison and budget tools:

| Area             | Added information                                             |
| ---------------- | ------------------------------------------------------------- |
| Main thread      | Longest task; sum of each task's duration beyond 50 ms        |
| Memory           | JS heap used / reported heap limit                            |
| Frame timing     | Frame-gap p95; number of visible gaps over 50 ms              |
| Resource loading | Count, duration p95, browser-visible transfer bytes           |
| Event timing     | Sampled event count, input-delay p95, processing-duration p95 |

The navigation summary separately shows DNS, connection, TLS, request-to-first-byte, response download, DOM interactive, DOMContentLoaded, and load-complete timings. It describes the current document, not each client-side route transition. Clearing navigation does not erase unrelated interval measurements.

The three main-thread/heap additions reuse the existing demand-scoped collection. The new master switch controls the four additional browser groups; it does not disable the existing FPS, long-task, or heap collectors. Values stay local and can be included in explicit performance captures; these additions do not enable telemetry reporting.

## Measurement boundaries

- Missing, disabled, failed, or unsupported measurements are null, not zero. Current tiles do not fall back to an older value when the latest interval is unavailable; historical graphs/captures remain.
- Event Timing uses a 16 ms observation threshold. Counts describe individual sampled event entries, not all interactions; their p95 is not INP.
- Resource bytes include only fields the browser exposes. Zero transfer bytes alone do not establish a cache hit. Cross-origin restrictions and native transports prevent this from representing total network traffic.
- Frame gaps exclude hidden-window intervals. The 50 ms slow-frame definition does not assume a particular display refresh rate. Task blocking excess is an interval diagnostic, not Lighthouse TBT.
- Resource, event, and frame timing buffers retain at most 500 scalar samples per interval. Above that limit, p95 is unavailable; counts and observable byte totals remain intact. Percentiles use the existing type-7 implementation.
- Turning off a group disconnects its optional observer and rejects queued callbacks from older generations. Frame-gap collection reuses the existing FPS loop and stops accumulating on opt-out. Target/routing changes discard pending optional observations before they can enter a new capture scope.
- No resource URLs, DOM targets, selectors, or input content are retained. No fetch monkey patch, remote exporter, dependency, Next API route, or Rust command was added.

## Verification

- 107 tests passed across ten focused suites: collectors, metric catalog, capture analysis/controller, HUD, stream hook, overview, dashboard, and browser diagnostics panel.
- Changed-file ESLint and Prettier passed. Bilingual generation, key parity, and hard-coded-string checks passed. Read-only wiring, i18n, and co-located-test audits completed; their routing-reset finding was fixed and regression-tested.
- A local Chromium harness used the actual collector, diagnostics module, controls, overview, and charts. It observed a local resource (3.7 ms, 332 visible bytes), a deliberately slow input handler (85 ms longest task), navigation milestones, and frame timing. These are integration evidence from a development fixture, not Cognia performance benchmarks.
- Browser checks confirmed default-off behavior, independent resource opt-out with frame measurements continuing, master opt-out producing null optional observations, reload persistence, and Chinese layout at 390 px without horizontal overflow.
- The harness substitutes only theme-color and generic class-name helpers to avoid unrelated app bootstrap dependencies. It does not exercise account gates, real host transport, encrypted capture persistence, or native WebViews. Capture integration is covered by focused tests.
- Full repository TypeScript was attempted and remains blocked by unrelated CLI/agent, identity-test, and push-timer errors. No diagnostics were reported in this change's performance files. A full application production build and Tauri/Capacitor device validation were not completed.

## Sources

- [W3C Resource Timing](https://www.w3.org/TR/resource-timing/) — observable transfer sizes and cross-origin restrictions.
- [W3C Event Timing](https://www.w3.org/TR/event-timing/) — observer threshold and input/processing timestamps.
- [W3C Navigation Timing Level 2](https://www.w3.org/TR/navigation-timing-2/) — document navigation phases and milestones.
- Existing implementation contract: `docs/content/docs/en/adr/0035-rust-performance-dashboard.md`.
