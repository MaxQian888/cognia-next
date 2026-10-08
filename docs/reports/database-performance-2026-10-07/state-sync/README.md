# Companion unread-state performance — 2026-10-07

Retained: one per-slice map of maximum pending readThrough by session replaces one full pending-queue reduction for every incoming row. Existing read/unread choice ordering, queue scope filtering, transaction, schema, apply slices, cursor and tombstones remain unchanged.

## Native IndexedDB + actual encryption middleware result

| Incoming rows / valid queued jobs | Baseline median (MAD) | Result median (MAD) | Change                         |
| --------------------------------- | --------------------- | ------------------- | ------------------------------ |
| 20 / 20                           | 2.2 ms (0.2)          | 2.0 ms (0.2)        | Within noise; no speed claim   |
| 200 / 200                         | 8.6 ms (0.5)          | 8.7 ms (1.2)        | Within noise; guardrail passes |
| 1,000 / 5,000                     | 259.8 ms (3.3)        | 214.7 ms (3.2)      | **45.1 ms / 17.36% faster**    |

Two warmups plus 15 measurements per variant, alternating baseline/current on the same machine and browser; five 200-row slices for the stress workload. Each dataset includes another 20% foreign/unrelated jobs. The 5,000-job workload represents a synthetic offline backlog stress case, not observed production prevalence. Stress improvement exceeds both predeclared 10% and 2× larger MAD (6.6ms). Small and ordinary cases do not regress beyond the joint practical/noise rule. Baseline/results compare exact stored rows and handler outcome, deleted-row absence, cursor and unchanged queue count after every sample.

Chrome 151 native IndexedDB on macOS, hardwareConcurrency 14. Minified production-style esbuild bundles actual handler, base scheduler, `createEncryptedContentMiddleware`, `AccountContentCipher.fromRawKey` and existing table policies. Database injection provides an isolated Dexie database using the exact current schemas of the two touched tables; no user database or credential accessed. Ephemeral AES-GCM keys generated per dataset. The actual governance policy encrypts `sessionState`; `mobileOutboundQueue` is metadata-only, exactly as in the application. No library middleware implementation was changed.

Primary metric is syncSessionState pull/apply completion with a local deterministic transport. This does not measure real remote network, UI rendering, Tauri/WKWebView, Capacitor device behavior, other sync handlers or end-to-end reconnection. No p95 or retained-heap claim is made. Complexity becomes O(pending + incoming) instead of O(pending × incoming); extra map size is bounded by distinct pending-read session IDs already represented in the existing latest-choice map.

## Evidence and reproduction

- `contract.md`: preregistration and middleware amendment.
- `baseline-session-state.ts.txt`: exact pre-edit production source.
- `encrypted-map.json`: primary raw 90 samples and browser identity.
- `metrics.json`: median/MAD arithmetic.
- `source-hashes.json`: SHA-256 of source/baseline; `environment.json`: host identity.
- `pre-edit.json`: preliminary plaintext baseline only.
- `plaintext-diagnostic.json`: diagnostic plaintext paired run; excluded from claims (middleware omitted and overlapping CPU work).
- `inventory.md`: source-inspected other state synchronization paths and deferred candidates.

Run from repository root:

```sh
rtk node docs/reports/database-performance-2026-10-07/state-sync/build.mjs
rtk python3 -m http.server 8768 --bind 127.0.0.1 --directory /tmp/cognia-state-sync-benchmark-2026-10-07
rtk agent-browser --session cognia-state-sync-perf open http://127.0.0.1:8768
rtk agent-browser --session cognia-state-sync-perf eval 'window.runBenchmark()'
rtk agent-browser --session cognia-state-sync-perf wait --fn 'window.benchmarkResult || window.benchmarkError'
rtk agent-browser --session cognia-state-sync-perf eval 'window.benchmarkResult || window.benchmarkError'
rtk agent-browser --session cognia-state-sync-perf close
```

The HTTP server/browser and synthetic databases are isolated. Successful samples delete their database in finally; do not run concurrent builds/benchmarks when comparing timings.

## Correctness validation

`rtk pnpm exec jest lib/sync/handlers/session-state.test.ts --runInBand --silent` → 1 suite, 12 tests passed (0.896s); raw `correctness.log`. New cases cover highest read watermark surviving a newer lower snapshot, timestamp/clientSeq ties, different sessions, nonnumeric/missing watermarks. Existing cases cover newer Host messages, pending unread, read/unread ordering, legacy rows, scope exclusion and manual-unread coverage. `rtk git diff --check -- lib/sync/handlers/session-state.ts lib/sync/handlers/session-state.test.ts` passed. Broader lint/types/orchestrator validation is performed by the parent task and reported there.
