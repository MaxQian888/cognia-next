# Execution-event batch performance — measured 2026-10-08

Retained a transaction-local history cache in `runEventJournal.appendBatch`. A batch previously re-read and materialized the complete journal for every new event. It now reads canonical history once, then reads each newly stored event by ID and reuses the prior history for the unchanged reducer. A non-monotonic sequence falls back to the original indexed query, preserving legacy gap/conflict ordering.

The actual production catalog marks `executionRuns`, `executionRunEvents` and `notificationProjectionWork` **metadata-only**. The benchmark installs the real encryption middleware and follows that policy; these rows are not AES-encrypted. The measured saving is repeated IndexedDB retrieval/structured-clone deserialization, **not decryption**. An initial encryption assumption was corrected after a native smoke check; see `contract.md` and the preserved failed-check evidence.

## Before and after

Complete `runEventJournal.appendBatch` call, including redaction, event writes, full snapshot reduction after every event, run updates, durable notification work touches and transaction commit. Real Chromium 151 IndexedDB, Dexie 4.4.6 default cache policy; production/minified esbuild bundle importing the complete execution-runs module. Two warmups and 12 measured samples per workload; identical seed/reset procedure outside the timer.

| Existing events + appended batch | Before median / MAD | After median / MAD |                  Change | Decision                                                                         |
| -------------------------------- | ------------------: | -----------------: | ----------------------: | -------------------------------------------------------------------------------- |
| 500 + 100, replay catch-up       |    540.30 / 4.15 ms |   253.70 / 3.55 ms | −286.60 ms / **53.04%** | Retain                                                                           |
| 20 + 2, ordinary bridge batch    |      2.35 / 0.10 ms |     2.00 / 0.05 ms |   −0.35 ms / **14.89%** | Pass                                                                             |
| 0 + 1, small guardrail           |      0.95 / 0.05 ms |       0.80 / ~0 ms |                −0.15 ms | No regression; no single-event speedup claim because its query path is unchanged |

Both claimed gains exceed the preregistered 10% practical threshold and twice the larger MAD. Small-sample maxima are in the raw JSON; no p95 assertion is made. Machine: Apple M4 Pro, 14 CPU cores, 48 GiB RAM, macOS 26.5.2; no thermal controls. The parent agent granted an exclusive measurement window.

Raw evidence: `baseline.json`, `after.json`. Full returned-event, replay-history, final-snapshot and notification-state hashes match in every workload and across every sample:

- 500 + 100: `7699448cfa87431f8fb52a4bdcb8105f0fea5b569fa96142ce832f29f2b94105`
- 20 + 2: `993232445837b59c2448954f493789cf029a53f78b18b244597a7f9c60d12a91`
- 0 + 1: `492b2c960d43fb449dd213ea5f4a25dd5af33f07a58bfe89b38bf3453468913c`

The stress workload reduces journal-history row materialization from 55,050 rows (queries of 501 through 600 rows) to 600 (initial 501 plus 99 single-row readbacks). Event/run/notification writes and all 100 full reducer calls remain. Memory is bounded to one transaction's O(history + batch) array, with no cross-call cache, schema/index change or storage growth. Peak heap was not measured.

## Behavior and regression evidence

`red-test.log` shows the new structural regression failing before implementation: two history queries instead of one. `tests.log` shows **104 tests passing in five suites** after implementation:

```text
PASS node lib/db/execution-runs.test.ts
PASS node lib/execution/run-reducer.test.ts
PASS node lib/execution/agent-state-bridge.test.ts
PASS node lib/db/notification-projection-work.test.ts
PASS node lib/execution/workflow-bridge.test.ts
Test Suites: 5 passed, 5 total
Tests:       104 passed, 104 total
```

Added tests cover mixed explicit/source IDs and duplicates, full snapshot parity, unchanged notification desired sequence, terminal-midbatch rollback, duplicate terminal delivery, a later successful batch after abort, legacy sequence gaps/conflicting sequence IDs, and a retried transaction rebuilding history. Existing tests preserve the account/target retry fence. The cache is allocated inside the transaction callback for each retry attempt; failed events never leak into the next attempt. Single append and caller-owned transaction APIs do not receive the cache.

`baseline-correctness.json` and `correctness.json` drive the actual API in native IndexedDB and return identical results: atomic event/run/notification rollback, terminal duplicate sequences `[1,2,2]`, legacy gap sequences `[1,2,4]`, and the same `waiting` state. The original and optimized repository both accept a direct metadata-only journal write with the content cipher locked (`lockedWriteRejected: false`); the failed assumption is saved as `locked-smoke-assumption-failed.json`. This does not establish application-level account lock behavior: runtime activation/authorization lies outside this DB fixture. No encryption policy was changed.

Focused ESLint for the changed module/test/harness passed, and `git diff --check` passed. Root owns broader typecheck/lint/regression reporting; this report does not imply those whole-repository gates completed here.

## Why this path matters

- `lib/execution/agent-state-bridge.ts` batches a plan/goal revision with step events.
- `lib/execution/workflow-bridge.ts` replays mapped durable workflow events into this journal, retaining source order and refusing new events past terminal state.
- ADR-0169 makes the execution snapshot the shared projected run view. ADR-0190 requires notification projection work to be touched in the **same commit** as event persistence. All those writes and ordering rules remain.

No reducer semantics, run-state transitions, redaction, deduplication, required output or notification delivery policy was simplified. The run is still reread for each input, duplicates are checked before the terminal gate as before, and every input's required durable work is awaited.

## Reproduction and limits

```sh
rtk node docs/reports/database-performance-2026-10-07/round-2/execution-events/build-harness.mjs baseline docs/reports/database-performance-2026-10-07/round-2/execution-events/baseline-source.ts.txt
rtk node docs/reports/database-performance-2026-10-07/round-2/execution-events/build-harness.mjs after
rtk python3 -m http.server 8937 --bind 127.0.0.1 --directory /tmp/cognia-execution-events-perf
```

In a second terminal, navigate the isolated browser to each generated HTML and run the same call:

```sh
rtk agent-browser --session cognia-execution-events-perf open http://127.0.0.1:8937/baseline.html
rtk agent-browser --session cognia-execution-events-perf eval 'window.runBenchmark()' --json
rtk agent-browser --session cognia-execution-events-perf eval 'window.runCorrectness()' --json
rtk agent-browser --session cognia-execution-events-perf open http://127.0.0.1:8937/after.html
rtk agent-browser --session cognia-execution-events-perf eval 'window.runBenchmark()' --json
rtk agent-browser --session cognia-execution-events-perf eval 'window.runCorrectness()' --json
rtk pnpm exec jest lib/db/execution-runs.test.ts lib/execution/run-reducer.test.ts lib/execution/workflow-bridge.test.ts lib/execution/agent-state-bridge.test.ts lib/db/notification-projection-work.test.ts --runInBand --silent
rtk agent-browser --session cognia-execution-events-perf close
```

The harness injects the synthetic DB accessor and a no-retry reopen boundary, selects the real cached notification identity functions without booting unrelated app subsystems, and uses real reducer/redactor/notification projection code. Retry behavior is covered by unit tests, not timed. Account sync capture and full app boot are not installed in this narrow fixture. It writes only its synthetic DB and removes it after each run. Temporary bundles live under `/tmp/cognia-execution-events-perf`; source snapshots/hash evidence are retained here.

No claim is made about full application UI time, native Tauri WebView, Capacitor hardware, network sync throughput, peak memory or a full production app build. No wall-clock CI gate is added.
