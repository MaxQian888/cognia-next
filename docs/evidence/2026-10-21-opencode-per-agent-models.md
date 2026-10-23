# Evidence ledger: opencode per agent models

- Status: verifying
- Lane: standard
- Created: 2026-10-21
- Updated: 2026-10-21
- Related: ../reports/2026-10-21-opencode-subagent-support.md; ADR-0090; ADR-0217

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> 继续完善，让 Cognia 支持为每个 OpenCode 自定义 subagent 单独配置模型，兼容 V1、ACP 和 V2，保留显式模型配置，未指定时才使用默认子代理模型，并补齐验证。

Follow-up: 修复剩余两项测试失败和工作区启动，范围限定为 OpenCode；继续跳过 typecheck。

## Knowledge

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement                                                                                                                   | State    | Basis                                                                                                              | Depends on |
| --- | --------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ | ---------- |
| O1  | OpenCode projection replaces explicit child model definitions.                                                              | Verified | gateway-task.ts and existing assertions, 2026-10-21                                                                | -          |
| O2  | Gateway tickets authorize the compiled model list before launch.                                                            | Verified | manager.ts compilePlan and prepareExternalAgentGatewayRoute, 2026-10-21                                            | -          |
| G1  | Preserve individual explicit child models across V1, ACP and V2; apply defaults only when absent.                           | Agreed   | User request, 2026-10-21                                                                                           | -          |
| C1  | Gateway models share one provider/account; never silently reroute an incompatible explicit model.                           | Verified | model-plan.ts and ADR-0090, 2026-10-21                                                                             | -          |
| O3  | Existing process environment editor accepts inline native agent definitions.                                                | Verified | agent-editor-dialog.tsx, 2026-10-21                                                                                | -          |
| O4  | The baseline V2 editor drops process.env on save and hides gateway-owned launch fields.                                     | Verified | Failing regression in .cache/opencode-v2-editor-red.log, 2026-10-21; fixed in follow-up.                           | O3         |
| O5  | Two shared hooks imported by OpenCode settings have invalid client directive placement during the follow-up.                | Verified | Next build overlay/import trace and .cache/opencode-followup-dev.log, 2026-10-21; fixed by moving directives only. | -          |
| C2  | Follow-up changes cover OpenCode tests, configuration and startup dependencies; unrelated global export repair is excluded. | Verified | User follow-up scope, 2026-10-21                                                                                   | -          |

## Problem frame

<!-- One paragraph: the problem we are choosing to solve now, the outcome that
would show it is solved, and what is explicitly out of frame. Cite IDs. -->

Extend the existing inline configuration path (O3) so each custom OpenCode child can select a model (G1). Resolve explicit bindings before ticket admission (O2), retain semantic model selection and V2 variants at launch, and use the shared child default only for absent models. Native provider mode remains delegated to OpenCode. Cross-provider/account gateway routing is outside this task (C1).

## Complexity profile

<!-- Rating: low | medium | high | unknown. "unknown" is a valid answer; say what
would resolve it. Never sum these into a score. -->

| Dimension    | Rating | Why / what would resolve it                                                 |
| ------------ | ------ | --------------------------------------------------------------------------- |
| scale        | medium | Parser, compiler, admission and launch across three protocols.              |
| technical    | low    | Reuse native config schemas and existing model-plan tickets.                |
| coupling     | medium | Model plan fingerprint and allowed-model catalogue must agree.              |
| requirement  | low    | Explicit models win; defaults only when absent.                             |
| verification | medium | Jest plus isolated OpenCode runtime probes; executable availability varies. |
| risk         | medium | A missed model can be denied by the ticket or routed incorrectly.           |

## Risks

<!-- ID prefix R. Severity: low | medium | high. Source: how the risk was found (catalog,
ADR-NNNN, git history, lens:STRIDE, reviewer, incident memory, …). Claim: the
property the design promises. Refuted by: the observation that would prove the
claim false. -->

| ID  | Risk (impact)                                                                | Severity | Source                                             | Claim                                                                                          | Refuted by                                                          |
| --- | ---------------------------------------------------------------------------- | -------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| R1  | Explicit models are overwritten or excluded from gateway lease.              | medium   | ADR-0090 and O2                                    | Compiler, ticket and catalogue agree on every explicit child model.                            | Child uses primary/default or lease omits its model.                |
| R2  | V1/ACP and V2 schemas or fallback semantics diverge.                         | medium   | Official OpenCode source linked in research report | Preserve explicit refs; default all/subagent/implicit child definitions; preserve V2 variants. | Native config rejects projection or model mismatch.                 |
| R3  | Untrusted inline routing bypasses provider/account isolation.                | medium   | ADR-0217 and risk catalog: auth/input handling     | Validate schema and provider before admission; launch only admitted models.                    | Cross-provider config runs or secrets leak in error.                |
| R4  | Editor saves erase V2 child selections before launch.                        | medium   | O4                                                 | V2 save retains inline configuration and validates task-owned process settings.                | Saved process.env is missing or invalid sandbox settings are saved. |
| R5  | OpenCode settings cannot load because a direct dependency fails compilation. | medium   | O5                                                 | Client directives precede imports; browser reaches OpenCode settings and editor.               | Next build overlay blocks the settings interaction.                 |

## Verification obligations

<!-- ID prefix V. Risk: the R id(s) this obligation discharges.
Independence: self | subagent | fresh-reviewer | tool | other-model | human | real-env
Status: planned | passed | failed | blocked | waived
Evidence: command + result excerpt, commit, or artifact path — not "should pass".
Coverage: which conditions the evidence covers (and which it does not). -->

| ID  | Risk     | Method                                                     | Independence | Evidence                                                                                                                                                                                                                                             | Coverage                                                                                                                                          | Status  |
| --- | -------- | ---------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1,R2    | Failing regression then focused Jest suites.               | tool         | Initial three projector regressions and five whitespace cases failed before fixes; final 151 projector tests pass in .cache/opencode-projector-completion.log; 22 admission/editor tests pass in .cache/opencode-targeted-final.log.                 | V1/ACP/V2 explicit/default/built-in and child command precedence; malformed references.                                                           | passed  |
| V2  | R1,R3    | Compiler and manager integration tests.                    | tool         | Compiler, manager, editor-options and host explicit-model tests passed in .cache/opencode-acceptance-final.log; PII and wiring auditors found no remaining bypass/dormant path.                                                                      | Model allowlist, fingerprint changes, refusals before minting and save validation.                                                                | passed  |
| V3  | R2       | Isolated native runtime probes.                            | real-env     | Latest rerun .cache/opencode-subagent-models/2026-10-21T13-21-49.456Z/results.json: V1 1.19.3, ACP 1.19.3 and V2 2.0.23 each observed review/search/default.                                                                                         | Real native processes with loopback protocol fixture; excludes paid provider/Tauri acceptance.                                                    | passed  |
| V4  | R3       | Preflight audits, lint and generated configuration checks. | tool         | Follow-up root lint exit 0, .cache/opencode-followup-lint.log; focused lint, formatting and i18n checks pass. Follow-up i18n, test-gap and PII audits report no blockers. Earlier capabilities/co-located gates and runtime-only package build pass. | Changed call paths and deterministic repository checks.                                                                                           | passed  |
| V5  | R2,R3,R4 | Broad OpenCode regression.                                 | tool         | .cache/opencode-followup-acceptance.log: 833 tests, 12 suites pass, zero failures. Earlier sandbox and unsupported-version assertions repaired without weakening negative checks.                                                                    | Admission, save, projection, manager and all three protocol adapters.                                                                             | passed  |
| V6  | R3       | Typecheck.                                                 | human        | User explicitly requested skipping typecheck on continuation, 2026-10-21. No subsequent typecheck run.                                                                                                                                               | User-waived check.                                                                                                                                | waived  |
| V7  | R3       | Global static export/build.                                | tool         | Earlier .cache/opencode-static-export.log reported Node-only imports in extension-engine and builtin-artifact-fixture; no complete production app build. Global export gate not rerun during this scoped follow-up.                                  | Existing global gate remains outside C2 follow-up scope.                                                                                          | blocked |
| V8  | R4,R5    | Editor regression, hook tests and browser round trip.      | real-env     | V2 red regression fixed; editor suite 72 tests pass. Hook suites 11 tests pass. Browser creates/reloads/reopens ACP inline config; no build overlay. .cache/opencode-followup-browser-status.json and browser.json.                                  | V2 save/policy controls tested by RTL; actual browser startup and ACP configuration persistence; excludes browser stdio execution without a Host. | passed  |

## Decisions

<!-- ID prefix D. Based on: only the IDs this decision ASSUMES still hold (if one is
later Invalidated, the decision reopens). Name ruled-out hypotheses in the
Decision text, not here.
Action: implement | spike | diagnose | experiment | harden | escalate | scope-down | stop | ship
Reversal trigger: the new evidence that would reopen this decision. -->

| ID  | Date       | Decision                                                                                                  | Action    | Based on       | Reversal trigger                                                                                  |
| --- | ---------- | --------------------------------------------------------------------------------------------------------- | --------- | -------------- | ------------------------------------------------------------------------------------------------- |
| D1  | 2026-10-21 | Reuse inline configuration and include explicit models in the existing model plan before leasing.         | implement | O1,O2,O3,G1,C1 | Native schema or ticket contract cannot represent the selection.                                  |
| D2  | 2026-10-21 | Retain V2 environment on save and share the task-owned launch predicate across fields and validation.     | implement | O4,G1,C2       | Saving V2 fails to retain definitions or exposes process controls for an attached remote service. |
| D3  | 2026-10-21 | Restore directive placement only in the two direct settings dependencies, retaining shared hook behavior. | implement | O5,C2          | Compilation remains blocked or hook behavior changes.                                             |

## Residual risks

<!-- ID prefix X. From: the R / V / H / M ids this residual comes from.
What is still not known or not verified after this round. No invented
percentages. Status: open | accepted | closed. "accepted" needs the user. -->

| ID  | Residual                                       | From | Why still open                                                                                               | Next action                                                           | Status   |
| --- | ---------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | -------- |
| X1  | Earlier two test failures are resolved.        | V5   | No longer open: all 833 affected tests pass.                                                                 | Retain supported/unsupported schema and OpenCode sandbox regressions. | closed   |
| X2  | Full static production build lacks acceptance. | V7   | Existing unrelated Node-only imports fail export gate; excluded by C2. Browser settings blocker is resolved. | Address separately if global export repair is requested.              | open     |
| X3  | Typecheck omitted at the user's request.       | V6   | User waived this check on continuation.                                                                      | Run only if requested later.                                          | accepted |

## Outcome

<!-- ID prefix M. Signals that the ORIGINAL problem improved (validation, not verification).
Status: pending | met | not-met | not-measurable -->

| ID  | Signal                                                                    | How / when measured                                                      | Result                                                                                      | Status |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------ |
| M1  | Two named children retain different models; a third inherits the default. | Regression and native probes before completion.                          | All three native protocols observed review, search and default models.                      | met    |
| M2  | Saving V2 does not erase native child model definitions.                  | Failing regression before follow-up fix, passing editor suite afterward. | Inline environment preserved; task-owned process fields and validation enabled.             | met    |
| M3  | OpenCode settings can load and reopen a saved custom-agent configuration. | Browser retest after directive correction.                               | No Next build overlay; ACP reviewer/search/fallback configuration survives reload and edit. | met    |
