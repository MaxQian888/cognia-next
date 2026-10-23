# Evidence ledger: codex native subagent model control

- Status: verifying
- Lane: deep
- Created: 2026-10-21
- Updated: 2026-10-21
- Related: [Implementation plan](../plans/2026-10-21-codex-native-subagent-model-control.md)

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> 按方案实施 P0 实际能力识别和原生子代理身份登记，再接入派生时动态选模和 V1 已有子代理切换，完成真实验证并复用现有组件。

## Knowledge

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement                                                                                                     | State    | Basis                                                                                                                         | Depends on |
| --- | ------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------- |
| O1  | Codex 0.159.2 V1 accepts current-turn and future-thread settings; V2 rejects direct child input.              | Verified | Isolated real CLI loopback probe, docs/reports/2026-10-21-codex-subagent-model-probe.json, 2026-10-21. No supplier inference. | -          |
| O2  | The baseline discarded parent/direct-input/model-backend facts and only changed local selectedModel metadata. | Verified | packages/agent-codex/src/app-server-client.ts, 2026-10-21.                                                                    | -          |
| G1  | Expose evidence-based native child identity/capabilities and scoped V1 switching.                             | Agreed   | User implementation request and approved plan.                                                                                | O1, O2     |
| G2  | Support finite dynamic spawn candidates through the existing model-plan/gateway.                              | Agreed   | User implementation request and approved plan.                                                                                | -          |
| C1  | Preserve concurrent changes, shared primitives, PII gates and narrow Host operations.                         | Observed | AGENTS.md, ADR-0217 and dirty-tree snapshot, 2026-10-21.                                                                      | -          |

## Problem frame

Preserve native thread identity and distinguish configured model metadata from observed execution. Reuse the adapter, task model-plan and session-operation pipeline so native children can be inspected and controlled within their real owner root (G1/G2/C1). V2 direct-input rejection is a supported limitation, not an invitation to recreate children.

<!-- One paragraph: the problem we are choosing to solve now, the outcome that
would show it is solved, and what is explicitly out of frame. Cite IDs. -->

## Complexity profile

<!-- Rating: low | medium | high | unknown. "unknown" is a valid answer; say what
would resolve it. Never sum these into a score. -->

| Dimension    | Rating | Why / what would resolve it                                                    |
| ------------ | ------ | ------------------------------------------------------------------------------ |
| scale        | high   | Contracts, adapter, gateway policy, UI and Host boundary.                      |
| technical    | high   | Native backend depends on inherited thread and tool configuration.             |
| coupling     | high   | Existing task lease and public/native session mapping must stay authoritative. |
| requirement  | medium | Approved proposal specifies scopes and fail-closed restrictions.               |
| verification | high   | Jest, real Codex process, real Cognia shell and supplier evidence differ.      |
| risk         | high   | Cross-root control and widened gateway candidate authorization.                |

## Risks

<!-- ID prefix R. Severity: low | medium | high. Source: how the risk was found (catalog,
ADR-NNNN, git history, lens:STRIDE, reviewer, incident memory, …). Claim: the
property the design promises. Refuted by: the observation that would prove the
claim false. -->

| ID  | Risk (impact)                                            | Severity | Source                | Claim                                                                                | Refuted by                                                   |
| --- | -------------------------------------------------------- | -------- | --------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| R1  | Control targets another root or a stale process/turn.    | high     | Plan ownership review | Validate native lineage, generation and active turn before sending.                  | Any cross-root or stale mutation RPC.                        |
| R2  | UI claims an unsupported or unobserved switch succeeded. | high     | O1                    | Keep capability unknown until evidence; report acceptance separately from inference. | Optimistic actual-model update or V2 control RPC.            |
| R3  | Candidate policy silently widens or disappears.          | high     | Gateway contract      | Strict normalization and finite provider/account model plan.                         | Invalid policy accepted or model absent from ticket catalog. |

## Verification obligations

<!-- ID prefix V. Risk: the R id(s) this obligation discharges.
Independence: self | subagent | fresh-reviewer | tool | other-model | human | real-env
Status: planned | passed | failed | blocked | waived
Evidence: command + result excerpt, commit, or artifact path — not "should pass".
Coverage: which conditions the evidence covers (and which it does not). -->

| ID  | Risk       | Method                                                                                                   | Independence | Evidence                                                                                                                                                  | Coverage                                                          | Status  |
| --- | ---------- | -------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------- |
| V1  | R1, R2     | Adapter behavioral tests for lineage, stale turn/generation, refusal and settings scopes.                | tool         | 18 suites / 1211 tests passed; .cache/codex-all-focused-tests.log.                                                                                        | Local native adapter.                                             | passed  |
| V2  | R3         | Canonical normalizer/compiler/projector tests including allowed-only and incompatible account/provider.  | tool         | Canonical contract/compiler/projector suites passed in the same 18-suite run.                                                                             | Task policy, no supplier requests.                                | passed  |
| V3  | R1, R2     | Real Codex CLI driven through adapter with controlled Responses fixture.                                 | real-env     | COGNIA_CODEX_LIVE=1 targeted native test passed; V1, V2 and original code-mode V2; .cache/codex-native-live-test.log.                                     | Real native process, no live provider.                            | passed  |
| V4  | R1, R2, R3 | Focused lint/format/i18n/UI/Host checks and independent applicable auditors; typecheck skipped per user. | subagent     | Full pnpm lint and focused lint/format/i18n gates passed; final wiring/i18n clean; earlier audit findings fixed and tested; browser screenshots retained. | Changed production paths and component fixture, no deployed Host. | passed  |
| V5  | R2         | Real Cognia shell flow with native child controls.                                                       | real-env     | Earlier launch failed with No space left on device; user explicitly requested no further Tauri build.                                                     | Actual Tauri UI not verified.                                     | blocked |
| V6  | R2         | Workspace static-export compatibility gate.                                                              | tool         | pnpm lint:static-export failed on three unrelated Node-only imports; .cache/codex-static-export.log.                                                      | Full workspace, including concurrent work.                        | failed  |

## Decisions

<!-- ID prefix D. Based on: only the IDs this decision ASSUMES still hold (if one is
later Invalidated, the decision reopens). Name ruled-out hypotheses in the
Decision text, not here.
Action: implement | spike | diagnose | experiment | harden | escalate | scope-down | stop | ship
Reversal trigger: the new evidence that would reopen this decision. -->

| ID  | Date       | Decision                                                                                        | Action    | Based on           | Reversal trigger                                                         |
| --- | ---------- | ----------------------------------------------------------------------------------------------- | --------- | ------------------ | ------------------------------------------------------------------------ |
| D1  | 2026-10-21 | Extend existing contracts/adapter/manager/projectors; retain observed-versus-inferred evidence. | implement | O1, O2, G1, G2, C1 | A native schema or ownership invariant contradicts the proposed mapping. |

## Residual risks

<!-- ID prefix X. From: the R / V / H / M ids this residual comes from.
What is still not known or not verified after this round. No invented
percentages. Status: open | accepted | closed. "accepted" needs the user. -->

| ID  | Residual                                                           | From   | Why still open                                                                                        | Next action                                                                                        | Status |
| --- | ------------------------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------ |
| X1  | Full Cognia Tauri UI and paired Host acceptance remain unverified. | V5     | Build failed earlier; further builds explicitly skipped; no paired Host run in this round.            | Resume native/Host acceptance when requested, using this report and retained CLI/browser evidence. | open   |
| X2  | No authenticated provider inference or general per-step telemetry. | V3, R2 | Native CLI uses a controlled Responses fixture; public events do not supply all execution facts.      | Validate against the intended provider route before claiming live provider acceptance.             | open   |
| X3  | Workspace static-export gate is not green.                         | V6     | Unrelated imports in lib/browser/extension-engine.ts and lib/plugin/core/builtin-artifact-fixture.ts. | Owners repair those imports, then rerun the workspace gate.                                        | open   |

## Outcome

<!-- ID prefix M. Signals that the ORIGINAL problem improved (validation, not verification).
Status: pending | met | not-met | not-measurable -->

| ID  | Signal                                                                                     | How / when measured                                                                 | Result                                                                                                       | Status  |
| --- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------- |
| M1  | Native child model settings can be inspected and valid V1 changes reach the correct child. | Real installed CLI through the production adapter and loopback fixture, 2026-10-21. | Explicit spawn B overrides default A; V1 next step uses C/high in the same turn; V2 direct controls blocked. | met     |
| M2  | Full Cognia native UI and paired Host behave correctly.                                    | Native environment acceptance.                                                      | Not established by CLI and component fixtures; see X1.                                                       | not-met |

The implementation and current verification results are recorded; the ledger remains verifying with X1–X3 explicitly open. See the [implementation report](../reports/2026-10-21-codex-native-subagent-model-control.md) for behavior, usage, evidence boundaries and the decision to reuse the session-operation panel rather than duplicate the job store.
