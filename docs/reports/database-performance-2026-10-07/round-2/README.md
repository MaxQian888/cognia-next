# Additional database optimization — 2026-10-07

Completed 2026-10-08 (Asia/Shanghai). The directory date records the experiment start.

Follow-up to the first round in the parent directory. The first-round conversation
query and read-state changes remain in place. `initial-state.json` records this
round's starting hashes and concurrent working-tree edits.

## Selection and scope

The inspected runtime callers identify three further storage operations:

| Operation                                      | Runtime caller                                                                                                   | Suspected repeated work                                                                                                                                                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read outbound jobs by status                   | `components/mobile/outbound-queue-sheet.tsx`, `lib/queue/outbound-queue.ts`, `lib/sync/handlers/app-settings.ts` | A filtered IndexedDB cursor reads each matching status row; simple range reads could use native bulk retrieval while applying the same scope/legacy filters and order.                                                            |
| Discover persisted host-state session channels | `lib/sync/host-state-service.ts: settleOrphanedTurns`                                                            | Discovery loads full state rows just to return channel names, before snapshot reads load state again. The inline primary key already contains the channel.                                                                        |
| Append execution-event batch                   | `lib/execution/agent-state-bridge.ts`, `lib/execution/workflow-bridge.ts`                                        | Every appended event reads and deserializes the full previous event history within the same write transaction. Transaction-local reuse could remove repeated reads while preserving each reduction, write and notification touch. |

Each experiment has its own preregistered contract, baseline snapshot, actual
native IndexedDB fixture and reproducible browser harness. Encryption middleware
and the existing table-governance policy are used, including metadata-only tables
where that is the production policy. Retention, account isolation, retry fences,
terminal states, atomic rollback, and result order are correctness requirements.

Retain only improvements of at least 10% that exceed twice the larger median
absolute deviation. Small, mixed-scope and adverse-shape workloads act as
guardrails. Use at least ten measured samples after warmup. Benchmark windows
are centrally coordinated; tests and builds run outside them.

No live user data, remote endpoint, schema, encryption policy or durability
setting is changed. Browser API completion is the measurement boundary; app UI,
network transmission and packaged desktop/mobile performance are separate.

## Other inspected candidates

Notification badge counts iterate indexed unread records because directed/snooze
decisions depend on row data; no timing evidence currently supports replacing
that with a different data model. Notification aggregation flush writes one row
at a time, but its retry/idempotency and caller transaction semantics need a
separate bounded experiment. Execution-run filtered lists lack every possible
compound filter index; introducing an index would require migration and workload
evidence. These areas are not claimed as optimized in this round.

## Retained result

Only the execution-event batch implementation cleared the acceptance criteria.
It reads the canonical event history once per transaction attempt, then reads back
each newly stored event before reducing the history. Non-monotonic legacy sequences
fall back to the canonical index query. The cache cannot survive transaction aborts
or reopen retries. Every event still updates the run and notification work in the
same transaction; no required write or reducer call was removed.

Native Chromium 151 IndexedDB, minified production bundle, actual Dexie 4.4.6
defaults and storage middleware; 2 warmups and 12 measured samples per variant.
The fixed synthetic fixtures measure the complete `runEventJournal.appendBatch`
API, including event/run/notification writes. Baseline and candidate use separate
before/after sample blocks, not alternating pairs.

| Existing events + batch | Before median / MAD | After median / MAD | Median change       | Decision                                         |
| ----------------------- | ------------------- | ------------------ | ------------------- | ------------------------------------------------ |
| 500 + 100               | 540.30 / 4.15 ms    | 253.70 / 3.55 ms   | −53.04% (286.60 ms) | Retain; saving exceeds 8.30 ms noise threshold   |
| 20 + 2                  | 2.35 / 0.10 ms      | 2.00 / 0.05 ms     | −14.89% (0.35 ms)   | Ordinary-workload check passes                   |
| 0 + 1                   | 0.95 / 0.05 ms      | 0.80 / ~0.00 ms    | −0.15 ms            | Guardrail only; single-event algorithm unchanged |

**Storage-policy correction:** both execution tables are currently classified as
`metadata-only` by the repository's content-protection policy. Middleware is
installed but does not encrypt these rows. The gain is repeated IndexedDB
read/deserialization avoidance, not decryption avoidance. An initial locked-write
smoke assumption failed and is preserved as evidence; baseline and candidate both
accept that write under the existing policy. No encryption-policy change is made.

Every measured fixture has identical full output hashes across variants, covering
returned events, replay order, snapshots, run revision and notification state.
Native browser correctness checks also compare atomic rollback, terminal-event
duplicate handling, legacy sequence gaps/conflicts and the unchanged table policy.
See [execution experiment](execution-events/report.md) for raw samples, source
snapshots, reproducible commands and correctness outputs.

## Rejected experiments

| Candidate                                            | Relevant before → after medians       | Why rejected                                                         |
| ---------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------- |
| Queue status list: bulk retrieve then filter         | 5,000 rows: 21.0 → 23.4 ms            | 11.4% regression; production hunk removed                            |
| Queue summary: direct counts instead of sorted lists | Scoped 5,000 rows: 20.9 → 20.6 ms     | 1.4% gain, 0.3 ms saving below 1.0 ms noise threshold; primary fails |
| HostState channel discovery: key-only reads          | Full recovery reads: 190.4 → 162.8 ms | 27.6 ms saving below 57.8 ms noise threshold; primary inconclusive   |

The summary experiment improves the no-scope secondary case from 24.9 to 0.3 ms,
and key-only HostState discovery improves its isolated layer metric. Neither is
used to override the preregistered primary metric. Production queue/HostState
sources are unchanged. Two standalone queue listing correctness tests remain,
covering account/target scope, legacy deadletters, tied timestamps and no-scope reads.

Evidence: [queue lists](outbound-queue/README.md),
[queue summary](outbound-queue/count-summary/README.md),
[HostState recovery reads](host-state/README.md).

## Verification

Final combined regression command:

```sh
rtk proxy pnpm exec jest --runInBand lib/db/execution-runs.test.ts lib/db/notification-projection-work.test.ts lib/execution/run-reducer.test.ts lib/execution/agent-state-bridge.test.ts lib/execution/workflow-bridge.test.ts lib/sync/handlers/execution-runs.test.ts lib/db/mobile-outbound-queue.test.ts lib/queue/outbound-queue.test.ts lib/queue/retry-policy.test.ts lib/sync/handlers/outbound-queue.test.ts
```

- `Test Suites: 10 passed, 10 total`; `Tests: 227 passed, 227 total`.
- Scoped ESLint without cache, Prettier and `git diff --check`: exit 0.
- `pnpm lint:i18n`: key parity and references pass; 75 hardcoded findings within
  the existing baseline. `pnpm i18n:sort:check`: exit 0.
- Read-only correctness/test-gap review: [no actionable findings](preflight-audit.md).
- Full `pnpm typecheck`: exit 2, outside this change:
  `lib/tauri/transport-companion.test.ts(3006,73): error TS2353: Object literal may only specify known properties, and 'sent' does not exist in type 'Promise<string>'.`
- Full `pnpm lint`: exit 1, `4934 problems (82 errors, 4852 warnings)`; errors
  in `components/chat/composer.tsx` and generated
  `src-tauri/resources/plugins/cognia-office/dist/index.js`, outside this change.

Raw validation output is in [validation/](validation/). Coverage and a full
application/native-package build were not run. No production UI, remote service,
cross-window, Tauri or Capacitor performance claim is made. Memory usage was not
measured; the additional retained array is bounded by history plus batch size and
exists only within the transaction attempt. These synthetic workloads establish
the measured API improvement, not the prevalence of that workload in user data.

All changes remain uncommitted in the shared working tree. The first-round source
hashes and rejected-candidate restoration are checked in `final-validation.json`.
