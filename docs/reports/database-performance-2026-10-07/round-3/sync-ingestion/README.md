# Session ingestion performance — 2026-10-08

Retained selective prior-row reads in `syncSessions`. Full ingestion of 1000 ordinary sessions improved from **62.2 ms to 43.9 ms (29.42%)** under the fixed native IndexedDB experiment. The 18.3 ms saving exceeds both the preregistered 10% threshold and twice the larger MAD (8.4 ms). This measures actual encrypted storage ingestion with deterministic transport, not the complete UI or network path.

## Cause and implementation

Companion critical-stage session sync applies incoming rows in existing 200-row slices. Previously each slice loaded and decrypted every previous session. `mergePortableManagedContext` consults local context only for incoming managed workspace bindings. The change requests only those IDs, maps their previous contexts by session ID, and calls the same normalizer and encrypted bulkPut. Ordinary rows skip the unnecessary read.

The empty-read case still awaits its result before `assertCurrent`, preserving the asynchronous scope fence. Duplicate IDs retain their original local pre-write context and their original incoming write order. Managed local-root ownership, missing-workspace normalization, upserts, tombstones, slices, pacing, cursors and durable state handling are unchanged. There is no schema change or retained cache. The maximum temporary map is bounded by one existing 200-row slice.

Research used the actual session handler, generic handler, messages handler, companion-sync registry and managed-workspace helpers, with ADR-0027 (persistent sync cursors), ADR-0116 (host-state authority), ADR-0111 (managed-workspace registry; proposed), and ADR-0144 (workspace identity/context). The messages handler already performs generic bulk writes; this change targets redundant session reads without altering the generic pipeline.

## Fixed experiment

[contract.md](./contract.md) records the hypothesis and decision rule. [baseline.json](./baseline.json) was captured before the production edit. [result.json](./result.json) contains the paired baseline/current samples and dataset extents; [metrics.json](./metrics.json) contains medians and MADs. Two warmups and 15 measured runs per variant per fixture were alternated in one Chromium 151 native IndexedDB browser session. The paired run contains 180 measured samples. Root serialized benchmark lanes; no power or thermal control was applied.

The browser bundle imports actual `syncSessions`, generic handler, scheduler, merge normalizer, content cipher and content-protection middleware. The fixture uses the exact current sessions indexes and the actual encrypted sessions policy. Only `getDb` is injected. Unrelated filesystem/store imports of managed-workspace are fail-fast stubs, while both measured pure normalizers remain original source. The isolated fixture excludes unrelated application observers/capture middleware. Seeding, result reading and comparison occur outside timing. The browser reports 14 hardware threads on macOS; raw user agent is retained.

Rows contain bounded titles, 120-character previews, eight disabled skill IDs and ordinary or managed execution contexts. Existing rows have different metadata; one in seven is absent. Managed data includes matching local roots and mismatched identities. Mixed input includes a duplicate managed ID. The largest input is 749661 JSON bytes. No production data was accessed.

| Workload                                         | Before median / MAD (ms) | After median / MAD (ms) | Interpretation                  |
| ------------------------------------------------ | -----------------------: | ----------------------: | ------------------------------- |
| 20 plain sessions                                |                1.7 / 0.1 |               1.1 / 0.1 | Small guard passed              |
| 200 plain sessions, one slice                    |               11.0 / 0.7 |               7.7 / 0.4 | Slice guard passed              |
| 1000 ordinary sessions                           |               62.2 / 3.4 |              43.9 / 4.2 | Primary: 29.42% improvement     |
| 1001 incoming rows, 101 managed, 1000 unique IDs |               65.4 / 5.8 |              47.9 / 5.1 | Mixed guard: 26.76% improvement |
| 1000 managed sessions                            |               66.0 / 3.3 |              65.4 / 1.8 | Within noise; no speedup claim  |
| 1000 ordinary sessions, empty previous data      |               41.9 / 1.1 |              36.5 / 0.8 | Cold guard passed               |

Every guard meets the rule: no regression exceeding both 10% and twice the larger MAD. The primary prior-row request count falls from 1000 to zero; mixed falls from 1001 to 101; all-managed retains 1000. These are requested IDs, including absent rows and duplicates, not a claim of 1000 returned rows or measured memory savings.

## Correctness and validation

Every browser run asserts exact JSON equality of the full stored rows and sync outcome against the paired baseline; also checks applied count, cursor 5000, tombstone removal, unique row count and absence of incoming remote private paths in managed state. Unit regression cases cover unused reads, selective managed reads, duplicate last-write ordering, matching local-root preservation, remote-path stripping and cancellation after asynchronous merge preparation. The two new read-budget tests failed against the baseline as intended; [red.log](./red.log) preserves that result.

Root ran the final combined green suite: **19 suites / 420 tests passed in 18.681 s after the initial type-predicate fix**, including session handler/base, managed-workspace, database sessions and sync integrations. Evidence: [regression-tests.log](../validation/regression-tests.log). The final annotated source then passed **2 suites / 15 tests in 2.206 s** ([final-type-fix-tests.log](../validation/final-type-fix-tests.log)); actual-project scoped compiler diagnostics were empty ([scoped-types.log](../validation/scoped-types.log)). Scoped ESLint and i18n gates also passed (root verification). Full-workspace typecheck status is recorded in the parent round report. Full typecheck subsequently identified TS18048 in the filtered previous-row array. Final source adds an explicit `(ChatSession | undefined)[]` annotation on `existing` and the TypeScript predicate `(row): row is ChatSession => row !== undefined`; these remove conditional-array overload ambiguity and make narrowing explicit without changing runtime behavior. Root verified the final source with actual-project scoped TypeScript diagnostics (exit 0). The original measured snapshot is retained as `after-sessions.ts.txt`; `final-sessions.ts.txt` includes the final annotations. The final equivalence evidence supersedes the intermediate predicate-only check. The normal fully minified bundles have equal size (148200 bytes) but different identifier names and hashes after this annotation. Rebuilding with identical syntax/whitespace minification and only identifier mangling disabled produces byte-identical 211882-byte bundles, SHA-256 `a2c161fb8ca655ebb4894e9a787139335c0740223e6fcef564c1f1618d776b87`. [compiled-equivalence.json](./compiled-equivalence.json) records all four hashes and [verify-compiled.mjs](./verify-compiled.mjs) reproduces the check. Timings were not rerun for this type-only change. [source-hashes.json](./source-hashes.json) records baseline/candidate snapshots, harness and final relevant source hashes. Dedicated browser and localhost server were closed after capture. No commit was created.

## Reproduction and limits

From the repository root:

```sh
rtk node docs/reports/database-performance-2026-10-07/round-3/sync-ingestion/build.mjs
rtk python3 -m http.server 8771 --bind 127.0.0.1 --directory /tmp/cognia-sync-ingestion-perf-2026-10-08
rtk agent-browser --session cognia-sync-ingestion-perf open http://127.0.0.1:8771
rtk agent-browser --session cognia-sync-ingestion-perf eval 'window.runBenchmark("paired")'
rtk agent-browser --session cognia-sync-ingestion-perf eval 'window.benchmarkResult || window.benchmarkError || window.benchmarkProgress'
```

Read the last expression again after completion; `runBenchmark` starts asynchronously. Use `"baseline"` to run only the archived baseline. Build uses the archived baseline and current production candidate; verify current source against the final hash and run `verify-compiled.mjs` to compare it with the preserved measured snapshot before reproduction. The fixture deletes each synthetic database in `finally`. Close the dedicated browser session and stop the server when finished.

This validates the fixed local encrypted ingestion boundary. It does not establish network transfer time, first UI paint, full-app observer overhead, real cross-device cancellation races, Tauri/Capacitor device behavior, peak memory or tail latency. An all-managed workload intentionally retains the same read work and shows no demonstrated performance change.
