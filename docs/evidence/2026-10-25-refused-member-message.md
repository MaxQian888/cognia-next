# Evidence ledger: refused member message

- Status: verifying
- Lane: standard
- Created: 2026-10-25
- Updated: 2026-10-25
- Related: docs/plans/2026-10-20-multi-user-organizations-permissions-and-rollout.md §9b.9; ADR-0116

## Original request

> Keep a member's refused message text and attachments after permanent HostState refusal and transcript sync. Add co-located Jest tests, a changeset, and verify on the P6f browser rig.

## Knowledge

| ID  | Statement                                                                            | State    | Basis                                                                                                        | Depends on |
| --- | ------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------ | ---------- |
| O1  | A dropped enqueue leaves the queue and no confirmed Host transcript row exists.      | Verified | host-state.ts message.dropped; host-state-service.ts abandonDispatch; 2026-10-25 source                      | -          |
| O2  | Transcript replacement deletes omitted optimistic user rows.                         | Verified | New messages.test.ts regression failed with received undefined before the preservation predicate, 2026-10-25 | O1         |
| C1  | Intent fate must remain distinct from runtime-confirmed transcript state.            | Verified | host-state.ts module contract and ADR-0116, 2026-10-25                                                       | -          |
| G1  | Retain refused content locally without replacing a newer draft or claiming delivery. | Agreed   | User request, 2026-10-25                                                                                     | -          |

## Problem frame

Preserve each permanently refused pre-turn submission as a clearly failed device-local user row. The retained row uses `host-state-refused:<actionId>` and records the original Host message id. Ordinary `syncMessages` and legacy history hydration can upsert the original placeholder without touching the local copy. The Host queue and operation still settle normally. The shared draft and its revision remain untouched. The browser timeline filters the original provisional row and draws the local failed copy; legacy message lists filter the placeholder and use the existing admission badge (O1, O2, C1, G1).

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                  |
| ------------ | ------ | ---------------------------------------------------------------------------- |
| scale        | medium | Client state materialization, local persistence, transcript UI, translations |
| technical    | low    | Existing Dexie messages table and live query; no new schema or wire shape    |
| coupling     | medium | Authoritative HostState operations versus local optimistic messages          |
| requirement  | low    | Preserve typed content; no new delivery or automatic retry                   |
| verification | high   | Real paired smoke-ada browser on P6f required                                |
| risk         | medium | Accidental delivery claims or overwriting unsent content                     |

## Risks

| ID  | Risk (impact)                                                    | Severity | Source                                               | Claim                                                                 | Refuted by                                                     |
| --- | ---------------------------------------------------------------- | -------- | ---------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------- |
| R1  | Failed requests look delivered or enter Host transcript          | medium   | ADR-0116; host-state.ts intent/confirmation contract | Only failed enqueues absent from the queue become local refusal rows  | Transient queued failures or canonical rows are tagged refused |
| R2  | Transcript sync or reconnect erases text or attachments          | high     | User reproduction; persistence regression            | Local refusal survives omitted transcript rows and sent-outbox vacuum | Refresh/reconnect loses retained text or refs                  |
| R3  | Recovery overwrites newer draft or changes its conflict sequence | medium   | User draft.revision constraint                       | Recovery does not write shared draft content or revision              | Newer draft changes during refusal recovery                    |
| R4  | New UI is dormant or untranslated                                | medium   | Cognia risk catalog                                  | Paired transcript mounts local refused rows with bilingual strings    | Idle browser hides rows or missing translation appears         |

## Verification obligations

| ID  | Risk       | Method                                           | Independence   | Evidence                                                                                                                                                                                                                                                                                                                             | Coverage                                                                                                                   | Status  |
| --- | ---------- | ------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1, R2, R3 | Co-located Jest regression and integration tests | tool           | Initial omitted-row regression failed as expected. 7 focused Jest suites pass: 368 tests (jest-complete.log)                                                                                                                                                                                                                         | Live drop, receipt-before-outbox settlement, reconnect, real syncMessages upsert, canonical replacement, refs, newer draft | passed  |
| V2  | R4         | Preflight auditors and i18n gates                | fresh-reviewer | Three read-only auditors; identified non-indexed query and missing diagnostic parser flags, both fixed                                                                                                                                                                                                                               | Wiring, co-located tests, bilingual keys and generated bundles                                                             | passed  |
| V3  | R2, R4     | P6f smoke-ada paired browser                     | real-env       | P6f smoke-ada final send aa9990f3-efff-4ea8-a81d-69889898921d: model_access_unavailable, idle, empty queue, two independent local refusal ids; new text visible once after reopen; newer draft kept at revision 12. See .cache/refused-member-message/browser-result.json; preliminary layout screenshot after-transcript-reopen.png | Missing-org-key refusal, real Host restart/reconnect, transcript reopen, multiple refused messages, newer draft            | passed  |
| V4  | R1, R4     | Typecheck, lint, static-export gate              | tool           | Full pnpm typecheck and final root typecheck pass; scoped ESLint, i18n gates and static-export audit pass. Global lint blocked by unrelated host-feature-manifest.test.ts:902 unused extra warning. Final pnpm build passes: all 129 static pages exported (build-final.log).                                                        | Main app types and bundled client imports; whole-repository lint remains blocked outside scope                             | blocked |

## Decisions

| ID  | Date       | Decision                                                                                                                                                                                                                                                                                                                                                                                  | Action    | Based on       | Reversal trigger                                                |
| --- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------- | --------------------------------------------------------------- |
| D1  | 2026-10-25 | Keep device-local failed messages; empty-draft-only recovery cannot preserve every refused submission once a newer draft exists. Extend the existing optimistic-row materializer and message persistence. Add one shared metadata reader and one dedicated UI because local failures must not be mistaken for confirmed Host timeline items. No reducer, wire, or draft revision changes. | implement | O1, O2, C1, G1 | Local rows cannot survive sync or UI cannot distinguish refusal |

## Residual risks

| ID  | Residual                                                                                    | From   | Why still open                                             | Next action                                                           | Status |
| --- | ------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------- | --------------------------------------------------------------------- | ------ |
| X1  | Final independent-ID browser smoke and production build                                     | V3, V4 | Both completed successfully                                | No action                                                             | closed |
| X2  | Global pnpm lint has an unrelated warning in lib/platform/host-feature-manifest.test.ts:902 | V4     | Shared-tree change outside this task; scoped ESLint passes | Owning change should rename unused argument extra to _extra or use it | open   |

## Outcome

| ID  | Signal                                                              | How / when measured       | Result                                                                                 | Status |
| --- | ------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------- | ------ |
| M1  | Member can still read refused text after transcript synchronization | P6f browser on 2026-10-25 | Two failed cards, new submission shown exactly once after reopen; newer draft retained | met    |

## Verification artifacts

- `.cache/refused-member-message/jest-complete.log`: 7 suites, 368 tests passed.
- `.cache/refused-member-message/typecheck-complete.log`: full repository typecheck passed; `typecheck-last.log` rechecked final root source.
- `.cache/refused-member-message/build-final.log`: production static export passed (129 pages).
- `.cache/refused-member-message/browser-result.json`: final P6f DOM and native IndexedDB assertions. `after-transcript-reopen.png` is the earlier visual layout check; final screenshot capture timed out in Chromium, so it is not claimed as an image of the final independent-ID run.
- `.cache/refused-member-message/scoped-lint-complete.log`, `i18n-build-check.log`, `i18n-lint-final.log`, `static-export-final.log`: scoped lint, generated bundles, bilingual keys and static-export audit passed.

The shared Next.js dev directory was deleted by another process during verification; the final browser run used the supported `COGNIA_NEXT_DIST_DIR=.next-mobile-dev` cache. A P6f person brain had exhausted its startup retries during an `ENOSPC` period; after disk space recovered, restarting the same rig Host restored the real member flow. No product workaround was added for either environment failure. Attachment names and opaque references are covered in Jest; the live browser smoke used text-only member sends.
