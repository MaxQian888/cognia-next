# Account sync outbox experiment — 2026-10-07

Production change is limited to `lib/account-sync/data/pusher.ts`: select at most 512 eligible outbox entries before materializing them. The normal case keeps Dexie's unfiltered bulk-read path; only a round with oversized skipped rows uses a cursor filter, before the limit. Encryption, signatures, ordering, revisions, acknowledgments, maximum push size and wire shape remain unchanged.

## Complete local CogniaDB/fake-indexeddb path: rejected latency claim

One warmup followed by 10 measured samples per implementation,2048 captured-equivalent session rows, real WebCrypto encryption/signing, full production `pushOutbox` through acknowledgments. Fixture seeding and exhaustive decrypted-content verification are outside the timed interval.

| Metric                               |     Baseline |       Result |
| ------------------------------------ | -----------: | -----------: |
| Full drain median                    | 29839.735 ms | 30990.396 ms |
| MAD                                  |   337.401 ms |   216.105 ms |
| Selected outbox objects materialized |         9216 |         3840 |
| Largest selection result             |         2048 |          512 |
| Ops pushed                           |         2048 |         2048 |
| JSON array wire bytes                |      1317603 |      1317603 |

**The latency experiment failed its predeclared threshold: median 3.856% slower, not a speedup.** Raw data are `baseline.json` and `result.json`; summary is `metrics.json`. All samples retained identical plaintext id/title digest, exact contiguous device sequences, wire bytes and empty settled outboxes. The object reduction is 58.33%; it is a structural observation, not a latency claim.

The initial 8192-row pilot was stopped without a completed sample after over 2 minutes. Before baseline results or source optimization, the workload was reduced to 2048 and untimed setup seeded from one genuinely captured row. The full history is recorded in `contract.md`.

## Phase-shift diagnostic: neutral paired effect

Result samples changed from 26.2–26.5 s initially to 30.9–31.3 s later. A separate diagnostic alternated original/current in one process, with one warmup each then three measured pairs. This diagnostic does not replace the rejected 10+10 experiment.

| Pair |     Original |      Current | Current duration change |
| ---- | -----------: | -----------: | ----------------------: |
| 0    | 34131.507 ms | 34159.435 ms |                 +0.082% |
| 1    | 33877.648 ms | 34003.831 ms |                 +0.372% |
| 2    | 33226.954 ms | 33259.474 ms |                 +0.098% |

The median paired effect is approximately 0.098% slower. Both implementations were now 33–34 s, supporting elapsed runtime/machine drift as a confounder in the grouped comparison; no precise cause or fake-runtime speedup is claimed. Raw data are `diagnostic-paired.json` and `diagnostic-metrics.json`.

## Separate native browser result

The parent experiment in `../browser-metrics.json` used native Chromium IndexedDB and WebCrypto, production `pushOutbox`, minimal governed stores, and 8192 title updates, alternating ten baseline/result samples. Median 1351.15→1009.80 ms, MAD 6.35→3.10 ms: **25.26% improvement**, beyond both its 10% practical threshold and 2 MAD noise rule. All 8192 ops were decrypted and verified;3859933 wire bytes were unchanged. Native 1/300-row guards showed no material regression.

The production change is supported by this separate native IndexedDB result, not by the rejected fake-indexeddb timing. It is not a measured gain for default production users: account sync is still flag-gated and off by default in production. Neither fixture includes a physical network, at-rest account encryption, full UI refresh, Tauri or Capacitor. Parent report owns the native experiment contract and evidence.

## Correctness and reproducibility

- New deterministic bounds cases:1,300 and 600 rows. The 600 case failed against original source with `Expected <=512; Received 600` (`bounded-read-before.log`) and passed after the change.
- New oversize starvation case:513 oversized rows before a valid tail; shared read fixture avoids storing 300 MiB. Oversized rows remain queued and the valid tail is sent.
- Existing tests preserve writes changed during in-flight pushes, retry after lost acknowledgment, sequence continuity, deletes, unknown-field resend and full sync integration.
- Focused run: `rtk pnpm exec jest lib/account-sync/data/pusher.test.ts lib/account-sync/data/sync.integration.test.ts lib/account-sync/data/sync-round.test.ts --runInBand` —37 passed,1 optional benchmark skipped; see `correctness.log`.
- Focused ESLint and `git diff --check` passed. Broader repository gates belong to the parent report.

Reproduce the short paired diagnostic with `rtk proxy node docs/reports/multi-device-performance-2026-10-07/account-sync/run-diagnostic.mjs`. The runner creates original source from `baseline-pusher.ts.txt` in a unique OS temporary directory, imports it only in the opt-in test, and removes only its own temporary directory afterward. No frozen `.ts` module remains in the docs or app compilation graph. `--smoke` verifies the loader with one row and no measured samples; that smoke passed (`diagnostic-loader-smoke.log`).

The full current-path timing uses `rtk proxy env ACCOUNT_SYNC_BENCHMARK=result pnpm exec jest lib/account-sync/data/pusher.test.ts --runInBand --testNamePattern='performance experiment'`. The label controls the report filename; it does not select old source. To reproduce original source use the diagnostic runner with `ACCOUNT_SYNC_BENCHMARK_SOURCE=baseline`, `ACCOUNT_SYNC_BENCHMARK_SAMPLES=10` and a new `ACCOUNT_SYNC_BENCHMARK` filename label. No wall-clock CI threshold is added.

The wider read-only path inventory and unmeasured candidates are in `inventory.md`.
