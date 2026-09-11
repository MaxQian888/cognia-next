# Connectivity, synchronization, and transfer optimization

Date: 2026-09-11

## Problems addressed

- Transient signaling deadlines canceled the retry loop needed for recovery. RTC cleanup also left connection and binary promises pending.
- Late endpoint discovery and hydration could apply work belonging to an obsolete Host. Metadata refresh now has a separate guarded persistence path, and synchronization checks its captured Host generation and database before applying each slice.
- Message creation-time cursors missed edits to existing messages. Schema v226 introduces a local transactional revision clock and revision index; workflow pagination uses a compound activity index instead of repeatedly materializing and sorting the remaining history. The migration changes indexed metadata while preserving encrypted content.
- Independent sync invocations multiplied their per-run concurrency limits. The transport/Host now shares a six-pull budget and coalesces overlapping table invalidations into a trailing pull.
- A negotiated 64 KiB upload became approximately 87.5 KiB of JSON, exceeding the HTTP request limit. The exact upload-chunk route now allows 128 KiB; decoded chunk validation remains 64 KiB. Explicit HTTP 413 responses from older Hosts trigger a bounded retry at 32 KiB.
- Downloads waited at each four-request batch boundary. Four workers now refill continuously and drain in-flight requests before closing on failure or cancellation. Upload remains sequential under the existing offset protocol.
- Rust upload commit held a global registry lock during hashing and file publication. Commit now owns its upload outside that lock; blocking transfer I/O has a shared eight-task budget whose permits survive caller cancellation. A separate short publication lock protects the final existence check and rename: a regression with sixteen competing uploads previously produced sixteen successful commits to one path, and now produces exactly one winner.
- Resource preview, upload, and download operations now cancel on scope changes and ignore stale results. Source/Preview tab changes reuse the same content request.

## Controlled measurements

Each case used one warmup and ten measured samples. Values below are median milliseconds, with median absolute deviation (MAD). These are component-level fixtures on macOS Apple Silicon, not WAN or device measurements.

| Workload                     | Before median / MAD | After median / MAD | Result                           |
| ---------------------------- | ------------------: | -----------------: | -------------------------------- |
| Task download, variable RTT  |       668.70 / 2.30 |      363.31 / 5.57 | 45.67% less time                 |
| Media download, variable RTT |      880.39 / 53.83 |      358.23 / 1.68 | 59.31% less time                 |
| Task download, uniform RTT   |       249.51 / 3.14 |      257.69 / 4.22 | 3.28% more time                  |
| Media download, uniform RTT  |     538.69 / 113.64 |      200.92 / 3.37 | 62.70% less time; noisy baseline |
| Workflow sync page           |        31.70 / 4.88 |        1.80 / 0.62 | 94.33% less time                 |

Download fixtures use the actual TypeScript functions, a 2 MiB file, 32 chunks of 64 KiB, cyclic delays of 80/10/25/40 ms or a uniform 20 ms delay, and injected RPC transport. Guards verify identical bytes/checksums, at most four reads, and handle closure after the final read. The uniform task regression remains below the preregistered 10% guardrail.

The workflow fixture uses the actual cursor reader with fake-indexeddb, 4,000 runs, alternating running/completed states, and 1 KiB snapshots. The returned 200 IDs remain identical; the indexed query loads at most 201 candidates instead of 6,000 on this fixture. An intermediate filtered-index approach measured 67.33 ms and was rejected.

The message revision clock has a correctness cost. In a separate preregistered fixture using the actual middleware and 100 sequential updates per sample (one warmup, ten samples, alternating before/after arms), median time increased from 11.9300 ms (MAD 0.6488) to 21.6659 ms (MAD 0.9144): **81.61% more time**, or approximately **0.09736 ms extra per write**. This is a measurable regression, not a claimed speedup. The transactional clock prevents lost edits across concurrent writes, rollbacks, and restarts. The fixture excludes encryption and network costs; real-device streaming throughput and the one-time raw-row migration scan have not been measured.

## Evidence boundaries

- The hydration group passed 195 Companion tests and, after extending migration/credential/rollback cases, 52 runtime tests. `transport-companion.ts` measured 97.29% lines, 90.47% branches, and 97.95% functions. Both runtime modules now pass explicit per-file coverage gates: `account-runtime-target.ts` 100/96.84/100 and `target-registry.ts` 100/98.61/100 (lines/branches/functions).
- Synchronization regression runs passed 430 distinct tests across 17 suites. The new revision middleware passes its explicit per-file gate at 99.32% lines, 96.29% branches, and 100% functions. This does not establish whole-subsystem coverage.
- Other focused groups passed 145 RTC tests, 245 boot/metadata/controller tests, 123 transfer tests, and 39 resource-panel tests. The RTC, transfer, and resource-panel files passed their measured per-file coverage gates; protocol generation freshness and i18n build/parity/sort checks passed. Scoped ESLint and formatting checks passed on the final owned files.
- A TypeScript-to-Rust HTTP round trip transferred 262,151 bytes through the actual transfer registry and exact body-limit middleware: 14 HTTP 200 responses and matching SHA256.
- Thirteen isolated Rust regression tests passed using the actual transfer source and extracted middleware/I/O helper, including the final concurrent-publication fix. This does not substitute for compiling the complete Tauri application or testing its authenticated router.
- The actual resource component passed browser interaction checks with controlled data/transport dependencies: stale preview cancellation and Source/Preview request reuse. This is browser fixture evidence, not a paired-device acceptance test.
- Focused regression tests, per-file coverage, scoped lint, and protocol/i18n checks are recorded separately. Full lint exhausted Node's heap; full coverage and the full Rust build were interrupted under disk pressure. The final completed TypeScript run reported 18 errors in concurrent, out-of-scope CLI/settings/AI work and none in this task's files (`/tmp/cognia-connectivity-opt-20260911-parent/typecheck-last.log`, exit 2). A partial run is not a passing gate.
- No deployment, real-device reconnection, public-network throughput, or full Tauri build success is claimed. Production gains require the updated Host and client, except for the explicit old-Host upload fallback.

Raw local experiments and logs are retained under `/tmp/cognia-transfer-20260911`, `/tmp/cognia-sync-20260911`, and `/tmp/cognia-connectivity-opt-20260911-parent`.
