# Application operation performance collection

Date: 2026-10-05

## Behavior

The performance panel’s **Diagnose → Application operations** section adds a
persistent, default-off master switch and independent startup, storage, host-call
and network groups. Once opted in, operations are recorded even while the panel
and frame sampler are closed. No timer is added by the operation recorder.

The existing Overview charts, captures, comparisons and budgets consume five
new renderer metrics: completed count, duration p95, error count, cancellation
count and current in-flight count. Disabled collection produces missing values,
not measured zero. Starting a sampling demand discards completions from before
that interval, without discarding the operation table’s cumulative summaries.

## Instrumentation inventory

| Fixed operation            | Actual seam and timing boundary                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `startup.capability-probe` | Configured boot capability probe, through its complete result                                 |
| `storage.messages.load`    | Full/recent chat history query and conversion                                                 |
| `storage.messages.write`   | Transcript write queue wait and write-call completion; not the surrounding transaction commit |
| `storage.sessions.list`    | Full, workspace and scoped session lists                                                      |
| `transport.local.call`     | Dispatch through the routed local host call                                                   |
| `transport.remote.call`    | Dispatch through the routed remote host call                                                  |
| `network.browser.fetch`    | `createPlatformFetch` browser request through response headers                                |
| `network.tauri.fetch`      | Platform fetch native proxy, including buffered response                                      |
| `network.capacitor.fetch`  | Platform fetch mobile bridge, including buffered response                                     |

Host performance and telemetry calls are excluded to avoid self-measurement.
Rejected-before-dispatch routing checks and binary reads are outside this seam.
Network coverage is limited to callers of `createPlatformFetch`; this does not
intercept every fetch, provider stream or WebSocket. Nested operations overlap,
so adding their durations would overstate total elapsed time. Browser and native
request timings have different boundaries and must not be treated as equivalent.

The helper invokes the original callback synchronously and returns its original
promise or Dexie thenable. Disabled collection adds no promise observer. Errors,
responses and cancellation signals retain their original identity. HTTP
non-success responses count as errors without reading the body; AbortError
rejections count separately as cancellations. Existing Dexie transaction and
liveQuery scheduling remain intact.

## Retention, switches and isolation

- Only nine fixed names, numeric durations and outcomes enter the recorder. No
  URLs, request arguments, content or user/session identifiers enter snapshots.
- Settings use `cognia-operation-performance-v1` in localStorage; measurements
  stay in memory. Nothing is sent through telemetry by this feature.
- Counts are cumulative since clear. p50/p95/max use the last 120 valid completed
  durations per operation, including failures/cancellations. Last is the latest
  completion duration, or unavailable when the clock value is invalid.
- At most 256 operations may be observed concurrently. Exceeding the limit is
  shown explicitly. Each interval retains at most 500 durations; overflow makes
  p95 unavailable while scalar counts remain usable.
- Disabling a group clears its samples and invalidates pending completions.
  Clear, account/target/generation changes and account security barriers also
  invalidate pending operations. Reload clears all measurement history.
- Lazy preference restoration captures opted-in startup work before the panel
  mounts. Same-scope StrictMode effect replay preserves early measurements.
- Storage events synchronize settings across tabs. Unsaved local opt-outs cannot
  be overwritten by stale stored opt-in; stricter external opt-out still applies.
- Shared helpers remain inert without a browser window; no headless runtime is
  registered for this renderer-only recorder.

Existing summaries/recordings already captured through the performance system
retain their normal lifecycle. Turning this feature off does not delete saved
captures.

## Implementation placement

Existing probe, database, transport, renderer collector, catalog and dashboard
modules were extended. The new recorder is separate from browser diagnostics:
it follows operation completion rather than PerformanceObserver sampling demand,
and must retain useful data while the panel is closed. The new panel component
contains its independently subscribable controls and fixed-name table, avoiding
additional subscriptions and table logic in the dashboard owner.

## Validation

- 13 focused suites: **336 tests passed**. Includes enabled Dexie transaction
  rollback/liveQuery regressions, original promise/error identity, switch and
  scope invalidation, startup retention, StrictMode replay, bounded buffers,
  catalog extraction and sampling-demand interval boundaries.
- Focused ESLint, Prettier and diff whitespace checks passed.
- `i18n:build`, `i18n:build:check`, `lint:i18n` passed; English/Chinese split and
  generated messages agree. Read-only wiring, i18n and test-gap review completed.
- Real Chromium component harness used the actual panel, recorder, renderer
  collector, metric catalog and browser branch of platform fetch. Local requests
  produced 3 completions / 1 HTTP failure / 1 cancellation; a 75 ms synthetic
  storage operation made the sampled frame total 4 / 1 / 1. Disabling network
  cleared its row and prevented further network samples. Storage still recorded
  with the panel and sampler closed. Reload retained switch choices. Chinese
  390 px layout had no document overflow; its wide table scrolls internally.
- Harness-only substitutions: utility class merger, theme colors, table density
  settings, unused native proxy and telemetry transport. The storage button is
  synthetic; real DB semantics were tested in Jest. This is not a full-app,
  native-device, production build or deployment verification.
- Full TypeScript check ran and failed on **17 unrelated diagnostics** in CLI,
  external-agent tests, pairing story, identity tests and push notification
  timeout typing. None were in this change’s files. Log:
  `/tmp/cognia-operation-performance-types.log`.
- No coverage run and no commit made.

## Sources

- [Dexie transaction scope](https://dexie.org/docs/Dexie/Dexie.transaction%28%29)
- [Dexie Promise-local data](https://dexie.org/docs/Promise/Promise.PSD)
- [Dexie liveQuery](https://dexie.org/docs/liveQuery%28%29)
- [Fetch Standard](https://fetch.spec.whatwg.org/)
