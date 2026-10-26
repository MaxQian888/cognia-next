# Evidence ledger: LaTeX plugin security upgrade

- Status: verifying
- Lane: standard
- Created: 2026-10-22
- Updated: 2026-10-22
- Related: ADR-0210; source commit 76567ee5deaaf279e6f3945e9ca3aecb880e45ac

## Original request

> 那就把 LaTeX 插件也更新一下，做好兼容性和实际运行验证，注意保留其他并行修改

## Knowledge

| ID  | Statement                                                                                                                                                                                      | State    | Basis                                                                                            | Depends on |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------ | ---------- |
| O1  | Original plugin vendors Pi SDK/TUI 0.85.1; its installed graph has three affected-package aggregates.                                                                                          | Verified | audit-before.json; original embedded npm-shrinkwrap locks Undici 8.9.0 and brace-expansion 5.0.9 | -          |
| O2  | Upstream origin/main 243461a still pins 0.85.1; original upstream worktree is clean and provisioned.                                                                                           | Verified | git fetch/status; isolated branch created from 243461a1c9a77dbc0895730713752ba467153a4e          | -          |
| O3  | Pi SDK/TUI 1.3.0 installs Undici 8.10.2 and brace-expansion 5.0.12; full audit reports zero known advisories.                                                                                  | Verified | Clean upstream install, installed-version readback, upstream-audit-release.json                  | -          |
| O4  | Cognia bundle pins Pi 1.0.2. Both 1.0.2 and 1.3.0 load the prepared Cognia wrapper and enforce its limits.                                                                                     | Verified | deploy/bundle pins; hosted-runtime-1.0.2.json and hosted-runtime-1.3.0.json                      | -          |
| O5  | npm workspace links violate Cognia's prepare policy; copying TypeScript into node_modules also fails Node's type stripping. Regular ESM bridges to the unchanged source resolve both failures. | Verified | old-prepare-result.json; prepare-node-runtime-before.log and after.log; final archive CLI smoke  | -          |
| C1  | Preserve concurrent edits, byte-identical vendor provenance, and host approval boundaries.                                                                                                     | Verified | User request, ADR-0210, source parity checks                                                     | -          |
| G1  | Update the plugin, remove the vulnerable dependency graph, and verify compatibility and actual execution.                                                                                      | Agreed   | User request, 2026-10-22                                                                         | -          |

## Problem frame

Upgrade the upstream adapter on an isolated local branch, refresh the Cognia plugin through its canonical sync script, then validate the final install ZIP with actual Pi and local Tectonic/PDFKit. Use a synthetic document and isolated state. Provider/model calls, publishing, and changing real user documents are outside this acceptance run.

All evidence paths below are relative to `.cache/security/2026-10-22/latex-plugin/` unless stated otherwise. This verifies the plugin's actual CLI and hosted extension runtime, not installation through a running Cognia desktop UI.

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                                     |
| ------------ | ------ | ----------------------------------------------------------------------------------------------- |
| scale        | medium | Upstream dependency migration, latest latex-kit extraction, and archive preparation.            |
| technical    | medium | Actual SDK hook API changed; integration test adapted and exercised on both supported hosts.    |
| coupling     | medium | Node package resolution, host symlink policy, and Pi host-owned packages must agree.            |
| requirement  | low    | Upgrade and real execution explicitly authorized.                                               |
| verification | high   | Real extension loading plus native offline compilation, text extraction and page rasterization. |
| risk         | high   | Session control, approval boundaries, source provenance and concurrent work preservation.       |

## Risks

| ID  | Risk (impact)                                                                         | Severity | Source                              | Claim                                                                                                                 | Refuted by                                                              |
| --- | ------------------------------------------------------------------------------------- | -------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| R1  | SDK migration or minimum version prevents hosted sessions or opens shell access.      | high     | Adapter hooks and bundled host pins | Pi 1.0.2 and 1.3.0 load eight tools, deny host calls and user shell, bind context, and inspect a real project.        | Real loader or boundary assertion fails.                                |
| R2  | Refresh or archive omits required source.                                             | medium   | Canonical sync and build            | Vendor equals the source commit and the built ZIP loads.                                                              | Vendor hash mismatch or missing runtime import.                         |
| R3  | Lock-only audit hides vulnerable installed packages.                                  | high     | Prior embedded shrinkwrap           | Clean development install and prepared runtime audit both report zero known advisories.                               | Old installed versions or a nonzero audit.                              |
| R4  | Mocked checks hide broken compilation/rendering.                                      | medium   | Actual document acceptance          | Synthetic document imports, builds and renders using real native executables.                                         | Missing PDF/text/PNG or unsuccessful job.                               |
| R5  | Other sessions' changes are overwritten.                                              | high     | Concurrent tree                     | Writes remain scoped; original upstream worktree stays clean.                                                         | Our writes alter unrelated files.                                       |
| R6  | Preparation either leaves forbidden links or places executable TS under node_modules. | high     | Reproduced host and Node failures   | Locked npm ci with scripts disabled creates checked regular ESM bridges; no source/lock drift, no links, no host SDK. | Host link scan, source byte comparison, or actual Node execution fails. |

## Verification obligations

| ID  | Risk | Method                                                                                  | Independence | Evidence                                                                                                                                                                                                                      | Coverage                                                                                                 | Status |
| --- | ---- | --------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------ |
| V1  | R1   | Upstream typecheck and full native-provisioned suite.                                   | tool         | upstream-typecheck-release.log; upstream-tests-release.log: 368 tests, 367 passed, 0 failed, 1 Docker-only skip                                                                                                               | Adapter, approval, workflows, actual native builds and prepare tests                                     | passed |
| V2  | R1   | Load the final extracted Cognia wrapper with real SDKs.                                 | real-env     | hosted-runtime-1.0.2.json and hosted-runtime-1.3.0.json; exact eight tools, blocked host tool, shell exit 126, command message, bound prompt and main.tex inspection                                                          | Cognia bundled Pi 1.0.2 and current 1.3.0, no provider request                                           | passed |
| V3  | R2   | Source parity, focused host tests and build.                                            | tool         | vendor-check-release.log; cognia-tests-release.log: 7 suites, 106 passed; built 0.1.1 ZIP, extracted and executed                                                                                                             | 231 source files, manifest, argv, preparation planner, wrapper and archive                               | passed |
| V4  | R3   | Clean install and installed readback, full and runtime npm audits.                      | tool         | upstream-install.log; upstream-audit-release.json and runtime-audit-release.json: all severities zero                                                                                                                         | Development graph and final prepared production graph                                                    | passed |
| V5  | R4   | Import/build/check/extract/rasterize/save synthetic document.                           | real-env     | cli-runtime-smoke.log; cli-doctor.json: BUILD_READY; cli-build.json; cli-check.json; cli-text.json; cli-pages.json; output/compatibility.pdf and .png; page visually inspected                                                | Node 26.12.1, macOS ARM64, Tectonic and PDFKit, isolated state                                           | passed |
| V6  | R5   | Baseline snapshot and scoped final diff/status review.                                  | tool         | baseline-files.json, baseline-status.txt, final-plugin-status.txt; original upstream git status clean; final source worktree clean                                                                                            | Plugin paths plus this ledger and the security-report follow-up; no broad staging/reset/stash            | passed |
| V7  | R6   | Reproduced failures, regression tests, fresh archive prepare and actual Node execution. | real-env     | prepare-node-runtime-before.log; upstream-tests-release.log; installed-release-prepare.log; installed-runtime-validation.json: no links, unchanged source, marker present and host packages omitted; local-plugin-prepare.log | npm ci, ordinary workspace bridges, refused external/nested links and escaping exports, real CLI startup | passed |

## Decisions

| ID  | Date       | Decision                                                                                                                 | Action    | Based on           | Reversal trigger                                                               |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------ | --------- | ------------------ | ------------------------------------------------------------------------------ |
| D1  | 2026-10-22 | Commit auditable source changes on isolated local codex/fix-latex-pi-security, then archive that commit; do not push.    | implement | O1, O2, O3, C1, G1 | New SDK cannot preserve session boundaries.                                    |
| D2  | 2026-10-22 | Keep bundled Pi unchanged; declare minimum 1.0.2 and peer ^1.0.2, with development baseline 1.3.0.                       | implement | O4                 | Either tested host fails real acceptance.                                      |
| D3  | 2026-10-22 | Use checked regular ESM bridges during prepare; retain host's no-symlink guard and disable dependency lifecycle scripts. | harden    | O5, C1             | Source package interface no longer fits the explicitly validated single entry. |

## Residual risks

| ID  | Residual                                                                            | From | Why still open                                                                               | Next action                                                                                      | Status |
| --- | ----------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------ |
| X1  | Source commits exist only locally; plugin ZIP is built locally.                     | R2   | Publishing was not requested.                                                                | Push upstream branch and publish ZIP when release is requested; retain local worktree meanwhile. | open   |
| X2  | Full repository typecheck has unrelated concurrent-tree diagnostics.                | R5   | Current errors are outside the plugin; unrelated changes preserved.                          | Owners of the affected paths resolve diagnostics; plugin/upstream checks remain separate.        | open   |
| X3  | Native acceptance is macOS ARM64 with Tectonic/PDFKit; Docker Texlive test skipped. | R4   | Docker backend unavailable and outside this local runtime claim.                             | Run Docker/platform acceptance before extending the support claim.                               | open   |
| X4  | Cognia desktop UI installation flow was not driven.                                 | R4   | Runtime was exercised through actual extracted archive, host prepare command and SDK loader. | Run desktop UI acceptance before claiming UI installation acceptance.                            | open   |
| X5  | Static-export gate exits with ENOBUFS while listing the large tracked tree.         | R2   | The gate fails before analysis; the read-only static-export audit found no plugin violation. | Repair gate buffering separately and rerun repository-wide gate.                                 | open   |

## Outcome

| ID  | Signal                                                                                  | How / when measured        | Result                                                                                                           | Status |
| --- | --------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | Plugin upgrade removes known dependency findings and retains controlled real execution. | V1–V7 on macOS, 2026-10-22 | Plugin 0.1.1; zero known audit findings; Pi 1.0.2/1.3.0 compatibility; real PDF/text/PNG generated and inspected | met    |

## Final review notes

Read-only wiring, static-export and PII reviewers found no remaining actionable blocker after the compatibility and preparation fixes. The frontend entry stays separate from Node vendor execution; latex-kit remains pure parsing/analysis. No new outbound document path was introduced. Full repository lint passed; the focused plugin lint/format checks passed. Full typecheck diagnostics and initial ENOSPC failures are retained separately from passing plugin checks. Only this task's disposable experiment installations were removed to recover space; no other session's files or changes were cleaned. The validated cloned toolchain/render resources were moved into the local plugin runtime after archive acceptance; original upstream resources remain untouched. `local-plugin-doctor.json` has no blocking codes; `local-plugin-runtime.json` records a forced clean native build with cacheHit=false and successful text extraction. Toolchain resources remain ignored and absent from the ZIP.
