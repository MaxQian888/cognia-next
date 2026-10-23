# Evidence ledger: dependency remediation follow-up

- Status: verifying
- Lane: standard
- Created: 2026-10-22
- Updated: 2026-10-22
- Related: Node/frontend security report; health-recheck-0305; Rust security ledger

## Original request

> 把能修复的漏洞依赖都更新一下，优先处理 Storybook、braces 和 sprintf-js，检查遗留 docs 锁文件，做好兼容性和实际运行验证，保留其他并行修改；修不了的说明原因。

## Knowledge

| ID  | Statement                                                                                                                                         | State    | Basis                                                                                | Depends on |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------ | ---------- |
| O1  | Current root audit has five matches, Sidecar one; legacy docs lock has 35.                                                                        | Verified | health-recheck-0305 per-lock JSON and summary, 2026-10-22                            | -          |
| O2  | Storybook 10.6.2 is published and fixes the critical origin-validation advisory; latest compatible patch is 10.6.3.                               | Verified | npm registry, maintainer GHSA-f2ph-cmg5-wxc8                                         | -          |
| O3  | Audit-reported braces 3.0.4, sprintf-js 1.1.4 and elliptic 6.6.2 do not exist in npm. Latest releases remain 3.0.3, 1.1.3 and 6.6.1.              | Verified | Exact npm view requests return E404; latest metadata retained under remediation-0330 | -          |
| O4  | Current fast-glob/micromatch and gray-matter/mammoth parents retain the affected transitive families.                                             | Verified | Live npm dependency metadata, 2026-10-22                                             | -          |
| C1  | Preserve parallel work; no broad staging, reset, stash or unrelated dependency refresh.                                                           | Verified | User request and concurrent-tree-safety                                              | -          |
| G1  | Upgrade safely fixable dependencies, investigate prioritized blocked packages and stale docs lock, verify actual behavior, and explain residuals. | Agreed   | User request                                                                         | -          |

## Problem frame

Update the coherent Storybook package family to a published security patch. Verify whether prioritized transitive dependencies and Rust parents have released safe fixes. Keep the legacy docs lock aligned with the root workspace contract without deleting concurrent work. Use focused tests and actual Storybook startup/rendering; do not claim unavailable patches or production deployment.

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                               |
| ------------ | ------ | ----------------------------------------------------------------------------------------- |
| scale        | medium | Root workspace graph, Sidecar, legacy docs graph and Rust residuals.                      |
| technical    | medium | Registry audit ranges disagree with published releases.                                   |
| coupling     | high   | Storybook packages must share a release; lockfile generation can refresh unrelated edges. |
| requirement  | low    | Upgrade, real validation and explicit residual reasons authorized.                        |
| verification | high   | Need real browser/runtime evidence; disk is limited and other sessions share the tree.    |
| risk         | medium | Patch updates must preserve development and document-processing functionality.            |

## Risks

| ID  | Risk (impact)                                                                   | Severity | Source                                                | Claim                                                                                  | Refuted by                                                           |
| --- | ------------------------------------------------------------------------------- | -------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| R1  | Updating only one Storybook package creates incompatible framework/addon peers. | high     | Storybook release constraints and maintainer advisory | Coherent patched family starts and renders a real existing story.                      | Peer error, build failure or browser runtime error caused by update. |
| R2  | Transitive overrides force nonexistent or incompatible major versions.          | high     | npm E404 evidence, prior dependency incident memory   | Only published compatible changes are applied; unresolved packages remain explicit.    | Unresolvable lock or broken representative runtime behavior.         |
| R3  | Shared work is overwritten by manifest/lock refresh.                            | high     | concurrent-tree-safety                                | Baseline importer/package snapshots preserve unrelated changes.                        | Unrelated records removed or refreshed by our writes.                |
| R4  | Stale docs lock silently reintroduces old packages outside root workspace.      | medium   | Workspace configuration and deployment workflow       | Docs has a verified consistent install path and stale graph cannot silently govern it. | Docs resolution remains stale or frozen install contract fails.      |

## Verification obligations

| ID  | Risk | Method                                                                                                         | Independence | Evidence                                                                                                                                                                                                        | Coverage                                                                                                  | Status |
| --- | ---- | -------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------ |
| V1  | R1   | Re-audit root and verify installed Storybook versions/peer alignment.                                          | tool         | root-audit-after.json and final-audits: critical matches 2 to 0; all six installed packages 10.6.3; no new family peer mismatch                                                                                 | Root graph and package family                                                                             | passed |
| V2  | R1   | Real dev server, existing story render and browser inspection.                                                 | real-env     | storybook-runtime.log; StatusBadge en/light and zh/dark screenshots; AnalyzingImage screenshot; CSP restricts frame ancestors; untrusted MCP origin 403; trusted initialize 200 with serverInfo 10.6.3          | Original webpack config on macOS, Chromium, 3757 indexed stories                                          | passed |
| V3  | R2   | Registry/parent metadata plus focused runtime tests and full final audits.                                     | tool         | unpublished-fix-versions.json; npm latest and crates.io parent dependency JSON; focused-tests.log: 33 suites/742 passed; final-audits scans 22 locks plus root prod                                             | All current matches explained; no false clean-audit claim                                                 | passed |
| V4  | R3   | Before/after importer/package and path-scoped diff review.                                                     | tool         | final-scope-check.json: six Storybook manifest fields changed; all other workspace importers and unrelated dependency records preserved; preserved-dependency-files.json verifies untouched Rust/Sidecar hashes | Task baseline versus final manifest/lock delta, scoped status and diff review                             | passed |
| V5  | R4   | Inspect docs install ownership, repair stale-lock handling, run frozen resolution and focused docs validation. | tool         | docs-frozen-install.log: 55-project root workspace discovered; docs-typecheck.log passed; docs-build.log: successful 2228-page static export and search-index preparation                                       | Removed stale independent lock; root docs importer still Next 16.4.2; preflight found no remaining caller | passed |

## Decisions

| ID  | Date       | Decision                                                                                   | Action    | Based on               | Reversal trigger                                             |
| --- | ---------- | ------------------------------------------------------------------------------------------ | --------- | ---------------------- | ------------------------------------------------------------ |
| D1  | 2026-10-22 | Upgrade the coherent Storybook patch family; do not force unavailable transitive releases. | implement | O1, O2, O3, O4, C1, G1 | Published parent patch can remove affected edges compatibly. |

## Residual risks

| ID  | Residual                                                                                | From | Why still open                                                                                                                  | Next action                                                                            | Status |
| --- | --------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------ |
| X1  | Root retains braces/sprintf-js/elliptic and Sidecar retains braces.                     | R2   | Fixed versions reported by audit are unpublished; current parents keep affected families.                                       | Track published compatible patches or separately review parent/library migration.      | open   |
| X2  | Rust retains five main and one diagnostic match, plus maintenance/GLib warnings.        | R2   | Latest updater still requires zip ^4, liteparse lopdf ^0.38; rsa has no patched stable release.                                 | Upstream fixes or a separately reviewed migration; keep existing exceptions unchanged. | open   |
| X3  | Full root typecheck and lint do not pass in the shared tree.                            | R3   | TS6053 files disappeared during another session's migration; lint reports unused LocalCharacterPackSignature outside this task. | Owners finish concurrent migration; rerun full gates on stable tree.                   | open   |
| X4  | Selected existing story has missing translation keys and a next-themes console warning. | R1   | Real rendering succeeds and page errors are empty, but a clean console is not claimed.                                          | Repair story fixture/provider warnings in a separate scoped UI change.                 | open   |
| X5  | Cargo yanked status remains unverified.                                                 | R2   | Initial registry queries timed out; advisory scans complete with no-yanked.                                                     | Retry registry yanked checks when available.                                           | open   |

## Outcome

| ID  | Signal                                                                                                 | How / when measured                              | Result                                                                                                                                                                      | Status |
| --- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | Published security fixes installed and verified; unresolved dependencies have evidence-backed reasons. | Final audit and runtime verification, 2026-10-22 | Storybook 10.6.3 renders and enforces Origin/CSP restrictions; root critical 2 to 0; legacy docs lock retired with frozen/type/build validation; blocked patches documented | met    |

## Final evidence notes

Raw evidence is under `.cache/security/2026-10-22/remediation-0330/`. The published [remediation report](../reports/2026-10-22-dependency-remediation.md) records commands, findings and sources. Read-only preflight cleared package alignment, static-export boundaries and docs-lock ownership. No coverage command was run because coverage was not requested. No unrelated source or configuration was repaired, staged or committed. Storybook verification used the unchanged production repository config, and its temporary server and isolated browser sessions were stopped after acceptance.
