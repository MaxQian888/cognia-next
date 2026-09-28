# Rust database and recovery measurements — 2026-09-26

This report covers the native `cognia-agent-state` SessionStore and `cognia-jobs` monitor recovery. It does not claim complete application recovery, real-user latency, power-loss resilience, or a fixed SQLite engine. The Claude store is a mirror: canonical CLI JSONL and the renderer/headless conversation state have separate recovery responsibilities.

## Changes

- Separate one read-only SQLite connection from the serialized writer. Long transcript loads and online backups use explicit read snapshots. One reader bounds concurrent large materializations; this is not an unbounded connection pool.
- Reserve writes with `BEGIN IMMEDIATE` before reading sequence/CAS state, so contention from another connection waits at transaction entry rather than failing during read-to-write promotion. Keep `synchronous=FULL` and the 5-second busy timeout; do not weaken durability for speed.
- Pin the backup snapshot before stepping the online backup so continued appends cannot repeatedly restart its copy.
- Reject malformed summary JSON instead of interpreting corruption as legitimate `null` data.
- Recover monitors with `WHERE status='waiting'` using the existing status index. Terminal history is no longer materialized or decoded during recovery, and malformed terminal conditions do not block valid waiting work.
- No schema migration and no real user database edits.

## Measurement method

Apple M4 Pro, 48 GiB, macOS 26.5.2 / Darwin 25.5.0, Rust 1.95.0, bundled SQLite 3.50.2. Local APFS files, production Rust store methods compiled with the workspace release settings. Fixture: 20,000 messages with 4,096-byte text plus metadata and 1,000 short conversations; database 95,760,384 bytes, WAL 4,466,112 bytes. This is synthetic content measured through real SQLite, not mocked query latency.

The final session comparison builds two small isolated test binaries from the baseline commit and current source, with the same dependencies/profile/benchmark. Builds finish before timed runs. AB/BA cohorts give 20 samples per variant (one warmup per cohort); raw values, medians and MAD are retained. Read/backup notification comes from inside the operation with its mutex/snapshot already held; the benchmark checks it is still active before append. Timing is not a flaky CI assertion. OS cache is warm; reopening a connection is not cold-storage startup.

Acceptance was registered before production edits: >=10% median gain and absolute change >2 times the larger MAD; standalone append/load regression must remain <=10% beyond noise. `contract.md` records the original experiment and review corrections. Shared-machine/power/disk load is not pinned, so medians/MAD characterize these local observations, not a confidence interval or production p95.

The earlier 2 ms sleep-based contention run was rejected as proof of overlap. The first synchronized exploratory run also coincided with local verification/build work and breached the tiny standalone-append guardrail; `exploratory-*.log` retains that result. The final comparison uses AB/BA with builds completed first. `reviewed-run-results.json` is the successful run before strengthening the continuous-write regression's test-only gate; the final run rechecks the exact resulting source.

## Final measured results

Milliseconds, median ± MAD. All raw samples are in `session-results.json` and `monitor-results.json`.

| Operation                                                 |               Before |               After | Median change | Verdict                                  |
| --------------------------------------------------------- | -------------------: | ------------------: | ------------: | ---------------------------------------- |
| Append during 20,000-message restore                      |     28.5555 ± 0.4769 |     0.1887 ± 0.0119 |       +99.34% | Accepted improvement                     |
| Append during online backup                               | 1075.7648 ± 226.8346 |     0.1887 ± 0.0188 |       +99.98% | Accepted improvement                     |
| Full transcript load                                      |     32.7365 ± 0.8839 |    32.9081 ± 0.6496 |        -0.52% | Within noise; no speedup claimed         |
| Open + retention + full load (warm OS cache)              |     45.1356 ± 1.5990 |    43.6689 ± 1.0673 |        +3.25% | Within noise; no speedup claimed         |
| Uncontended append                                        |      0.2310 ± 0.0295 |     0.2319 ± 0.0143 |        -0.41% | Within noise; no speedup claimed         |
| List 1,002 sessions                                       |      1.8617 ± 0.0405 |     1.8909 ± 0.0503 |        -1.57% | Within noise; no speedup claimed         |
| Online backup duration                                    | 1074.6574 ± 225.9157 | 873.9697 ± 124.0295 |       +18.67% | Within noise; no speedup claimed         |
| Concurrent full load duration                             |     31.5894 ± 0.3881 |    32.2176 ± 0.5395 |        -1.99% | Within noise; no speedup claimed         |
| Recover 8 waiting monitors among 100,000 terminal records |   213.8105 ± 20.9565 | 0.031292 ± 0.004229 |     +99.9854% | Accepted improvement; 12 samples/variant |

Peak test-process RSS: median of two process peaks 103.83 MiB → 106.46 MiB (+2.63 MiB, +2.54%). This is whole-fixture/test-process RSS, not application resident memory. Database/WAL sizes were identical across variants. Standalone load/append, list, and reopen guardrails did not show a regression beyond noise. Backup-duration variance is high; its apparent gain is not accepted.

Empty-monitor boot median: 0.013271 → 0.012625 ms (no material gain claimed). Small 16-history/8-waiting case: 0.046334 → 0.028250 ms. No schema/index storage overhead was introduced.

Frozen candidate module SHA-256: `59a926a98bcd274ad60a886ef76a97a493527803d8425b2edde668f22a83e7bc`. Baseline revision: `f28694466f3a1de25abe2c512385ceef54cce6de`.

## Correctness evidence

- Before the fix: concurrent external writer reproduced `sessionStore: insert: database is locked`; malformed summary was returned as `null`. Both new regression tests failed for these reasons before the change and pass afterwards.
- Real child-process termination while an uncommitted transaction has spilled data into WAL: acknowledged main/subagent/other-tenant records and summary survive; partial rows and summary mutation disappear; replayed UUID remains deduplicated; repeated reopen and `PRAGMA integrity_check` succeed.
- Actual SQLite `SQLITE_FULL` using `max_page_count` (not physically filling the disk): the whole failed batch rolls back, prior acknowledged history remains, retry succeeds, and reopen remains valid.
- Read-only connection rejects writes; a pinned read snapshot stays unchanged while another writer commits a complete batch; later load sees the new batch.
- Independent connections compete on summary CAS with exactly one winner.
- 100 restore/write cycles release their snapshots so WAL checkpoints complete. This simulates repeated lifecycle transitions, not a multi-day soak test.
- Backup is held at a pinned snapshot until another append commits, then released while the appender continues. Completion has a deadline, exhausting the safety cap fails the test, restored rows equal the original snapshot, integrity is checked, and subsequent checkpoint completes.
- Existing tests cover old-session retention, recent subagent/summary activity, tenant/workspace scope, replay, deletion, and rollback.

Validation: `agent-state-tests.log` reports 72 passed / 2 ignored manual benchmarks; `jobs-tests.log` reports 81 passed / 1 ignored manual benchmark. `clippy.log` covers both crates with `--all-targets -- -D warnings`. `sidecar-tests.log` reports 23 passed, and `recovery-jest.log` reports 19 passed across two crash-reconciliation suites. Scoped rustfmt and diff checks pass. Independent read-only review closed both measurement/test findings after synchronization and continuous-write assertions were strengthened; no actionable finding remains in the three edited Rust modules. No coverage was requested or run. Full Tauri/WebView, authenticated provider resume, Windows/Linux, physical disk failure and power-loss tests were not performed.

## SQLite engine upgrade remains blocked

The bundled SQLite 3.50.2 predates the upstream WAL-reset fix. SQLite documents possible corruption when separate connections race writes/checkpoints. This patch's added reader is strictly read-only, but that does not fix existing multi-process exposure. See [SQLite's WAL-reset documentation](https://www.sqlite.org/wal.html#walresetbug).

There is no published `libsqlite3-sys 0.35.x` patch. Existing Matrix 0.18 requires rusqlite 0.37, so upgrading just rusqlite conflicts on native `links=sqlite3`. Tested dependency resolution: rusqlite 0.40.2 + Matrix crypto/sqlite 0.19.1 + ruma 0.17. The resolver succeeds, but Rust 1.95 rejects Matrix's Rust 1.96 requirement (`sqlite-upgrade-blocked.log`). Matrix 0.19.0 has the same floor. The official release-0.18 branch at `1c44fb66214667c6d00acaf72ab592493653708b` still requires rusqlite 0.37. All attempted dependency edits were restored; `sqlite-upgrade-rejected-lock.diff` records the proposed resolution. A coordinated toolchain/Matrix upgrade or a maintained, tested backport is required; no engine fix is claimed here.

[Matrix dependency metadata](https://crates.io/api/v1/crates/matrix-sdk-sqlite/0.19.1/dependencies), [fixed bundled SQLite release](https://docs.rs/crate/libsqlite3-sys/0.37.0).

## Remaining boundaries

Large transcript load still returns the full SDK-required transcript and therefore remains O(total bytes); no truncation or lossy paging was introduced. Read operations serialize on one reader. First-open retention still scans indexed history. Native session stats currently count distinct session IDs without the complete scope, a pre-existing diagnostic limitation. Fleet recovery metadata uses a separate filesystem path; its per-save backup growth and best-effort fsync semantics require separate work. None of these receive an unsupported performance or durability claim.

## Reproduce

From repository root:

```sh
rtk python3 docs/reports/rust-database-2026-09-26/measure.py --out /tmp/cognia-session-store-repeat
rtk proxy cargo test -p cognia-agent-state --lib
rtk proxy cargo test -p cognia-jobs --release benchmark_monitor_boot -- --ignored --nocapture
rtk proxy cargo test -p cognia-jobs --release
rtk proxy cargo clippy -p cognia-agent-state -p cognia-jobs --all-targets -- -D warnings
rtk node --test sidecar/dispatch/session-store.test.mjs
rtk node_modules/.bin/jest lib/ai/agent/recovery/reconcile-crashed-runs.test.ts lib/ai/agent/recovery/recover-run.test.ts --runInBand --no-coverage
```

The benchmark runner uses macOS `/usr/bin/time -l` for RSS, builds in a disposable temp directory and removes only its own generated build tree. It retains raw logs, source snapshots/hashes and results under the chosen output path. It does not reset caches, open application databases, or modify source files.
