# Native database experiment — rejected, no production edit

Measured on 2026-10-07: Apple M4 Pro, 48 GiB, macOS 26.5.2, Rust 1.96.1, bundled SQLite 3.50.2. Synthetic transcript content through the actual owning Rust dispatcher and production SQLite store, isolated release binaries, temporary APFS databases, WAL `synchronous=FULL`. The store is a Claude SDK transcript mirror, not the app's canonical conversation database.

The candidate removed the second deep copy in `dispatch::run("append")`: the already-owned input array can be borrowed by `SessionStore::append`. Both source variants were frozen in this directory. No production source was edited.

## Results

Median ± MAD in milliseconds, 10 samples per variant, AB/BA cohorts with one warmup per cohort. Full raw values and process RSS are in `results.json`; `0-before.log` through `3-before.log` hold operation output and `/usr/bin/time -l` metrics.

| Workload                                       |           Before |        Candidate |        Change | Decision                             |
| ---------------------------------------------- | ---------------: | ---------------: | ------------: | ------------------------------------ |
| **Primary: commit 20,000 new × 4KiB messages** | 568.315 ± 20.910 | 565.594 ± 24.578 |  0.48% faster | Within noise; fails ≥10% requirement |
| Commit 100 new messages                        |    1.655 ± 0.046 |    1.516 ± 0.053 |  8.39% faster | Below practical threshold            |
| Commit one new message                         |    0.162 ± 0.008 |    0.171 ± 0.010 |  5.55% slower | Within noise                         |
| Replay 20,000 already mirrored messages        |   63.632 ± 0.649 |   49.178 ± 1.157 | 22.72% faster | Secondary observation only           |
| Replay 100 messages                            |    0.294 ± 0.009 |    0.232 ± 0.004 | 21.00% faster | Secondary observation only           |
| Replay one message                             |    0.028 ± 0.002 |    0.025 ± 0.004 | 10.39% faster | Within noise                         |

**Decision: rejected for this experiment.** Fresh-batch committed latency was registered as the primary metric and did not improve meaningfully. The faster replay and reduced peak process RSS do not justify changing the primary metric after measuring. A separate replay-focused experiment could be registered for a demonstrated replay-heavy user path, but no such production claim or change is included here.

Process peak RSS samples: baseline 434,192,384 / 516,702,208 bytes; candidate 392,642,560 / 392,658,944 bytes. These are whole-process peaks including fixture construction, SQLite and equality checks, not app memory. Database/WAL bytes match exactly between variants at all three sizes; 20,000-row case is 95,309,824 / 95,909,512 bytes. Each sample asserted committed count, duplicate replay count zero, and exact complete transcript equality. No source correctness change was kept, so no broad native test suite was claimed or required by this rejected experiment.

## Scope

The timed region includes actual private dispatch `run`, JSON-array copy (baseline), real SQLite append and response construction. It excludes outer `dispatch_host_rpc` ownership copy, IPC/network serialization, rendering, provider and device startup. It proves a native-layer diagnostic result, not complete chat latency. OS caches were warm; shared-machine power/thermal state was not pinned; no p95 claim is made.

See `inventory.md` for the native conversation, replay, sync bridge, idempotency, job, profile and automation ownership map. No real user content/database was accessed, no native schema was changed, and no durability setting was relaxed.

## Reproduce

```sh
rtk python3 docs/reports/database-performance-2026-10-07/native/measure.py
```

This builds before timing and creates/removes only a new owned temporary build directory and synthetic fixture databases. It overwrites local evidence files in this report directory. The rejected candidate is created from the exact current dispatcher by a checked two-line text transformation; if that seam changes, the script deliberately refuses to proceed.
