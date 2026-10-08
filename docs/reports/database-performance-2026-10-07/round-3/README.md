# Database optimization round 3 — 2026-10-08

This round continues the first two measured changesets. `initial-state.json`
records the starting revision, shared working-tree state and source hashes.
The earlier conversation, read-state and execution-batch changes are preserved.

## Experiment scope

1. **Archived notification listing.** The notification center requests one read
   state, but the query scans the complete creation-time index. Test selecting
   the existing compound read-state/time index, keeping all filtering and order.
2. **Session sync ingestion.** Local rows are loaded for every incoming session,
   although the merge function only uses them for managed workspace bindings.
   Test reading only those dependencies while retaining the existing merge,
   writes, slices, cancellation checks, cursor and deletion behavior.
3. **Delivery-ledger retention.** Investigate repeated reference queries during
   publication cleanup. Keep preservation of whole/in-flight intent references,
   deduplication records and transactional behavior as correctness requirements.

The notification aggregation flush helper was inspected but not selected:
`completeDigestFlush` has no active production caller in the inspected tree.
Optimizing that helper would not establish a current runtime benefit.

Each selected experiment preregisters its complete caller-visible storage API
boundary, fixture and acceptance rule before production edits. Baseline and
candidate use the same actual IndexedDB/table policy and fixture. Timing windows
are serialized; heavy validation runs afterward. The minimum gain is 10% and
greater than twice the larger median absolute deviation, with explicit small and
adverse-workload guardrails. Failed candidates are removed.

No live user data, schema, encryption policy, remote endpoint or durability
setting is changed. Browser storage measurements do not establish UI, cloud-sync,
Tauri or Capacitor performance. Experiments and final validation are recorded
below after completion.

## Measured results

All durations are medians for the complete named storage API. MAD is median
absolute deviation, not a confidence interval. Tests use isolated synthetic data
on native Chromium 151 IndexedDB, the installed Dexie 4.4.6 defaults, production
minified bundles and actual content-protection policy. Device: Apple M4 Pro,
48 GiB RAM, macOS 26.5.2. No thermal or power controls.

| API workload                                                 | Before median / MAD | After median / MAD | Saving            | Decision                    |
| ------------------------------------------------------------ | ------------------- | ------------------ | ----------------- | --------------------------- |
| Archived notifications: 25 old archived rows among 500 total | 5.20 / 0.50 ms      | 0.50 / 0.05 ms     | 4.70 ms / 90.38%  | Retain                      |
| Session sync: 1,000 ordinary sessions with prior rows        | 62.20 / 3.40 ms     | 43.90 / 4.20 ms    | 18.30 ms / 29.42% | Retain                      |
| Session sync: 1,000 sessions, 10% managed bindings           | 65.40 / 5.80 ms     | 47.90 / 5.10 ms    | 17.50 ms / 26.76% | Mixed-workload check passes |

Notification listing used 2 warmups and 12 measured samples per variant in
separate before/after blocks. The primary saving exceeds its 1.00 ms noise
threshold. Half-archived, all-archived, small and unchanged active-feed workloads
pass their guardrails. Complete result hashes match. Eight native filter cases
and four live-query emissions preserve filtering, tie order and live updates.
The table is `metadata-only`; this improvement avoids unrelated row scans.

Session ingestion used 2 warmups and 15 alternating paired samples per variant
for six workloads. The primary saving exceeds its 8.40 ms noise threshold;
mixed-workload saving exceeds 11.60 ms. All-managed sessions remain effectively
unchanged (66.00 → 65.40 ms), and small, one-slice and empty-local-database
guardrails pass. All 180 measured samples preserve complete rows and outcomes,
cursor/deletion behavior and matching local roots. The table is
`encrypted-content`; only unnecessary reads/decryption are avoided, and every
required encrypted write remains.

Session reads still yield before the scope check even when no prior rows are
needed. The same normalizer, 200-row apply slices and generic sync driver are
used. Neither change adds a schema index, cross-call cache or durable state.

## Rejected cleanup candidate

The publication-reference lookup experiment passed table/output/encryption
correctness, but failed its primary performance requirement:

| Full retention API workload                        | Paired baseline median / MAD | Candidate median / MAD | Result                                                   |
| -------------------------------------------------- | ---------------------------- | ---------------------- | -------------------------------------------------------- |
| 1,000 old publications plus related ledger records | 153.20 / 4.60 ms             | 177.30 / 9.30 ms       | 15.73% slower; reject                                    |
| 100 publications                                   | 16.00 ms                     | 13.10 ms               | Secondary improvement cannot override primary regression |
| 20 publications                                    | 4.80 ms                      | 4.30 ms                | Guardrail only                                           |

These are 15 alternating pairs after 2 warmups. The earlier standalone baseline
(182.3 ms) is retained in the raw evidence but is not used as the comparator
for the paired result. Replacing per-publication queries with `anyOf` cursor
batches did not improve this primary workload. No unmeasured cause is asserted.
The production file is restored byte-for-byte; only an independent rollback and
retry regression test remains. No cleanup policy or retention behavior changed.

## Evidence and limitations

- [Notification experiment](notifications/report.md): source snapshots, raw
  timings, output hashes, filter/live-query checks and reproduction commands.
- [Session sync experiment](sync-ingestion/README.md): full encrypted ingestion
  fixtures, alternating samples, preserved workspace paths and cursor/deletions.
- [Retention experiment](retention/README.md): rejected source, raw paired data,
  all-five-table equivalence, idempotency and source-restoration evidence.

The timing harnesses inject disposable database accessors and omit unrelated
application boot, account-sync capture and external transport costs. Their gains
apply to the measured API fixtures; they do not measure full application startup,
archive-tab paint, network sync completion, native packages or device behavior.
Peak memory was not measured. No new persistent cache, storage format or index
is introduced. The changes remain uncommitted in the shared working tree.

## Final regression verification

The combined Jest run completed with:

```text
Test Suites: 19 passed, 19 total
Tests:       420 passed, 420 total
```

It covers notification DB queries, notification center/store and workflow callers,
notification policy/read-state/snooze, session ingestion/base sync/history,
managed-workspace merging, the earlier session changes, and delivery retention,
storage retention and reconciliation. The exact file list and output are in
`validation/regression-tests.log`.

Scoped ESLint without cache, Prettier and `git diff --check` pass. I18n key parity,
reference checks and `i18n:sort:check` pass. Independent
[preflight review](preflight-audit.md) and both cross-reviews found no actionable
behavior or co-located-test gaps. Full lint exits 1 with
`4934 problems (82 errors, 4852 warnings)`; error locations are outside this round,
in `components/chat/composer.tsx` and generated
`src-tauri/resources/plugins/cognia-office/dist/index.js`.

The first full typecheck caught an explicit narrowing requirement in the sync
handler and a Dexie promise-type mismatch in the new rollback test. Both were
corrected and the 420-test run and scoped checks repeated. The initial diagnostics
are preserved in `validation/typecheck-before-fix.log`; the final typecheck output
is recorded separately in `validation/typecheck.log`.

The compiler additionally required an explicit array annotation for the
conditional session lookup. That final type-only change passes targeted semantic
diagnostics using the real project config, and both affected suites were rerun:
`2 passed, 15 tests passed` (`validation/final-type-fix-tests.log`).
[Compiled equivalence](sync-ingestion/compiled-equivalence.json) confirms that
the measured and final session implementations emit byte-identical JavaScript
with identifier mangling disabled. Normally minified outputs have identical
size but different identifier names; the report does not claim those bytes match.

Final full `pnpm typecheck` exits 2 with only the existing out-of-scope diagnostic:

```text
lib/tauri/transport-companion.test.ts(3006,73): error TS2353: Object literal may only specify known properties, and 'sent' does not exist in type 'Promise<string>'.
```

There are no remaining diagnostics in this round's changed files. Source and
restoration checks are saved in `final-validation.json`; the previous rounds'
production sources remain unchanged.

Coverage and a full app/native-package build were not run. No live database,
external message, network endpoint or deployment was modified.
