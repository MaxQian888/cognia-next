# Round 2 retained-scope preflight audit — 2026-10-08

**Result: no actionable correctness or co-located-test gaps found.** This is a read-only audit against the current `HEAD` diff, not a substitute for the owning task's executed validation gates. No coverage run or threshold was requested or applied.

## Exact retained scope

| File                                   | Change                                                                        | Co-located test status                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `lib/db/execution-runs.ts`             | Reuse event history within one `appendBatch` transaction attempt              | Existing `execution-runs.test.ts` extended with four behavioral regressions |
| `lib/db/execution-runs.test.ts`        | Duplicate/history-read, rollback, legacy ordering and transaction retry cases | Co-located with the only changed production module                          |
| `lib/db/mobile-outbound-queue.test.ts` | Status-list ordering, account/target scope and legacy deadletter isolation    | Co-located; corresponding production source unchanged                       |

The rejected queue production/count optimization and its `lib/queue/outbound-queue.test.ts` sent/legacy-failed summary test were removed together. Both queue-runner files match `HEAD`; their exclusion introduces no retained-source test gap. The rejected HostState and native experiments retain reports only, with no production changes.

## Behavior reviewed

- **Transaction attempt isolation:** `batchHistory` is created inside the `db.transaction` callback. An aborted/reopened attempt gets a new cache; stable event ids still originate outside retry. Existing account/target retry tests cover refusing a retry into another database.
- **Rollback:** the new terminal-mid-batch regression checks the run, complete event journal and notification work all equal their pre-transaction state. Its subsequent successful batch checks no rolled-back sequence/history leaks.
- **Retry:** the injected second-update `DatabaseClosedError` regression aborts after partial batch progress, then expects exactly the intended two event ids/sequences and a snapshot equal to canonical replay. It also verifies four update attempts, exercising the retry rather than merely a new independent call.
- **Duplicate delivery:** mixed old/new explicit and source ids preserve repeated return entries without duplicate persistence or sequence allocation. Duplicate checks still precede terminal-run rejection. Notification desired sequence is asserted.
- **Canonical ordering:** first actual append loads the indexed history. The cached append path requires a finite sequence strictly above the cached tail; other cases reload `[runId+seq]`, preserving IndexedDB's sequence/primary-key order. The legacy gap/conflicting-sequence test verifies canonical replay and the winning status.
- **Stored values:** the fast path re-reads the added row, retaining the same storage/serialization normalization as the previous full replay. The reducer does not mutate cached event objects. Installed Dexie's query-cache context requires non-explicit readonly transactions, so the explicit readwrite array here is not a shared liveQuery cache result.
- **Notifications:** run projection and the existing per-event notification dirty-marker touch remain inside the same transaction. No notification, awaited commit or retry work was removed.
- **Retained queue tests:** timestamp ties preserve primary-key order after sorting, scope/null-scope semantics remain explicit, and legacy deadletters stay account-bound. These are regression-only additions in `lib/db/mobile-outbound-queue.test.ts` after the performance candidate was rejected. The separate sent/legacy-failed summary test is not retained.

## Audit and verification boundary

Read current diffs and relevant owning reducer, notification projection, retry and Dexie transaction-cache code. No code was changed by this audit and no heavy tests were run, to avoid interfering with active performance measurements. The owning task must report its actual focused Jest, typecheck/lint and browser evidence independently; this document does not claim those gates passed.

Other specialized audit triggers are empty for this retained scope: no `.tsx`/translation edits, no routes or Node imports in bundled source, no Rust, no new outbound model call, and no new runtime module/initializer/setting. Existing runtime wiring is preserved by editing the private helper already called by `runEventJournal.appendBatch`.
