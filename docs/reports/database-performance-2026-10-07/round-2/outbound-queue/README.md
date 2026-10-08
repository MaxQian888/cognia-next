# Outbound queue experiment — started 2026-10-07, completed 2026-10-08

**Verdict: removed.** No production source change retained. The source hypothesis was plausible but the actual native database guardrails rejected it. Baseline source is byte-identical to restored production source (see source-hashes.json).

| Workload / rows         | Baseline median (MAD) | Candidate median (MAD) | Verdict                   |
| ----------------------- | --------------------- | ---------------------- | ------------------------- |
| Small / 10              | 0.4ms (0.1)           | 0.3ms (~0)             | Within 0.2ms noise rule   |
| Typical backlog / 1,000 | 5.1ms (0.2)           | 4.4ms (0.1)            | 13.7% faster in this case |
| Stress backlog / 5,000  | 21.0ms (0.5)          | 23.4ms (0.6)           | **11.4% slower; reject**  |
| Foreign-heavy / 5,000   | 20.6ms (0.6)          | 23.4ms (0.6)           | **13.6% slower; reject**  |

Each case: 2 warmups and 15 samples per variant, native Chromium 151 IndexedDB, same synthetic DB, alternating order, minified real production function. Actual encryption middleware and account cipher installed with unchanged governance policy (mobileOutboundQueue is metadata-only). Baseline standalone measured before editing; paired before/after measured after the edit. Root coordinated exclusive timing window.

User-path metric: the five `listByStatus` calls used by OutboundQueueSheet, followed by its flatten/global createdAt+id sort. This excludes UI rendering, real transport and native mobile shells. Dataset includes 1KiB payload/job, timestamp ties, foreign account/target, and quarantined legacy target visibility. Exact complete ordered rows matched independent scope/order expectation after every sample. Database row count unchanged. The largest fetched JSON extent was 6,310,734 bytes (5,000 rows); foreign-heavy returned only 50 rows while fetching 5,000 (6,288,484 bytes), so the candidate also increases transient retained foreign-row data. No peak-heap claim.

Change tested: moving the existing scope filter after the indexed range read/sort allowed a native getAll path but retained/sorted the full matching status sets, including foreign rows. Memory retention and extra sorting are plausible contributors, not independently proven attribution. Both the stress primary and foreign guardrail regressed beyond the predeclared practical/noise limits. Do not keep this change based only on the favorable 1,000-row case.

No schema, protocol, claim, retry, tombstone, cursor, data ownership or dispatch behavior changed. Two useful correctness tests remain to pin stable createdAt ties, null-scope listings, account/target exclusion, legacy deadletter visibility and nonmutation; their benefit is independent of performance.

## Evidence

- contract.md: preregistration and implementation refinement before edit.
- baseline.json: standalone baseline before production edit.
- result.json / metrics.json: raw paired samples and statistics.
- baseline-mobile-outbound-queue.ts.txt / rejected-mobile-outbound-queue.ts.txt: exact experiment variants; rejected source is evidence only.
- source-hashes.json: hashes including restored production source.
- benchmark.ts.txt / build.mjs: self-contained browser harness; after rejection the builder reads archived variants so reproduction still compares the rejected candidate rather than reverted production.

Reproduce from repository root:

```sh
rtk node docs/reports/database-performance-2026-10-07/round-2/outbound-queue/build.mjs
rtk python3 -m http.server 8769 --bind 127.0.0.1 --directory /tmp/cognia-outbound-queue-perf-2026-10-07
rtk agent-browser --session cognia-outbound-queue-perf open http://127.0.0.1:8769
rtk agent-browser --session cognia-outbound-queue-perf eval 'window.runBenchmark()'
rtk agent-browser --session cognia-outbound-queue-perf wait --fn 'window.benchmarkResult || window.benchmarkError'
rtk agent-browser --session cognia-outbound-queue-perf eval 'window.benchmarkResult || window.benchmarkError'
rtk agent-browser --session cognia-outbound-queue-perf close
```

Successful runs delete synthetic database fixtures in finally. Benchmark browser and HTTP server were stopped. No user data was accessed. API and payload/order parity does not establish Tauri/Capacitor UI or production performance.

Source context: ADR-0027 offline durable queue/cache, ADR-0116 host-state authority, ADR-0131 durable relay/idempotency. Callers inspected: lib/queue/outbound-queue.ts:getQueueSummary, components/mobile/outbound-queue-sheet.tsx live query, lib/sync/handlers/app-settings.ts:inFlightSettingKeys. claimNext and nextQueueWakeAt remain unchanged because ordering, superseded drafts and scopes require their own complete experiments.

Fixture note: the first trial did not include the preregistration's extra sent/failed rows; it covered the five visible statuses only. Those exclusion cases are included in the follow-up count-summary fixture and test. This limitation does not rescue the rejected performance result.
