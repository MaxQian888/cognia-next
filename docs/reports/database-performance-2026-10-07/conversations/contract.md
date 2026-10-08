# Conversation database experiment — preregistered 2026-10-07

- User path: workspace overview requests conversation/message totals through `countWorkspaceConversations`; secondary attribution metric is `listWorkspaceSessions`. This measures the complete database API call, not React rendering or an end-to-end UI claim.
- Hypothesis: grouping the session lookup and native message counts into one readonly transaction removes per-session transaction scheduling without changing visible conversations or message totals.
- Primary: warm database API duration (ms), 1,000 sessions across 4 workspaces, 20 workspace-less sessions, 20 messages per session. Embedded/subagent sessions excluded using the real exposure predicate. Each session carries a 2 KiB prompt; message parts carry 256 characters.
- Guardrail: single-conversation workload; median regression must be no more than max(10%, 1 ms). Identical counts, no writes, no schema/index changes, normal encryption and locked-account failures preserved. No storage growth permitted.
- Engine: agent-browser headless Chromium, real IndexedDB, real Dexie 4.4.6, actual account AES-256-GCM cipher and encrypted content middleware. Selected production function declarations are extracted from source and compiled by esbuild with NODE_ENV=production. This is a production-compiled query harness, not a full application build.
- Machine: Apple M4 Pro, 14 CPU cores, 48 GB RAM; macOS; power/thermal state not controlled. Revision `5f6760382213f58cf9614caa1c7d0f3ea90a9709` plus shared working-tree changes. No other agent timing workload during measured runs.
- Fixture isolated in a disposable benchmark database and browser session; no real profile data read or modified. Warmup 2 calls; measured samples 12 per workload, consecutive calls. Recreate identical fixture for baseline/result; do not delete application/browser caches.
- Statistics: median, MAD; retain only when primary median improves at least 10% AND absolute delta > 2 * max(before MAD, after MAD). Small-sample max recorded only as diagnostic, no p95 claim.
- Baseline command: `rtk node docs/reports/database-performance-2026-10-07/conversations/build-harness.mjs baseline`, serve temporary files over localhost, then `rtk agent-browser --session cognia-conversation-perf eval 'window.runBenchmark()' --json`. Result command uses `after`.
- Side effects: report files, temporary JS/HTML under `/tmp/cognia-conversation-perf`, disposable browser database, local HTTP listener. No application server launch or generated app assets.
- Correctness: existing session/message unit tests, new transaction/visibility regression tests, and real encrypted browser count equality. No wall-clock CI gate.
- Source ownership: only `lib/db/sessions.ts`, `lib/db/sessions.test.ts`; benchmark evidence lives here. Native Tauri WebView, Capacitor, mobile hardware, live account-sync networks and React rendering remain unverified.

## Second hypothesis, registered before measuring its result

The first count-only transaction experiment failed the retention rule (107.85 → 107.05 ms), so its source change was removed. A wider transaction around parallel encrypted cursor reads did not complete and is rejected.

The existing workspace-less fallback decrypts every session via a filtered cursor. Reuse the existing `projectId` index and table primary keys to identify rows whose workspace key is absent or empty; bulk-read and filter only those candidates. Keep one readonly transaction around this key-set lookup for a consistent set; the scoped read remains separate as before. Same primary metric, fixture, baseline, sample count and threshold apply. Extra correctness gates: missing/null/empty projectId, equal-timestamp ordering, workspace move and title-edit liveQuery invalidation. Single-conversation guardrail unchanged. No schema, cache or stored-row changes.

## Additional verification, declared before extra samples

Measure the complete `listWorkspaceSessions` API directly on both the original mixed fixture and a 1,000-session all-workspace-less fixture. Same 2 warmups + 12 measured samples and 10% / 2 MAD rule. The all-workspace-less case must not regress median by more than max(10%, 1 ms). Validate identical IDs/order against the in-memory fixture before accepting each sample. This adds no new performance edit. Allocation size is bounded by two primary-key arrays and a Set (O(total sessions)); returned session rows are unchanged. Peak JS/native crypto heap is not measured, so no memory improvement claim is made.

The first harness explicitly disabled Dexie's optional query cache. Final `production-baseline`/`production-after` pairs remove that override to match CogniaDB's actual `super(name)` constructor defaults. Rerun both primary and list guardrails under these identical defaults; retain earlier raw runs as diagnostic evidence only.
