# Evidence ledger: full typecheck repair

- Status: verifying
- Lane: standard
- Created: 2026-10-23
- Updated: 2026-10-23
- Related: <!-- spec / plan / ADR / issue / commit links -->

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> 把这些 typecheck 问题都修复，先解决 plugin-contract 的类型解析和声明文件问题，再处理剩余错误，最后重跑完整 typecheck，注意保留其他会话的改动。

## Knowledge

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement                                                                                                                    | State    | Basis                                                                                                              | Depends on |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ | ---------- |
| O1  | Contract typecheck reports 10,347 diagnostics and cannot resolve canonical subpaths without dist.                            | Verified | macOS 2026-10-23: .cache/typecheck/2026-10-23-fix/plugin-contract-before.log; failing module-resolution regression | -          |
| H1  | Replacing the inherited alias map makes checks depend on incomplete declaration builds.                                      | Verified | Contract tsconfig replaces paths; source-condition diagnostic reduced the previous 10,346 errors to 143            | O1         |
| G1  | Repair contract resolution first, fix residual errors, and pass the complete TypeScript check matrix.                        | Agreed   | User request, 2026-10-23                                                                                           | -          |
| C1  | Preserve all concurrent changes and do not weaken tests or compiler strictness.                                              | Verified | User request and repository AGENTS.md, 2026-10-23                                                                  | -          |
| O2  | Removing the local paths override makes contract typecheck pass with zero diagnostics.                                       | Verified | .cache/typecheck/2026-10-23-fix/plugin-contract-source.log; module-resolution regression passes                    | O1,H1      |
| O3  | Legacy declaration bundling exhausts its 16 GiB worker heap; native emission followed by declaration-only bundling succeeds. | Verified | plugin-contract-build.log and plugin-contract-build-fixed.log fail; plugin-contract-build-native.log passes        | -          |
| O4  | Another session corrected the image-array annotation and malformed label fixture during this repair.                         | Observed | Final owning source and focused tests, 2026-10-23; those fixes were preserved                                      | C1         |

## Problem frame

Restore reliable source resolution and declaration generation, then repair the
remaining genuine type errors (G1). Existing behavior and concurrent edits must
remain intact (C1). Validation includes the SDK consumer and the full TypeScript
matrix; Rust, coverage, deployment, and provider acceptance are outside this task.

## Complexity profile

<!-- Rating: low | medium | high | unknown. "unknown" is a valid answer; say what
would resolve it. Never sum these into a score. -->

| Dimension    | Rating | Why / what would resolve it                                       |
| ------------ | ------ | ----------------------------------------------------------------- |
| scale        | medium | Package configuration, sidecar, CLI, and test fixtures            |
| technical    | medium | Source aliases and dual-format declaration generation             |
| coupling     | medium | Contract subpaths are shared with host and SDK consumers          |
| requirement  | low    | User explicitly authorized repair and complete verification       |
| verification | medium | Headless checks suffice; shared files can change mid-run          |
| risk         | medium | Must preserve contract shapes, strictness, and concurrent changes |

## Risks

<!-- ID prefix R. Severity: low | medium | high. Source: how the risk was found (catalog,
ADR-NNNN, git history, lens:STRIDE, reviewer, incident memory, …). Claim: the
property the design promises. Refuted by: the observation that would prove the
claim false. -->

| ID  | Risk (impact)                                               | Severity | Source                                  | Claim                                                          | Refuted by                                 |
| --- | ----------------------------------------------------------- | -------- | --------------------------------------- | -------------------------------------------------------------- | ------------------------------------------ |
| R1  | Checks pass only because stale build artifacts exist.       | medium   | ADR-0068; observed missing declarations | Resolve source without dist and verify new declaration output. | Missing canonical source or emitted export |
| R2  | Type fixes hide a runtime or fixture defect.                | medium   | Repository behavior-test rules          | Preserve behavior with focused tests and strict typechecks.    | Changed behavior or weakened assertion     |
| R3  | Shared-tree edits are overwritten or swept into the repair. | medium   | concurrent-tree-safety skill            | Apply narrow patches and compare with the initial snapshot.    | Lost unrelated changes                     |

## Verification obligations

<!-- ID prefix V. Risk: the R id(s) this obligation discharges.
Independence: self | subagent | fresh-reviewer | tool | other-model | human | real-env
Status: planned | passed | failed | blocked | waived
Evidence: command + result excerpt, commit, or artifact path — not "should pass".
Coverage: which conditions the evidence covers (and which it does not). -->

| ID  | Risk  | Method                                                                                | Independence | Evidence                                                                                                                                                                                      | Coverage                                                                                                                       | Status  |
| --- | ----- | ------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------- |
| V1  | R1    | Regression resolving source with dist unavailable; declaration build and SDK consumer | tool         | Regression failed before and passed after; contract build passed with all 576 public entry targets and 1164 declaration files; packed SDK verified 55 typed exports                           | Self subpaths, sibling aliases, ESM/CJS, real emitted types, isolated consumer                                                 | passed  |
| V2  | R2    | Focused tests for changed source and fixtures                                         | tool         | 204 sidecar tests, 190 Jest tests across six suites, and 11 tooling/build tests passed                                                                                                        | Compaction, message estimation, brain profile, inbound projection, metadata race fixture, compiler resolution, runtime exports | passed  |
| V3  | R1,R2 | Full root, workspace, sidecar, services, and template checks; lint and formatting     | tool         | Root plus all five sidecar configurations passed; all 50 workspace typecheck scripts, seven services and two templates passed; pnpm lint passed; scoped Prettier and diff checks passed       | Same complete TypeScript matrix as the audit                                                                                   | passed  |
| V4  | R3    | Starting snapshot, narrow patches, final diff and status review                       | tool         | .cache/typecheck/2026-10-23-fix/diff-before.patch, status-before.txt, status-final.txt and source-declarations-audit.json                                                                     | Owned hunks reviewed; only generated files from the failed native probe were archived, no tracked files moved                  | passed  |
| V5  | R1    | Additional author-declaration consistency check and static-export scan                | tool         | author-types:check passed: 85 declarations up to date; buffered static-export scan reports three pre-existing imports outside this change; scoped static-export, PII and wiring reviews clean | Additional repository gates beyond the TypeScript matrix                                                                       | blocked |

## Decisions

<!-- ID prefix D. Based on: only the IDs this decision ASSUMES still hold (if one is
later Invalidated, the decision reopens). Name ruled-out hypotheses in the
Decision text, not here.
Action: implement | spike | diagnose | experiment | harden | escalate | scope-down | stop | ship
Reversal trigger: the new evidence that would reopen this decision. -->

| ID  | Date       | Decision                                                                                                                                                                                                     | Action    | Based on    | Reversal trigger                                                         |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ----------- | ------------------------------------------------------------------------ |
| D1  | 2026-10-23 | Inherit canonical source aliases before repairing residual diagnostics; retain export and runtime contracts.                                                                                                 | implement | O1,H1,G1,C1 | Canonical resolution or declaration output still fails                   |
| D2  | 2026-10-23 | Add a build orchestrator because tsup configuration alone cannot sequence native declaration emission and bundling with failure cleanup. Keep strict checks, explicit output directories, and noEmitOnError. | implement | O2,O3,C1    | Missing exports, leaked source output, or changed declaration signatures |
| D3  | 2026-10-23 | Retain the full image-array and label fixes made by the other session; add only the remaining metadata fixture cast.                                                                                         | implement | O4,C1       | Focused behavior tests or final typechecks fail                          |

## Residual risks

<!-- ID prefix X. From: the R / V / H / M ids this residual comes from.
What is still not known or not verified after this round. No invented
percentages. Status: open | accepted | closed. "accepted" needs the user. -->

| ID  | Residual                                                                                                                                                                                                                          | From | Why still open                                                        | Next action                                                   | Status |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------- | ------------------------------------------------------------- | ------ |
| X1  | The unmodified static-export gate uses a Git-output buffer smaller than this repository file list. Raising that buffer in-process reveals three pre-existing Node imports in extension-engine.ts and builtin-artifact-fixture.ts. | V5   | These files and the gate are outside the authorized typecheck repair. | Track separately; no allowlist or gate weakening was applied. | open   |
| X2  | Author-declaration consistency was rerun after generated scratch declarations were removed.                                                                                                                                       | V5   | Resolved: all 85 author declarations are up to date.                  | No remaining action.                                          | closed |

## Outcome

<!-- ID prefix M. Signals that the ORIGINAL problem improved (validation, not verification).
Status: pending | met | not-met | not-measurable -->

| ID  | Signal                                                               | How / when measured               | Result                                                                                                                    | Status |
| --- | -------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | Complete TypeScript matrix passes with concurrent changes preserved. | Final checks on macOS, 2026-10-23 | Root, all sidecars, all 50 workspaces, seven services and two templates passed; no commits or destructive tree operations | met    |

## Implementation and artifact safety

The contract retains its public export paths. Its config inherits canonical
source aliases; the two boundary shims explicitly re-export their runtime
values so a multi-entry ESM build retains them. The new build script runs the
normal JS build, uses native TypeScript to check and emit real declarations into
a unique cache directory, then bundles only those declarations. Explicit
rootDir, outDir, declarationDir, and noEmitOnError prevent output beside source;
finally cleanup removes staging on success or failure. All 576 public entries
have JS, CJS, ESM declarations and CJS declarations, with no missing artifacts
or actual host/absolute imports in the bundled declarations.

The first diagnostic native-emission probe omitted rootDir. Despite reporting
TS5011, it emitted 6259 generated declarations beside source. These were
identified by creation interval, corresponding TypeScript source, Git tracking,
and content comparison with a safe staged emission. Only those generated files
were moved, then compressed under the task cache; no tracked files were moved.
The final production build uses explicit directories and noEmitOnError. The
complete root check and lint were rerun successfully after cleanup.

The sidecar repair preserves request routing and PII gates. It narrows optional
compaction settings, retains instruction/message structure during token
estimation, and validates numeric usage before adding estimated new output.
The latter has a behavioral regression that failed before the fix and passes
after it. Fixture changes retain all previous runtime assertions.

Raw logs and the complete check matrix are under
`.cache/typecheck/2026-10-23-fix/`; `full-matrix-results.json` consolidates the
successful final root run and every workspace/service/template run. Failed
initial runs remain separately available for diagnosis.

The requested TypeScript repair is complete. This ledger remains in verifying
only to retain X1's supplemental, repository-wide static-export findings;
there are no outstanding TypeScript verification obligations. The findings
are at `lib/browser/extension-engine.ts:450` and
`lib/plugin/core/builtin-artifact-fixture.ts:15,16`, outside the owned paths.
The stock scanner also exceeds its default child-process output buffer;
rerunning its unchanged body with a 16 MiB buffer produces those three findings.
