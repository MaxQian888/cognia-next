# Notification delivery retention — rejected experiment

Completed 2026-10-08. **No production change retained.**

Actual renderer/headless retention sweeper calls the notificationDelivery executor, which invokes the full `pruneNotificationDelivery` measured here. The experiment replaced per-publication equality reads with bounded 200-key anyOf cursor scans and a Set of whole-intent publication IDs, preserving the existing transaction. No schema/durability/privacy setting changed.

| Publications  | Baseline median ± MAD ms | Candidate median ± MAD ms |       Change |
| ------------- | -----------------------: | ------------------------: | -----------: |
| 20            |                 4.8 ±0.1 |                  4.3 ±0.1 | 10.4% faster |
| 100           |                16.0 ±0.3 |                 13.1 ±0.2 | 18.1% faster |
| 1,000 primary |               153.2 ±4.6 |                177.3 ±9.3 | 15.7% slower |

Primary regression24.1ms exceeds2×maxMAD18.6ms. **Reject** despite small-case gains. Encrypted cursor scans perform different request/transaction-hold work from equality query reads; that is a possible explanation, not independently established attribution. No alternative candidate was attempted.

Native Chromium/WebCrypto/IndexedDB, minified actual owner, current production encrypted-content middleware and policies. Intents encrypted-content; publication/attempt/timer/member tables metadata-only.2warmups+15measurements per variant/size, AB/BA, same disposable database/key and reset outside timing. Standalone pre-edit baseline182.3±24.7ms is saved but paired results above govern verdict. System/browser warmup differences make comparing standalone and paired groups inappropriate.

Each measured operation verified exact full reports, all five remaining table contents against baseline, idempotent zero-change second prune, and sealed raw intent content. Fixtures cover compacted, queued, uncertain, newly compacted, mixed and unrelated references; recent/open/cutoff publications and other ledger cleanup work. This is a maintenance-backlog fixture, not whole startup or full retention sweeper timing.

`red.log`: performance regression test failed correctly (205 reference lookups vs2 target),10 behavior tests passed including injected failure after publication deletion and successful retry. The failed performance-only budget test was removed with the candidate. The atomicity test is independently useful and retained; final focused test run is coordinated by root. No coverage or device validation claimed.

Reproduce with `rtk node docs/reports/database-performance-2026-10-07/round-3/retention/build.mjs` (baseline) or add `--saved-candidate` for the rejected paired variant, serve `/tmp/cognia-retention-benchmark-2026-10-08` on8878, then isolated agent-browser invokes window.runBaseline()/runBenchmark(). Production source is restored to its recorded baseline hash; candidate source snapshot remains an experiment artifact only.

Evidence: contract.md, baseline.ts.txt, candidate.ts.txt, source-hashes.json, baseline.json, paired.json, metrics.json, red.log. Browser/server cleanup recorded separately. No provider calls/user database/network deliveries.

Cleanup: isolated agent-browser session retention-perf-20261008 closed; owned HTTP server8878 stopped after results capture. Temporary bundle retained for reproducibility, no running workload.
