# Evidence ledger: inbox seed constraint

- Status: verifying
- Lane: standard
- Created: 2026-10-26
- Updated: 2026-10-26
- Related: `lib/db/conversation-labels.ts`, `lib/db/canned-responses.ts`, ADR-0131

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> 进入inbox的时候出现 Runtime ConstraintError: Key already exists in the object store

## Knowledge

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement                                                                                                                               | State    | Basis                                                                                                                                                    | Depends on |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| O1  | Entering Inbox produced an unhandled duplicate-key ConstraintError.                                                                     | Observed | macOS Tauri console entries 239–240, 2026-10-26; original error has no table or stack.                                                                   | -          |
| O2  | Multiple Inbox consumers seed the same fixed label IDs through mount effects; both catalog seeders read then add without a transaction. | Verified | `hooks/connectors/use-conversation-labels.ts`, `components/inbox/triage-menu-items.tsx`, both catalog modules, 2026-10-26.                               | -          |
| H1  | Concurrent catalog initialization can reject with ConstraintError.                                                                      | Verified | Four new regression cases failed before the fix; four concurrent calls yielded one success and three ConstraintErrors in each empty catalog, 2026-10-26. | O2         |
| G1  | Inbox entry completes without duplicate-key failures.                                                                                   | Agreed   | User's error report and authorized repair, 2026-10-26.                                                                                                   | O1         |
| C1  | Preserve existing catalog IDs, edited fields, timestamps, and saved-reply usage; never clear the user's database.                       | Verified | Existing seeders skip populated IDs; per-table CRUD contracts and `lib/db/CONVENTIONS.md`, 2026-10-26.                                                   | -          |

## Problem frame

<!-- One paragraph: the problem we are choosing to solve now, the outcome that
would show it is solved, and what is explicitly out of frame. Cite IDs. -->

Eliminate the proven initialization race in the two Inbox catalogs (H1) while preserving stored rows (C1). Verify concurrent empty and partial catalogs, then revisit Inbox in the running Tauri shell (G1). The original desktop error lacks a table/stack, so tests establish the specific race independently. Existing modules and their co-located tests can own the fix; this task-specific evidence file records the new reproduction and verification. No schema or UI changes are needed.

## Complexity profile

<!-- Rating: low | medium | high | unknown. "unknown" is a valid answer; say what
would resolve it. Never sum these into a score. -->

| Dimension    | Rating | Why / what would resolve it                                          |
| ------------ | ------ | -------------------------------------------------------------------- |
| scale        | low    | Two existing CRUD modules and their tests.                           |
| technical    | low    | Existing Dexie write-transaction pattern.                            |
| coupling     | low    | Exported functions, schemas, IDs, and hook callers remain unchanged. |
| requirement  | low    | Prevent duplicate initialization while preserving existing rows.     |
| verification | medium | Deterministic IndexedDB tests plus real Tauri Inbox entry.           |
| risk         | medium | Persistence writes must retain edited starter data.                  |

## Risks

<!-- ID prefix R. Severity: low | medium | high. Source: how the risk was found (catalog,
ADR-NNNN, git history, lens:STRIDE, reviewer, incident memory, …). Claim: the
property the design promises. Refuted by: the observation that would prove the
claim false. -->

| ID  | Risk (impact)                                                     | Severity | Source                                                                                  | Claim                                                                                  | Refuted by                                                        |
| --- | ----------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| R1  | Overlapping seeders reject, producing an unhandled runtime error. | medium   | lens: concurrency failure injection; observed desktop console                           | Concurrent seed calls all settle successfully with one row per ID.                     | Any concurrent seed rejects or a starter is missing.              |
| R2  | Replacing inserts with upserts resets edited catalog data.        | medium   | `lib/db/CONVENTIONS.md` timestamp invariants; ADR-0131 field-preserving write principle | Existing rows are unchanged and only missing starters are added.                       | An edited field, usage count, or timestamp differs after seeding. |
| R3  | Local tests miss the real Inbox wiring or shell behavior.         | medium   | Cognia risk catalog: real-shell verification                                            | The running desktop can enter and revisit Inbox without a new duplicate-key rejection. | A new ConstraintError or Inbox render failure appears.            |

## Verification obligations

<!-- ID prefix V. Risk: the R id(s) this obligation discharges.
Independence: self | subagent | fresh-reviewer | tool | other-model | human | real-env
Status: planned | passed | failed | blocked | waived
Evidence: command + result excerpt, commit, or artifact path — not "should pass".
Coverage: which conditions the evidence covers (and which it does not). -->

| ID  | Risk   | Method                                                               | Independence | Evidence                                                                                                                                                                                                                                           | Coverage                                                                                                                                                                                                                                                                                           | Status  |
| --- | ------ | -------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1     | Concurrent empty and partial catalog regression tests                | tool         | Pre-fix: 4 failed, 12 passed with ConstraintError. Post-fix: all 16 catalog tests passed in the 81-test run.                                                                                                                                       | Four simultaneous callers, both catalogs, empty and partial state.                                                                                                                                                                                                                                 | passed  |
| V2  | R2     | Assert retained rows equal their pre-seed snapshots                  | tool         | All four new regression tests passed; edited rows compare equal, including timestamps and saved-reply usage.                                                                                                                                       | Existing IDs, data and timestamps; missing starters restored.                                                                                                                                                                                                                                      | passed  |
| V3  | R3     | Navigate into Inbox repeatedly in real Tauri and inspect diagnostics | real-env     | macOS main window: /inbox/all and /inbox/drafts rendered, then /inbox/all rendered again after tracked restart (PID 89376); no new ConstraintError. Screenshot: .cache/tauri-agent-debug/inbox-seed-constraint-after.png.                          | Existing account retained. Semantic click flow timed out while document.visibilityState was hidden; verification used native navigation and fresh snapshots. One unrelated terminal execution-plan sync error matched the pre-existing startup log. No failed captured requests in the final read. | passed  |
| V4  | R1, R2 | Focused and adjacent tests, lint, type checks, final scoped diff     | tool         | Six suites / 81 tests passed. pnpm lint and focused ESLint passed. pnpm lint:static-export passed (11,733 TS files). Test-gap audit found no issues. pnpm typecheck failed with 8 errors in 3 unrelated chat/Discord files. Scoped diff inspected. | No new schema, dependency, or bundle entry point; production build not repeated while repository typecheck is failing.                                                                                                                                                                             | blocked |

## Decisions

<!-- ID prefix D. Based on: only the IDs this decision ASSUMES still hold (if one is
later Invalidated, the decision reopens). Name ruled-out hypotheses in the
Decision text, not here.
Action: implement | spike | diagnose | experiment | harden | escalate | scope-down | stop | ship
Reversal trigger: the new evidence that would reopen this decision. -->

| ID  | Date       | Decision                                                                                                              | Action    | Based on | Reversal trigger                                                                             |
| --- | ---------- | --------------------------------------------------------------------------------------------------------------------- | --------- | -------- | -------------------------------------------------------------------------------------------- |
| D1  | 2026-10-26 | Serialize each catalog's existence checks and inserts in a table-scoped write transaction; keep insert-only behavior. | implement | H1, C1   | Concurrency still rejects, existing data changes, or desktop error points to another writer. |

## Residual risks

<!-- ID prefix X. From: the R / V / H / M ids this residual comes from.
What is still not known or not verified after this round. No invented
percentages. Status: open | accepted | closed. "accepted" needs the user. -->

| ID  | Residual                                                                                                   | From | Why still open                                                                                                                      | Next action                                                                                                                     | Status |
| --- | ---------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------ |
| X1  | Full repository typecheck is not green.                                                                    | V4   | 8 errors in hooks/chat/use-claude-chat.test.ts and lib/connectors/adapters/discord/avatar{,.test}.ts; none are in task-owned files. | Repair the separate chat/Discord changes, then rerun pnpm typecheck.                                                            | open   |
| X2  | Repeated full-page navigation appeared stalled at account-registry bootstrap while the WebView was hidden. | V3   | Bringing the native window forward resumed startup; a fresh snapshot showed the Inbox headings again.                               | Closed for this repair: original Inbox flow rendered. Background animation-driven automation remains outside the verified flow. | closed |

## Outcome

<!-- ID prefix M. Signals that the ORIGINAL problem improved (validation, not verification).
Status: pending | met | not-met | not-measurable -->

| ID  | Signal                                                 | How / when measured                                    | Result                                                                                       | Status |
| --- | ------------------------------------------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------ |
| M1  | Enter and revisit Inbox without a new ConstraintError. | macOS Tauri main window, original account, 2026-10-26. | Inbox and Drafts rendered without duplicate-key errors; Inbox rendered again after relaunch. | met    |

## Verification commands

```sh
pnpm test -- lib/db/conversation-labels.test.ts lib/db/canned-responses.test.ts hooks/connectors/use-conversation-labels.test.ts hooks/connectors/use-canned-responses.test.ts lib/db/labels.test.ts components/inbox/conversation-list.test.tsx --runInBand
pnpm lint
pnpm lint:static-export
pnpm typecheck
```

The test command passed 81 tests across 6 suites. The two catalog suites contain 16 tests, including four new race/preservation regressions. Repository lint and static-export checks passed. Full typecheck reported 8 errors in unrelated chat/Discord files; this ledger stays verifying with X1 open. No source or test assertion was changed to suppress those failures. Changes are uncommitted; the desktop process remains running.
