# Evidence ledger: terminal plan projection

- Status: verifying
- Lane: standard
- Created: 2026-10-26
- Updated: 2026-10-26
- Related: lib/execution/agent-state-bridge.ts; ADR-0137

## Original request

> Console Error: Execution run is terminal: execution:plan:fb7d0b79-1b72-487d-9d13-28bbe85f110a

## Knowledge

| ID  | Statement                                                                                                                      | State    | Basis                                                                                                                                                                                     | Depends on |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| O1  | The running Tauri app logs a failed Plan projection into an already terminal run.                                              | Observed | macOS main-window console entry 76 and user stack, 2026-10-26.                                                                                                                            | -          |
| O2  | Both Plan and Goal sync append revision/step events before checking lifecycle status.                                          | Verified | lib/execution/agent-state-bridge.ts, 2026-10-26.                                                                                                                                          | -          |
| O3  | The exact desktop plan and run are cancelled; the run retains revision 5 but has 0 event rows.                                 | Observed | Read-only native IndexedDB inspection before and after fresh boot, 2026-10-26. The empty history is consistent with 30-day event retention; the original deletion cause was not recorded. | O1         |
| H1  | Replaying a source snapshot can attempt new events after termination, including when the old event IDs are no longer retained. | Verified | Source ordering; 6 pre-fix replay failures; added same-source retention regressions for Plan and Goal, 2026-10-26.                                                                        | O2         |
| G1  | Replaying ended plans should not create console errors or change their execution history.                                      | Agreed   | User error report and authorized repair, 2026-10-26.                                                                                                                                      | O1         |
| C1  | Terminal journals remain immutable; legitimate active-run projection, bindings and database-scope guards remain functional.    | Verified | ADR-0137 terminal-journal contract; journal and bridge tests, 2026-10-26.                                                                                                                 | -          |

## Problem frame

Fix the projection caller, keeping the journal guard intact (C1). Check terminal status in the same transaction as revision, step and lifecycle writes, so replay and overlapping syncs cannot append after termination (H1). Extend the existing bridge, extract the existing cached batch appender into the journal module, and update their co-located tests; this new ledger records this separate incident. No schema, UI or execution-engine restart behavior is changed.

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                 |
| ------------ | ------ | --------------------------------------------------------------------------- |
| scale        | low    | Two existing runtime modules and their co-located tests.                    |
| technical    | low    | Reuse the existing transaction-aware journal entry point.                   |
| coupling     | medium | Projection shares the journal and notification dirty-marker transaction.    |
| requirement  | low    | Suppress invalid late projection writes, preserving terminal state.         |
| verification | medium | Deterministic replay/concurrency tests and the existing desktop record.     |
| risk         | medium | Incorrect handling could reopen settled work or write into another account. |

## Risks

| ID  | Risk (impact)                                                           | Severity | Source                                           | Claim                                                                                             | Refuted by                                                                        |
| --- | ----------------------------------------------------------------------- | -------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| R1  | Replayed/overlapping sync writes after a terminal event.                | medium   | lens: concurrency; observed runtime error        | Replay resolves without changing a settled run or its events.                                     | A sync rejects with a terminal error or adds events after termination.            |
| R2  | Fix weakens journal immutability or loses legitimate active-run events. | medium   | ADR-0137 and lib/db/execution-runs.test.ts       | Only the projection skips ended runs; active state transitions and journal rejection stay intact. | Direct journal append succeeds after termination, or active lifecycle tests fail. |
| R3  | A scoped retry or account change writes to another database.            | medium   | Existing bridge scope tests; Cognia risk catalog | Guard every transaction attempt and abort its pending writes on scope change.                     | A queued projection writes into a replacement account.                            |

## Verification obligations

| ID  | Risk   | Method                                                              | Independence | Evidence                                                                                                                                                                                                                                                                                        | Coverage                                                                                                                                                                                                                                                             | Status  |
| --- | ------ | ------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1     | Terminal replay and overlapping projection regression tests         | tool         | Pre-fix: 6 terminal replay failures, 12 passed. Final run: 165 tests passed across 6 suites, including all 23 bridge tests.                                                                                                                                                                     | Plan and Goal; completed/failed/cancelled; changed source revisions, overlapping completion, and identical-source replay after event-retention cleanup. The overlap cases also passed pre-fix and are sanity checks.                                                 | passed  |
| V2  | R2, R3 | Bridge and journal suites plus adjacent projection tests            | tool         | Final 165-test run passed. Checks cover outer-transaction rollback, same-database retry, cross-account retry refusal, scope invalidation during writes, retention, journal immutability and replay caching.                                                                                     | Active projection, bindings, run/events/notification-marker rollback, and captured database scope.                                                                                                                                                                   | passed  |
| V3  | R1     | Re-run the desktop projection subscription and read new diagnostics | real-env     | After user unlock, the real macOS Tauri main window was reloaded. Exact run stayed cancelled at revision 5 with 0 retained events, identical before/after SHA-256 history digest, and 0 console or projection errors. Evidence: .cache/tauri-agent-debug/terminal-plan-projection-desktop.json. | Full app semantic UI mounted after fresh boot. Read-only inspection of the original account and plan; no history edits. Later captured device-auth challenge requests failed independently; native screenshot was excluded because foreground Codex occluded Cognia. | passed  |
| V4  | R2, R3 | Lint, typecheck, formatting and scoped diff audit                   | tool         | pnpm lint, focused ESLint, static-export check (11,733 TS files), formatting and scoped diff checks passed. Follow-up test-gap audit found no remaining gaps. Full typecheck still reports 8 errors in 3 unrelated chat/Discord files.                                                          | Four changed source/test files; no schema or dependency change. Production build was not repeated with repository typecheck already failing.                                                                                                                         | blocked |

## Decisions

| ID  | Date       | Decision                                                                                                                                                           | Action    | Based on | Reversal trigger                                                                  |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | -------- | --------------------------------------------------------------------------------- |
| D1  | 2026-10-26 | Serialize terminal check and all projection events in one table-scoped write transaction, using appendRunEventInsideTransaction. Keep journal rejection unchanged. | implement | H1, C1   | Any terminal replay/concurrency regression persists, or active/scope checks fail. |

## Residual risks

| ID  | Residual                                                             | From   | Why still open                                                                                                                                      | Next action                                                        | Status |
| --- | -------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------ |
| X1  | The exact stored plan had not completed desktop replay verification. | V3, M1 | Resolved after user unlock: fresh boot passed, original run and history digest unchanged, no terminal-run console error.                            | Closed; preserve the recorded metadata and diagnostics.            | closed |
| X2  | Full repository typecheck is not green.                              | V4     | The same 8 errors remain in hooks/chat/use-claude-chat.test.ts and lib/connectors/adapters/discord/avatar{,.test}.ts; none are in task-owned files. | Repair the separate chat/Discord changes and rerun pnpm typecheck. | open   |

## Outcome

| ID  | Signal                                                                         | How / when measured                                        | Result                                                                                                                             | Status |
| --- | ------------------------------------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | Replaying the stored terminal plan produces no new terminal-run console error. | Existing macOS Tauri main window after unlock, 2026-10-26. | Original cancelled run remains at revision 5, history digest unchanged, 0 projection errors and 0 console errors after fresh boot. | met    |

## Verification commands

Final test command: pnpm test -- lib/execution/agent-state-bridge.test.ts lib/db/execution-runs.test.ts lib/execution/agent-team-bridge.test.ts lib/execution/run-reducer.test.ts lib/db/notification-projection-work.test.ts lib/execution/workflow-bridge.test.ts --runInBand. Result: 6 suites passed, 165 tests passed, 11.907 s.

pnpm lint and pnpm lint:static-export passed. pnpm typecheck was rerun after the added retry tests and reported the same 8 unrelated errors. The journal terminal guard is unchanged. The batch helper is used by both the public journal appender and the Plan/Goal bridge; it retains the existing per-batch replay cache. The four code/test changes are uncommitted. No coverage command was run.

## Desktop follow-up after unlock

Run the cached verification procedure with `rtk node .cache/tauri-agent-debug/verify-terminal-plan-replay.mjs`; its `--settled` mode checks the fully mounted app against the saved pre-reload hash without issuing another reload. The final report was captured at 2026-10-26T11:10:23.012Z (2026-10-26 19:10:23 Asia/Shanghai). It reads only run/source headers and computes a hash inside the renderer; it does not expose title, objective or encrypted event payloads.

The exact original run remains cancelled, currentRevision=5, eventCount=0. Before/after history digest: 1b19c9fb0d4878abe02173edd9c8bdae9170395560a40e969a3c1163172cbf12. The terminal event rows were already absent before verification. Added two regressions using sweepExecutionRunEventRetention to verify that an identical source snapshot cannot recreate those pruned events.

No Plan/Goal projection failure or console error appeared after reload and full app mount. The native main window semantic Inbox control was visible. The display-region screenshot was occluded by the foreground Codex app and excluded rather than treated as a Cognia screenshot. Later captured network failures were local device-auth challenge calls to a separate localhost endpoint; no claim is made that all unrelated runtime network paths passed. The tracked desktop process remains running.
