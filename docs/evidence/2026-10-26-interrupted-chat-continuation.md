# Evidence ledger: interrupted chat continuation

- Status: verifying
- Lane: standard
- Created: 2026-10-26
- Updated: 2026-10-26
- Related: ADR-0090, ADR-0161, ADR-0217

## Original request

> 完整的实现一下，注意对其他agent的适配问题，完成之后不需要typecheck，检查对应的文件即可

## Knowledge

| ID  | Statement                                                                                                               | State    | Basis                                                                                          | Depends on |
| --- | ----------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------- | ---------- |
| O1  | The composer originally disabled an empty input after stop/error and rejected empty submits.                            | Verified | Source review and failing Resume decision test on 2026-10-26.                                  | -          |
| O2  | Existing send paths own PII gates, native session reuse, transcript handoff, runtime admission and room routing.        | Verified | Adapter explorer and PII auditor; ADR-0090/0161/0217; controller and external manager sources. | -          |
| O3  | No existing outcome record covers direct, external, team, shared projection and reload; idle conflates stop/completion. | Verified | Outcome explorer; chat-store, room runner and execution-run sources.                           | -          |
| G1  | An interrupted/recoverable turn can continue with one click while typed input remains a normal Send.                    | Agreed   | User request and preceding Codex app review.                                                   | -          |
| G2  | Continuation preserves partial work and the actual answering agent, including explicit routes and delegation fallback.  | Agreed   | User specifically requests other-agent adaptation.                                             | -          |
| C1  | Skip typecheck and coverage; inspect and test affected files, preserving concurrent edits.                              | Verified | Explicit user request; repository coverage opt-in and shared dirty checkout.                   | -          |

## Problem frame

Implement a shared composer continuation action for G1/G2. A generated nonempty instruction goes through existing normal send pipelines (O2), because external protocols do not share Codex app's empty-input continuation API. Preserve the prior user anchor, concrete runtime, explicit route, room member picks, partial transcript, and structured terminal outcome. No dependency, schema migration, or new provider transport is needed.

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                                        |
| ------------ | ------ | -------------------------------------------------------------------------------------------------- |
| scale        | medium | Composer, store, controller, room sinks and transcript persistence.                                |
| technical    | low    | Existing send, metadata and sync/event seams are reused.                                           |
| coupling     | medium | Desktop/mobile/embedded composers, external protocols and shared projection.                       |
| requirement  | low    | One-click continuation and agent preservation are explicit.                                        |
| verification | medium | Focused deterministic adapter seams are available; real providers remain outside this local check. |
| risk         | medium | Stale terminal writes or wrong routing could repeat work or switch agents.                         |

## Risks

| ID  | Risk (impact)                                                                   | Severity | Source                           | Claim                                                                                                           | Refuted by                                                                         |
| --- | ------------------------------------------------------------------------------- | -------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| R1  | Resume replays the original task or drops partial progress.                     | medium   | ADR-0090, adapter explorer       | A new instruction continues the existing transcript through normal send.                                        | Transcript truncation or regenerate call.                                          |
| R2  | Generic continuation selects a different runtime or loses room picks.           | medium   | ADR-0161/0217, wiring auditor    | Anchored runtime and route are retained, revalidated by existing admissions.                                    | Interrupted external/member work dispatches to another agent.                      |
| R3  | Late snapshots erase outcome, or a later draft failure relabels completed work. | medium   | Outcome explorer, wiring auditor | Versioned outcome metadata survives full/delta/stream persistence and is anchored to the admitted user message. | Completed old work becomes resumable or newer queued work is relabelled.           |
| R4  | Continuation bypasses existing PII or Host authorization.                       | high     | Risk catalog, PII auditor        | Continuations use existing send and runtime resolver gates.                                                     | A new outbound sink bypasses the gate or uses a mismatched execution spec.         |
| R5  | UI labels or shared lifecycle metadata are dropped at a boundary.               | medium   | i18n and wiring auditors         | Both locales and shared terminal projection carry the new fields.                                               | Missing translation or another collaborator loses an anchored interrupted outcome. |

## Verification obligations

| ID  | Risk        | Method                                                      | Independence   | Evidence                                                                                                                 | Coverage                                                                                         | Status  |
| --- | ----------- | ----------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------- |
| V1  | R1,R2       | Focused Jest composer/controller/room tests.                | tool           | .cache/codex-app-review/continuation-verification.log; final rerun recorded below.                                       | Continue click, busy guard, Send transition, partial reply, builtin/external route and fallback. | passed  |
| V2  | R3          | Store and message persistence regression tests.             | tool           | Versioned metadata tests in chat-store and messages.test.ts.                                                             | Session isolation, later queued message, pre-admission failure, full/delta/stream writes.        | passed  |
| V3  | R4          | PII audit and resolver review.                              | fresh-reviewer | resume_pii_audit confirmed existing gates; resolver runtime override fixed and rechecked.                                | Builtin, standalone, room, external and Host outbound seams.                                     | passed  |
| V4  | R5          | Locale generation/parity/lint/sort checks and i18n audit.   | tool           | pnpm i18n:build; i18n:build:check; lint:i18n; i18n:sort:check passed.                                                    | New Resume label, tooltip and continuation instruction in en/zh-CN.                              | passed  |
| V5  | R2,R3,R5    | Wiring/test-gap review and shared projection tests.         | fresh-reviewer | Auditors identified runtime fallback, shared boundary and stale metadata paths; each received code and regression fixes. | Shared continuation request and terminal outcome publication/projection, room provenance.        | passed  |
| V6  | R1,R5       | Local browser render check.                                 | real-env       | Isolated next dev on port 3214 served Cognia; CUA DOM/screenshot confirmed composer renders.                             | Empty initial composer layout only; Resume click is covered by mounted RTL tests.                | passed  |
| V7  | R1,R2,R4    | Live native/provider/paired-device continuation acceptance. | real-env       | Not run in this focused file-check task.                                                                                 | Provider-specific cancellation and real external effects remain unmeasured.                      | blocked |
| V8  | R1,R2,R3,R5 | Affected-file ESLint and formatting.                        | tool           | .cache/codex-app-review/continuation-lint-final.log; final run recorded below.                                           | Task-owned source/test paths only.                                                               | passed  |

## Decisions

| ID  | Date       | Decision                                                                                                                                                                                                                                                                        | Action    | Based on       | Reversal trigger                                                    |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------- | ------------------------------------------------------------------- |
| D1  | 2026-10-26 | Reuse normal send with an explicit continuation instruction rather than introduce a protocol-specific empty-turn dependency.                                                                                                                                                    | implement | O1,O2,G1,G2,C1 | An adapter rejects this existing send path or loses its transcript. |
| D2  | 2026-10-26 | Put versioned outcomes and concrete runtime identity on the owning user message; share through existing lifecycle events. A new pure continuation module is required because UI, store, DB and sync need the same boundary readers without importing React/runtime controllers. | implement | O3,G1,G2       | Stale writes or shared projection violate the owning anchor.        |

## Residual risks

| ID  | Residual                                                                          | From        | Why still open                                                                                                                                           | Next action                                                           | Status |
| --- | --------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------ |
| X1  | Real external-agent cancellation may leave an operation with an uncertain effect. | V7          | Live providers/devices were not exercised. The continuation instruction explicitly requests inspecting current state before repeating uncertain actions. | Provider/paired-device acceptance when that environment is available. | open   |
| X2  | Focused verification completed.                                                   | V1,V2,V5,V8 | All 16 suites and affected-file checks passed.                                                                                                           | See final verification below.                                         | closed |

## Outcome

| ID  | Signal                                                                           | How / when measured                                                               | Result                                                                                      | Status  |
| --- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------- |
| M1  | Interrupted input no longer requires manually typing continue.                   | Mounted Composer click test and controller/room integration checks on 2026-10-26. | 16 suites / 1143 tests passed; Resume click keeps partial progress and the answering route. | met     |
| M2  | Actual provider/device continuation behaves correctly after native interruption. | Live acceptance outside this focused task.                                        | Carried as X1; no claim of live-provider acceptance.                                        | pending |

## Verification notes

- The first Resume decision test failed because the old button returned disabled Send.
- An existing timestamp test assumed optional stored metadata was always an object. Its assertion now normalizes absent metadata while retaining the invariant that hoisted createdAt is never stored in the metadata blob.
- No typecheck, coverage, full production build, commit or push was run.

## Final verification

- Focused Jest: 16 suites passed, 1143 tests passed, 0 failed (29.069 s); `.cache/codex-app-review/continuation-complete-tests.log`.
- Affected-file ESLint: exit 0 with `--max-warnings=0`; `.cache/codex-app-review/continuation-final-lint.log`.
- Affected-file Prettier check: all matched files use Prettier style; `.cache/codex-app-review/continuation-format-check.log`.
- Locale generation/check, ICU validation, lint:i18n and i18n sort checks passed.
- `git diff --check` passed. Read-only i18n/PII/wiring/test-gap reviews completed; reported issues received focused regression coverage.
- Temporary local browser preview compiled and rendered; no real provider call or native external-agent continuation was performed.
- Typecheck, coverage and full production build were not run. The checkout remains uncommitted.
