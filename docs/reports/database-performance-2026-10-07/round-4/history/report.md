# Scoped workflow failure history — 2026-10-08

Retained the existing-index query change in `listDeadLetters(workflowId)`. With 1,000 runs across 20 workflows, including 200 failures and 10 failures in the selected workflow, the complete storage call improved from **5.05 ms to 0.40 ms**: **4.65 ms less, or 92.08%**. This is an encrypted IndexedDB storage-boundary measurement, not complete UI render latency.

## Caller, cause, and change

The workflow editor's `RunsTab` mounts `DeadLetterPanel` with a workflow ID. Its `useLiveQuery` invokes `listDeadLetters(workflowId)`. Previously the function loaded and decrypted every failed workflow run before discarding rows from unrelated workflows. Those rows contain immutable workflow snapshots, trigger payloads and error details.

The current schema already has `[workflowId+status]`. A truthy workflow ID now selects that exact index key before loading rows. Global and empty-string queries retain the original status index. The existing acknowledgement/workflow filter and stable descending `startedAt` sort are unchanged, including missing legacy timestamps and primary-key tie order. No schema, write, retention, cache, public API, or rendering changes are included.

The research also inspected workflow list/statistics, browser history and terminal history. Browser/terminal reads already use bounded indexed access; statistics would require a broader multi-index aggregation. The scoped failure query offers a smaller attributable change. ADR-0011 describes persisted run snapshots and their editor history role; current schema and content-protection policy are the implementation authority for indexes and encryption.

## Preregistered experiment

The [contract](./contract.md) fixes the workloads and thresholds before production edits. [baseline-source.ts.txt](./baseline-source.ts.txt) was frozen and measured before applying the candidate; [after-source.ts.txt](./after-source.ts.txt) is the measured candidate. The harness selects the exact exported `listDeadLetters` declaration from the source AST and injects only `getDb`. It does not boot unrelated publication/write imports; this function boundary is explicit, and the complete function result is measured.

The actual `workflowRuns` policy is **encrypted-content**. The fixture uses the real account cipher and encryption middleware, all current workflowRuns indexes, Dexie 4.4.6 defaults, Chromium 151 native IndexedDB, and a production/minified esbuild bundle. Synthetic rows include 2 KiB frozen workflow descriptions, errors, and trigger payloads. Each fixture has 2 warmups and 12 recorded calls. Seeding, expected-result calculation, and hashing are outside timing. Baseline and candidate runs are sequential in the same isolated browser setup, not interleaved pairs.

Machine: Apple M4 Pro, 14 cores, 48 GiB, macOS 26.5.2. Root serialized timing lanes; no thermal/power controls were applied. Source hashes and all raw samples are in [baseline.json](./baseline.json) and [after.json](./after.json).

| Complete storage call                                                   | Before median / MAD (ms) | After median / MAD (ms) | Decision                                  |
| ----------------------------------------------------------------------- | -----------------------: | ----------------------: | ----------------------------------------- |
| 1,000 rows / 200 failed / 10 scoped failures, 7 unacknowledged returned |              5.05 / 0.30 |             0.40 / 0.00 | Primary: −4.65 ms, −92.08%                |
| 20 rows / 4 failed, 3 returned                                          |              0.15 / 0.05 |             0.20 / 0.05 | +0.05 ms; guardrail passed                |
| 200 failed in one workflow, 150 returned                                |              4.70 / 0.20 |             5.00 / 0.15 | +0.30 ms; guardrail passed                |
| Global query on 1,000 rows, 140 returned                                |              4.80 / 0.15 |             4.85 / 0.10 | +0.05 ms; unchanged path guardrail passed |
| Missing workflow on 1,000 rows                                          |              4.60 / 0.10 |             0.10 / 0.00 | Guardrail passed                          |

Primary improvement exceeds both the preregistered 10% practical threshold and twice the larger MAD (0.60 ms). All guardrail increases stay below `max(10% of baseline, 1 ms)`. The small case increased by roughly 33% but only 0.05 ms, below timing resolution/noise and the explicit absolute allowance; it is reported rather than hidden. The all-one-workflow case does not benefit from avoiding unrelated rows and was 0.30 ms slower, also within the declared bound. No unchanged-path speedup is claimed.

## Correctness and verification

Every measured call matches independently derived complete expected rows and ordering. Full-row SHA-256 hashes match across variants for all five workloads. Native checks also verify absent/empty/missing workflow IDs, acknowledgedAt missing/null/zero, same-time primary-key ties, negative/missing startedAt, mixed statuses and legacy missing workflowId. Real Dexie liveQuery emits after status enters failure, encrypted error content changes, workflow scope changes, and acknowledgement hides the row. Both variants produce five expected emissions and reject a read with a locked account cipher. Evidence: [baseline-correctness.json](./baseline-correctness.json), [correctness.json](./correctness.json).

The added structural regression first failed on the original broad status query, with the other 65 tests passing; [red-test.log](./red-test.log) records the expected failure. Three added co-located tests cover selective index access and legacy/ordering/scope behavior. Root's final combined regression passed **16 suites / 351 tests** in 15.939 seconds, including the workflow repository and UI failure panel. See [regression-tests.log](../validation/regression-tests.log). No duplicate broad test run was performed by this worker.

Focused ESLint passed (exit 0; [lint.log](./lint.log)) for workflows.ts, its test, and the harness; `git diff --check` passed. Prettier left both production/test files unchanged. Final production source is byte-identical to the measured snapshot, SHA-256 `668d630a6e59ad33eb3ca9f774c66a47d963bbf823d3f9a81f6e36b895829b3f`; its AST-selected function hash is `40f5d2b4edc2ae7199f613439db7353abfb6552921eeca12b6c0cf84395f7941`.

## Reproduction and limits

From the repository root:

```sh
rtk node docs/reports/database-performance-2026-10-07/round-4/history/build-harness.mjs baseline docs/reports/database-performance-2026-10-07/round-4/history/baseline-source.ts.txt
rtk node docs/reports/database-performance-2026-10-07/round-4/history/build-harness.mjs after docs/reports/database-performance-2026-10-07/round-4/history/after-source.ts.txt
rtk python3 -m http.server 8939 --bind 127.0.0.1 --directory /tmp/cognia-workflow-history-perf
```

Open baseline.html and after.html at localhost8939 in the same isolated Chromium session. Evaluate `window.runBenchmark()` and `window.runCorrectness()` once for each. Only the synthetic database is created/deleted; production account records and app caches are not touched. Avoid concurrent CPU-heavy processes during timing.

This demonstrates the scoped storage improvement under the fixed fixtures. It does not establish real-user failure distributions, end-to-end rendering, Tauri/Capacitor hardware, remote synchronization, or peak memory. The candidate has no retained cache, returns all required rows, and preserves existing failure recovery actions; those actions are outside the timed read. Temporary bundles and evidence remain; the dedicated localhost server and browser session have been closed.
