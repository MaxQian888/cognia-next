# Archived notification query performance — 2026-10-08

Retained a narrow read-query change: a request for exactly one notification read state now uses the existing `[readState+createdAt]` index. Opening the archived tab at the current default retention cap of 500 notifications improved the complete storage API call from **5.20 ms to 0.50 ms**, an absolute **4.70 ms** reduction (**90.38%**). This measures the repository boundary, not the complete rendered UI or a real device.

## Scope and rationale

`components/notifications/notification-center.tsx` calls `listNotifications({includeDone: true, readStates: ["done"], limit: 100})` when loading archived notifications. Previously this walked the reverse `createdAt` index across newer active notifications and filtered each row. ADR-0042 and the existing schema already supply the compound state/timestamp index. No migration or new index is necessary.

Only `lib/db/notifications.ts` and its co-located test change. The predicate, limit behavior, writes, retention, badge counts, and default/multiple-state query path remain unchanged. Inclusive `Dexie.minKey`/`Dexie.maxKey` bounds preserve the timestamp key domain, including legacy negative timestamps; reversed compound index traversal preserves timestamp and primary-key tie order. The query remains observable through Dexie `liveQuery`.

## Fixed experiment and results

The [contract](./contract.md) was recorded before the implementation change. The original source and its baseline measurements were captured before editing. The harness imports the complete actual notification module and redirects only `getDb` to an isolated synthetic database with the production notification indexes. It installs the real account cipher and content-protection middleware. **The actual `notifications` table policy is metadata-only**, so this result is fewer IndexedDB cursor reads and row processing, not encryption savings.

Environment: Apple M4 Pro, 14 cores, 48 GiB, macOS 26.5.2; Chromium 151 native IndexedDB; Dexie 4.4.6 default options; production/minified esbuild bundle. Each fixed fixture has 2 warmups followed by 12 measured calls. Fixtures use 512-character bodies. Seeding and output hashing are outside the measured interval. Root serialized timing lanes; no power/thermal controls were applied. Baseline and candidate are sequential runs, not interleaved pairs.

| Complete `listNotifications` call                   | Before median / MAD (ms) | After median / MAD (ms) | Interpretation                 |
| --------------------------------------------------- | -----------------------: | ----------------------: | ------------------------------ |
| 500 rows, 25 older archived, archived limit 100     |              5.20 / 0.50 |             0.50 / 0.05 | Primary: −4.70 ms, −90.38%     |
| 500 rows, 250 older archived, archived limit 100    |              3.35 / 0.45 |             1.30 / 0.10 | Guardrail passed               |
| 500 rows, all archived, limit 100                   |              1.90 / 0.20 |             1.30 / 0.10 | Guardrail passed               |
| 20 rows, one archived, limit 100                    |              0.70 / 0.10 |             0.10 / 0.00 | Small-query guardrail passed   |
| 500 rows, active-feed hydration query, 441 returned |              4.25 / 0.20 |             3.60 / 0.10 | Unchanged path; guardrail only |

The primary improvement exceeds both preregistered thresholds: 10% and twice the larger MAD (1.00 ms). Every guardrail satisfies the allowed regression bound of `max(10% of baseline, 1 ms)`. Timer resolution matters for submillisecond samples; the small fixture and unchanged active-feed measurements are not separate speedup claims.

Raw samples and complete-result hashes are in [baseline.json](./baseline.json) and [after.json](./after.json). All five full-row array SHA-256 hashes match exactly; each sample also matches independently derived expected rows and ordering. Frozen source snapshots are [baseline-source.ts.txt](./baseline-source.ts.txt) and [after-source.ts.txt](./after-source.ts.txt).

## Correctness and validation

Native IndexedDB checks pass for both variants: eight filter combinations cover single/multiple/empty states, includeDone conflicts, source and snooze filtering, limited/no-limit queries, zero/negative limit behavior, negative timestamps, and primary-key ordering when timestamps tie. A real `liveQuery` produces four expected emissions: initial archived set, a row entering the archived set, its title update, and its removal after a state change. Evidence: [baseline-correctness.json](./baseline-correctness.json), [correctness.json](./correctness.json).

The added regression test first failed on the original full-timeline query, with the other 26 tests passing; see [red-test.log](./red-test.log). Additional unit cases cover `-Infinity`, zero, `Infinity`, legacy Date timestamp keys, source/snooze predicates, and limit quirks. Root's final combined regression suite passed **19 suites / 420 tests** in 30.486 seconds, including notifications DB, store, notification center, workflow/routing, sync and retention. See [regression-tests.log](../validation/regression-tests.log). The combined suite avoids duplicate broad checks.

Focused ESLint passed for both changed source files and the harness (exit 0; [lint.log](./lint.log)); `git diff --check` passed. Prettier changed test/harness/report formatting only. Final production source is byte-identical to the measured candidate snapshot, SHA-256 `c3f02d6c51c80cad38f074f058457c054b6e9151d413e1da623edbbb26df9e6f`. The baseline hash is `f4bc3e366c5200e44918f342355e25210442b508d28d2b2403baea9292970491`. The dedicated browser session and localhost server have been closed; only synthetic report evidence and temporary bundles remain.

## Reproduction and limits

From the repository root, build the original and candidate snapshots with:

```sh
rtk node docs/reports/database-performance-2026-10-07/round-3/notifications/build-harness.mjs baseline docs/reports/database-performance-2026-10-07/round-3/notifications/baseline-source.ts.txt
rtk node docs/reports/database-performance-2026-10-07/round-3/notifications/build-harness.mjs after docs/reports/database-performance-2026-10-07/round-3/notifications/after-source.ts.txt
rtk python3 -m http.server 8938 --bind 127.0.0.1 --directory /tmp/cognia-notifications-perf
```

Open `http://127.0.0.1:8938/baseline.html` and `after.html` in the same isolated Chromium profile; evaluate `window.runBenchmark()` and `window.runCorrectness()` once per variant. The harness creates and deletes only its synthetic database. No production user data is accessed. Do not run concurrent CPU-heavy tests or other timing experiments.

This establishes an improvement for the specific archived-list storage boundary under the fixed local fixtures. It does not establish React paint latency, full application launch performance, Tauri/Capacitor hardware behavior, remote sync performance, or peak memory. The candidate creates no retained cache and returns the same row count. No schema, persisted format, cross-account routing, or write behavior changed.
