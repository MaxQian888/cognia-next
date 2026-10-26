# Evidence ledger: backup sync gap audit

- Status: verifying
- Lane: standard
- Created: 2026-10-21
- Updated: 2026-10-21
- Related: [Audit report](../reports/2026-10-21-backup-sync-gap-audit.md); ADR-0001; ADR-0215

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> 我感觉现在cognia对备份和同步的支持存在缺口，你检查一下

## Knowledge

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement                                                                                                                                                                          | State    | Basis                                                                                                                            | Depends on |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| O1  | User suspects backup and sync gaps without a concrete failure report.                                                                                                              | Observed | User request, 2026-10-21                                                                                                         | -          |
| H1  | Durable user data is excluded from portable backups or account sync.                                                                                                               | Verified | Catalog/source plus isolated project/folder round trip on macOS Jest, 2026-10-21                                                 | O1         |
| H2  | Capabilities exist but are fragmented or unavailable in production.                                                                                                                | Verified | accountSyncEnabled production default false; three independent sync models, 2026-10-21; deployed flag not inspected              | O1         |
| H3  | Export exists but recovery, scheduling, or large-data handling is incomplete.                                                                                                      | Verified | Key-loss fixture; provider recovery trace; remote size guard; mobile dirty predicate, 2026-10-21                                 | O1         |
| G1  | Identify confirmed gaps, consequences, verification limits, and repair priorities.                                                                                                 | Agreed   | User inspection request, 2026-10-21                                                                                              | -          |
| C1  | Inspect source and isolated tests without changing application behavior or live user data.                                                                                         | Verified | Authorized inspection scope, 2026-10-21                                                                                          | G1         |
| O2  | Full backup preserves session project/folder ids but omits the referenced records in both v3 and v4.                                                                               | Verified | Isolated seeded IndexedDB builder/import fixture, 2026-10-21                                                                     | H1         |
| O3  | Auto-key loss/replacement prevents decryption with the new key; inspected data UI has no key export flow.                                                                          | Verified | Key module, snapshot registry, UI trace and AES fixture, 2026-10-21                                                              | H3         |
| O4  | GitHub and Drive have upload-only in-app integrations; downloaded files can use the common importer.                                                                               | Verified | Destination/card source comparison with WebDAV, 2026-10-21                                                                       | H3         |
| O5  | Existing focused suites have one stale OAuth mock failure; corrected copied mock passes 7 tests.                                                                                   | Verified | 26 existing suites: 324 passed, 1 failed; isolated OAuth fixture: 7 passed, 2026-10-21                                           | -          |
| O6  | Local streaming paths exist; remote v3 paths enforce size limits; account sync lacks blobs and compaction.                                                                         | Verified | Builders, reader tests, sync server routes and quota code, 2026-10-21                                                            | H3         |
| H4  | Backup-key rotation can invalidate unrelated credential ciphertext.                                                                                                                | Verified | Fresh-reviewer rotation fixture: three real-crypto cases passed, desktop plugin and browser reboot boundaries, 2026-10-21        | O3         |
| H5  | WebDAV restore cannot apply a valid backup containing portable retrieval keys.                                                                                                     | Verified | Fresh-reviewer transport-only-mocked DEK/envelope/import fixture reproduces missing-passphrase error, 2026-10-21                 | O6         |
| H6  | Mobile upload metadata itself can trigger repeated uploads without data edits.                                                                                                     | Verified | Two real settings/history/orchestration cases reproduce missed data and redundant uploads under different timestamps, 2026-10-21 | H3         |
| O7  | Rotation immediately breaks prior install-key plugin ciphertext and makes browser Logto vault reads return null after next provisioning; native desktop Logto is unaffected.       | Verified | rotation-coupling.test.ts: 3 passed, synthetic stores and real crypto, 2026-10-21                                                | H4         |
| O8  | DEK-bearing WebDAV backups decrypt and migrate, then fail in the importer because the nested-key passphrase is absent.                                                             | Verified | webdav-retrieval-restore.test.ts: 1 passed, actual restore/apply boundary, 2026-10-21                                            | H5         |
| O9  | A late session/message write can yield a checksum-valid v4 backup and restored orphan message.                                                                                     | Verified | concurrent-export.test.ts: encode/decode/import counterexample passed, 2026-10-21                                                | -          |
| O10 | Account-sync operation plaintext above 512 KiB stays pending while smaller rows can continue syncing.                                                                              | Verified | Protocol limit and pusher test: 1 passed, 15 skipped, fresh reviewer, 2026-10-21                                                 | -          |
| O11 | User authorized F2/F7/F8 production fixes, then F1 coverage and a final adversarial review.                                                                                        | Observed | User instruction, 2026-10-21; supersedes earlier inspection-only C1                                                              | G1         |
| O12 | Stable install encryption roots preserve live secrets across rotation; WebDAV unwrap receives its passphrase; emitted-parent membership prevents the original orphan-message case. | Verified | Real crypto/native-cache/headless fixtures and importer regressions; final aggregate, 2026-10-21                                 | O11        |
| O13 | Both backup formats now carry 17 additional authored tables with scoped selection, graph remapping and monotonic counters.                                                         | Verified | 501-row pagination, clean restore, duplicate/skip/overwrite, rollback and store regressions, 2026-10-21                          | O11        |
| O14 | Final verification passed 86 suites / 817 tests, root typecheck, root lint and governance; static export has three unrelated-path blockers.                                        | Verified | .cache/backup-sync-verification final logs, exit codes; fresh reviewer closure, 2026-10-21                                       | O12,O13    |

## Problem frame

<!-- One paragraph: the problem we are choosing to solve now, the outcome that
would show it is solved, and what is explicitly out of frame. Cite IDs. -->

Inspect export/import coverage, provider recovery paths, runtime mounting, account-sync policies, and existing tests (G1). Distinguish deliberate exclusions, defects, and unverified real environments. Live restores and remote writes are outside this audit (C1). CodeGraph has no index; use direct source navigation.

## Complexity profile

<!-- Rating: low | medium | high | unknown. "unknown" is a valid answer; say what
would resolve it. Never sum these into a score. -->

| Dimension    | Rating | Why / what would resolve it                                                                                                    |
| ------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| scale        | high   | 392 static tables, 60 portable bindings, 57 companion protocol tables, six account-sync tables, attachment and state adapters. |
| technical    | medium | Existing codecs and merge engine exercised with fake IndexedDB and transport fixtures.                                         |
| coupling     | high   | Missing parents, device keys, filesystem sources, provider auth and ownership affect recovery.                                 |
| requirement  | low    | Deliver inspection and repair priorities; implementation trade-offs remain future decisions.                                   |
| verification | high   | Local checks completed; native clean-install, two-device and real-provider acceptance require dedicated environments (X6).     |
| risk         | high   | Misstating recoverability can hide permanent data loss. No live restores performed.                                            |

## Risks

<!-- ID prefix R. Severity: low | medium | high. Source: how the risk was found (catalog,
ADR-NNNN, git history, lens:STRIDE, reviewer, incident memory, …). Claim: the
property the design promises. Refuted by: the observation that would prove the
claim false. -->

| ID  | Risk (impact)                                                                                                 | Severity | Source                                        | Claim                                                                             | Refuted by                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| R1  | Full backup silently omits durable user data.                                                                 | high     | FMEA: data inventory                          | Data is portable or explicitly excluded.                                          | Authored data has no export section or exclusion.                                                |
| R2  | Remote upload cannot be recovered in the advertised workflow.                                                 | high     | FMEA: provider lifecycle                      | Each destination has a recovery path.                                             | Upload-only destination without list/download/import handoff.                                    |
| R3  | Sync UI exceeds actual replication or availability.                                                           | medium   | ADR-0215; runtime wiring                      | Flags and data policies match UI behavior.                                        | Production disabled or assets/references absent.                                                 |
| R4  | Size, key loss, scheduling, or retention prevents recovery.                                                   | high     | Failure injection checklist                   | Backups remain recoverable under practical conditions.                            | Export size ceiling, lost key, or overwrite defeats recovery.                                    |
| R5  | Key rotation destroys access to unrelated locally stored credentials.                                         | high     | Fresh adversarial review: hidden key coupling | Rotation affects only backups or migrates dependent ciphertext.                   | Plugin secret decrypt fails after backup-key rotation.                                           |
| R6  | WebDAV recovery rejects an otherwise valid portable encrypted backup.                                         | high     | Fresh adversarial review: key handoff         | Successful outer decryption supplies importer key unwrap passphrase.              | DEK-bearing snapshot fails with missing-passphrase error.                                        |
| R7  | Streaming export mixes records from different database moments.                                               | high     | Fresh failure hunt: concurrent writes         | A successful backup preserves parent/child consistency.                           | A session created after session export contributes a message without its session.                |
| R8  | New graph coverage can lose pages, leak credentials, change immutable authority or leave stale runtime state. | high     | Implementation adversarial review             | Shared adapter preserves content, graph identity, consent and runtime projection. | Pagination, secret, immutable-version, reference, runtime or failure-injection regression fails. |
| R9  | Repository-wide validation may be mistaken for production export acceptance.                                  | medium   | Static-export gate                            | Report actual gate scope and all unresolved export blockers.                      | Node-only imports remain or real device behavior is unverified.                                  |

## Verification obligations

<!-- ID prefix V. Risk: the R id(s) this obligation discharges.
Independence: self | subagent | fresh-reviewer | tool | other-model | human | real-env
Status: planned | passed | failed | blocked | waived
Evidence: command + result excerpt, commit, or artifact path — not "should pass".
Coverage: which conditions the evidence covers (and which it does not). -->

| ID  | Risk        | Method                                                                                                                                           | Independence   | Evidence                                                                                                                            | Coverage                                                                                                    | Status  |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1          | Compare catalog, builders, appliers, snapshots; run governance gate.                                                                             | tool           | pnpm audit:data-governance passed: v247, 392/57 tables; isolated fixture confirms omitted parents                                   | Current checkout and fake IndexedDB; observed limits are F1 in report                                       | passed  |
| V2  | R2,R4       | Trace provider lifecycle; run focused backup/restore tests.                                                                                      | tool           | 26 existing suites: 324 passed, 1 failed; corrected copied OAuth mock passes 7 tests                                                | Local fixtures and source; original stale mock remains failing; no live provider writes                     | failed  |
| V3  | R3          | Inspect flags, mounts, replication policies, mobile/companion; run focused tests.                                                                | tool           | Feature-flag, table-policy, account-host, mobile-provider and sync integration suites passed; source confirms preview scope         | Build defaults and mocked transports; no deployed flag/device claim                                         | passed  |
| V4  | R4          | Inspect stream limits, filenames, key portability, restore failure semantics; reproduce practical gaps.                                          | tool           | Isolated gap fixture 5 passed; stream reader 4 passed including oversized remote rejection; cron filenames already unique           | Fake IndexedDB and WebCrypto; observed limits are F2,F5,F6; no live recovery                                | passed  |
| V5  | R5          | Exercise real plugin crypto before and after backup-key rotation in isolated storage.                                                            | tool           | rotation-coupling.test.ts: 3 passed; original CryptoKey control works; native Logto control unaffected                              | Synthetic stores and real crypto; desktop IPC mocked; no live key rotation                                  | passed  |
| V6  | R6          | Restore a valid DEK-bearing snapshot through WebDAV using real import logic.                                                                     | tool           | webdav-retrieval-restore.test.ts: 1 passed; exact missing retrieval-key passphrase error                                            | Actual envelope decrypt/migrate/apply; transport mocked; no live restore                                    | passed  |
| V7  | R4          | Exercise mobile upload metadata across repeat triggers and inspect per-operation sync limits.                                                    | tool           | mobile-upload-cycle.test.ts: 2 passed; pusher size test: 1 passed, 15 skipped                                                       | Real settings/history/orchestration, controlled clock and mocked transport/crypto; no real phone            | passed  |
| V8  | R7          | Interleave a session/message write between streaming export sections; decode and import the resulting valid stream.                              | tool           | concurrent-export.test.ts: 1 passed; late-message restores without its late-session parent                                          | Real producer/codec/reader/applier; isolated fake IndexedDB; no live database                               | passed  |
| V9  | R5,R6,R7    | Fix P1 defects before coverage; verify real ciphertext, nested DEKs and concurrent producer/import behavior.                                     | tool           | Initial P1 focused9 suites/81 tests passed before coverage; final86 suites/817 tests passed                                         | Native persistence is simulated from actual plugin-store semantics; browser/headless stores and real crypto | passed  |
| V10 | R1,R8       | Roundtrip authored graphs in both formats, paginate501 rows, remap collisions, preserve counters/versions/consent and rollback invalid children. | tool           | authored-content, apply-package, read-stream-package, profile-transfer and share regressions all passed in final aggregate          | Real codec/reader/importer and fake IndexedDB; no user database                                             | passed  |
| V11 | R5,R6,R7,R8 | Fresh-context adversarial review plus test-gap and wiring audit; reproduce and close all substantive counterexamples.                            | fresh-reviewer | Key, restore/stream, authored and runtime closure reviews report no remaining scoped blocker; all identified cases have regressions | Same-model independent reviewers; user skipped cross-model CLI                                              | passed  |
| V12 | R8,R9       | Run final unit, type, lint, governance and format checks.                                                                                        | tool           | 86 suites/817 tests; typecheck, lint and governance exit0; final format/ledger checks recorded below                                | Local checkout only; no coverage requested                                                                  | passed  |
| V13 | R9          | Check static-export compatibility.                                                                                                               | tool           | lint:static-export exit1: extension-engine.ts node:fs/promises and builtin-artifact-fixture.ts node:fs/node:path                    | Three paths outside this task; production export/build not accepted                                         | blocked |

## Decisions

<!-- ID prefix D. Based on: only the IDs this decision ASSUMES still hold (if one is
later Invalidated, the decision reopens). Name ruled-out hypotheses in the
Decision text, not here.
Action: implement | spike | diagnose | experiment | harden | escalate | scope-down | stop | ship
Reversal trigger: the new evidence that would reopen this decision. -->

| ID  | Date       | Decision                                                                                                                                                                  | Action    | Based on           | Reversal trigger                                                                                |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------ | ----------------------------------------------------------------------------------------------- |
| D1  | 2026-10-21 | Gather evidence before selecting implementation.                                                                                                                          | diagnose  | O1,G1,C1           | A concrete scenario changes the inspection.                                                     |
| D2  | 2026-10-21 | Report six gaps and prioritize disaster recovery and authored-data coverage; do not change application behavior during inspection.                                        | diagnose  | G1,C1,O2,O3,O4,O6  | New recovery adapters or data contracts invalidate a finding.                                   |
| D3  | 2026-10-21 | Classify the OAuth failure as stale test mocking rather than confirmed production breakage; preserve the original file.                                                   | diagnose  | O5                 | A real settings updater or real-provider check fails.                                           |
| D4  | 2026-10-21 | Reopen risk/evidence discovery: fresh reviewers found hidden key consumers, missing WebDAV key handoff, and weak mobile dirty-check evidence.                             | diagnose  | G1,C1              | Isolated counterexamples refute these candidate findings.                                       |
| D5  | 2026-10-21 | Prioritize reachable failures F2/F7/F8 before expanding domain coverage; retain other gaps with corrected mobile/size scope. D2 is superseded as the repair ordering.     | diagnose  | G1,C1,O7,O8,O9,O10 | Corrected sources or regression evidence refute the failures.                                   |
| D6  | 2026-10-21 | Cross-model review explicitly skipped at the user's choice; complete bounded in-repo reconciliation.                                                                      | diagnose  | G1,C1              | User requests a separately authorized external CLI review.                                      |
| D7  | 2026-10-21 | Implement the three P1 repairs before additive authored graph coverage, reuse existing builders/importer/store bridge, and verify by regressions and adversarial closure. | implement | O11,O12,O13,O14    | Any scoped regression, unsafe key migration or restored graph inconsistency reopens the repair. |

## Residual risks

<!-- ID prefix X. From: the R / V / H / M ids this residual comes from.
What is still not known or not verified after this round. No invented
percentages. Status: open | accepted | closed. "accepted" needs the user. -->

| ID  | Residual                                                                                       | From        | Why still open                                                                                                                 | Next action                                                                                  | Status |
| --- | ---------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------ |
| X1  | Arbitrary plugin-owned data still lacks a portable contract.                                   | R1          | 17 core authored table omissions are repaired; custom plugin schemas and encrypted local values have no safe portable contract | Define explicit plugin data exporters and restore/rebinding rules                            | open   |
| X2  | Auto-key backups depend on recovering the original device key store.                           | R4          | No key recovery/export workflow was implemented                                                                                | Add portable recovery and safe rotation, then clean-install acceptance                       | open   |
| X3  | Provider restore, large remote transport, and mobile data-change scheduling remain incomplete. | R2,R4       | Source gaps documented as F4-F6                                                                                                | Implement common recovery adapters and durable change tracking                               | open   |
| X4  | Preview account sync omits domains/blobs/compaction and production defaults off.               | R3          | Deliberate unfinished rollout phases, not repaired by audit                                                                    | Complete lifecycle and device tests before enabling wider production use                     | open   |
| X5  | Original OAuth mock now implements the functional-updater contract.                            | V2          | Repository mock updated to resolve function patches; all seven OAuth tests pass in the final aggregate                         | Keep the functional-updater mock aligned with production settings                            | closed |
| X6  | Real-provider, native clean-install, mobile and two-device recovery remain unverified.         | R1,R2,R3,R4 | This inspection used source, fake IndexedDB and mocked transport; no live recovery                                             | Run isolated test accounts/devices with portable recovery keys                               | open   |
| X7  | Original live-secret and WebDAV nested-key defects are repaired.                               | R5,R6       | Production key separation and passphrase handoff; focused and full regression checks passed                                    | Retain regressions and run isolated real-device acceptance                                   | closed |
| X8  | Mobile missed/redundant uploads and operation-size handling remain product limits.             | R3,R4       | Actual mobile frequency not measured; fixtures establish reachable boundaries                                                  | Durable change tracking and explicit size UX; real-device acceptance                         | open   |
| X9  | Original concurrent orphan-message path is repaired.                                           | R7          | Emitted session IDs gate messages/state/assets; original counterexample now has a passing production regression                | Retain regression; evaluate full database snapshot semantics separately                      | closed |
| X10 | Production static export remains blocked by unrelated Node-only imports.                       | R9          | Three actual violations in extension-engine and builtin-artifact-fixture                                                       | Repair those owning paths, then rerun static export/build                                    | open   |
| X11 | Restored knowledge sources require index rebuilding.                                           | R1,R8       | Derived vectors and active ingest execution are intentionally excluded; source content is preserved                            | Use existing knowledge-base rebuild controls after restoring local model/credential settings | open   |

## Outcome

<!-- ID prefix M. Signals that the ORIGINAL problem improved (validation, not verification).
Status: pending | met | not-met | not-measurable -->

| ID  | Signal                                                                                                 | How / when measured                                             | Result                                                                                                            | Status |
| --- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | Deliver evidence-backed gaps and priorities.                                                           | Report, 2026-10-21                                              | Eight prioritized findings after adversarial review; confirmed behavior separated from device/provider unknowns   | met    |
| M2  | Adversarially challenge the audit, reproduce counterexamples, and reconcile every substantive finding. | Three fresh reviewers and two bounded cycles, 2026-10-21        | Five actionable corrections incorporated; second cycle no substantive new issues; user skipped cross-model review | met    |
| M3  | Repair original three P1 defects without destroying existing live credentials.                         | Regression suites before coverage and final aggregate           | All three source fixes and fault-injection regressions pass; no real user key was rotated                         | met    |
| M4  | Restore the newly covered authored graphs through existing v3/v4 paths and running state.              | Clean-account, duplicate, pagination, rollback and bridge tests | 17 new bindings; 817 final tests passed; all implementation review findings closed                                | met    |

## Reproduction commands

Run from the repository root with `rtk proxy`:

```bash
pnpm audit:data-governance
pnpm test --runInBand lib/data/build-package.test.ts lib/data/build-stream.test.ts lib/data/apply-package.test.ts lib/data/backup-key.test.ts lib/data/backup-scheduler.test.ts lib/data/destinations lib/webdav/restore.test.ts lib/webdav/auto-upload.test.ts lib/account-sync/feature-flag.test.ts lib/account-sync/data/tables.test.ts lib/account-sync/data/sync.integration.test.ts lib/data-governance/table-catalog.test.ts
pnpm test --runInBand lib/scheduler/executors/backup-executor.test.ts hooks/data/use-import-flow.test.ts hooks/data/use-full-backup.test.ts lib/data/stream-format.test.ts components/account/sync/account-sync-host.test.tsx components/providers/webdav-mobile-autosync-provider.test.tsx
pnpm test --runInBand lib/data/read-stream-package.test.ts
pnpm test --runInBand --selectProjects jsdom --runTestsByPath .cache/audits/backup-sync-gap-audit/repro.test.ts .cache/audits/backup-sync-gap-audit/google-oauth-mock.test.ts --testPathIgnorePatterns node_modules
```

The second executed command additionally supplied a nonexistent `lib/data/restore-stream.test.ts` pattern; it selected no extra suite. The actual stream-import adapter suite was then run by its correct path in the third command. No application code, live user data, or remote account was modified. No coverage, typecheck or full application build ran. That paragraph records the audit phase only; the implementation and final verification below supersede its status. Residual product and real-environment risks remain explicit.

## Adversarial review record

Three fresh-context reviewers examined F1/F2, F3/F6, and F4/F5/evidence separately, with the artifact and inspection constraints only. They reported four valid actionable omissions: live-secret key rotation, WebDAV portable-DEK recovery, timestamp-dependent mobile upload behavior, and the 512 KiB sync-operation limit. A separate concurrent-write experiment added a fifth actionable issue (F8). Classifications A1-A5 and corrections are recorded in the report. No material contradiction was found in F1, F4, F5 or the original counts. The user explicitly chose to skip cross-model review; no external CLI review ran. Original six-gap conclusions are superseded where the report says so. Temporary fixtures remain under .cache/audits/backup-sync-gap-audit/.

Second bounded cycle: all three reviewers found no substantive new problems in the revised artifact. Provider reviewer reran the WebDAV/concurrency fixtures: 2 suites / 2 tests passed. Stop condition met after two cycles.

Final combined reproduction command ran all six isolated audit fixture files with `--selectProjects jsdom --runTestsByPath ... --testPathIgnorePatterns node_modules --silent`: **6 suites / 19 tests passed**, 4.46 s, exit 0. Passing records the reproduced behavior, not a production fix.

## Implementation authorization and acceptance (2026-10-21)

The user now authorizes production repairs: first F2/F7/F8 with co-located behavioral regressions, verify those, then address F1 backup coverage; reuse existing modules/components and perform final adversarial review. C1 described the earlier inspection only and does not constrain this new implementation phase.

1. Preserve preexisting plugin/browser secrets across repeated auto-key rotation and reboot; fail safely if preservation cannot be persisted. Verify real crypto and native/browser/headless storage seams.
2. Pass the proven WebDAV passphrase through the existing importer; test actual nested-key restore, wrong passphrase, and no-key legacy packages.
3. Pin exported parent membership while paging; test interleaved session/message writes through codec and importer and analogous portable parent/child sections.
4. Only after focused P1 checks pass, extend existing portable payload, builders, stream reader, importer and governance bindings for authored domains; verify empty-account restore and collision/remapping behavior.
5. Run focused suites, lint/type/static-export/governance checks, final adversarial review; document actual unrelated failures and remaining real-device limits. No coverage command unless requested; no live key rotation or production restore.

## Final implementation verification (2026-10-21)

The final complete regression command ran `pnpm test --runInBand lib/data lib/webdav lib/plugin/api/crypto-helpers.test.ts lib/plugin/api/secrets-api.test.ts lib/plugin/api/storage-api-secure.test.ts lib/logto/session-store.test.ts lib/settings/profile-transfer.test.ts lib/share/backup-share-gate.test.ts stores/agent/agent-team-store/dexie-bridge.test.ts hooks/data/use-import-flow.test.ts hooks/data/use-full-backup.test.ts lib/scheduler/executors/backup-executor.test.ts components/providers/webdav-mobile-autosync-provider.test.tsx --silent`: 86 suites / 817 tests passed, exit0. Root typecheck (including sidecars), lint (zero warnings) and governance gate passed. Logs: `.cache/backup-sync-verification/backup-regression-final.log`, `typecheck-final-cleanup.log`, `lint-final.log`, `governance.log`. No coverage command ran.

Review first reproduced five authored defects (seven RED cases), then pagination/binary-consent/parent timing and the Squad runtime refresh gap. Further targeted regressions reproduced concurrent in-memory edits and committed-refresh failure. The fixes reuse `deepStripSecrets`, existing codec/reader/atomic row merger, existing issue-counter helper and Squad definition bridge. Key durability review also reproduced dirty native cache, ephemeral first-root and established-root read-failure cases. All substantive findings are closed by source and regression evidence; final bounded read-only reviews report no remaining scoped blocker. Test-gap auditor confirms all earlier obligations closed. Cross-model CLI review remains skipped by the user's explicit choice.

The shared authored module owns graph selection/remapping across both formats; extending the old generic codec or merger alone could not supply these domain relationships. New integration tests are separate because their older counterparts mock away the exact crypto/import boundary under repair. No new component, schema version, native command or second backup pipeline was introduced. Source changes remain uncommitted and unrelated shared-tree work was preserved.

V13 remains blocked and maps to X10. X1/X2/X3/X4/X6/X8/X11 remain open product or real-environment limits; status remains verifying because those residuals are not user-accepted; this records completed scoped repair/audit deliverables without claiming full disaster-recovery or production rollout acceptance.

Final scoped recheck: importer, authored graphs and running Squad bridge passed **3 suites / 94 tests**, exit0 (18.861 s). Final typecheck including sidecars and scoped ESLint passed after the final typed deferred-transaction cleanup. `prettier --check` over task-owned files and `git diff --check` passed. The ledger final check reports **0 errors / 0 warnings**; verifying status retains the unaccepted residuals. Static-export was rechecked and still reports the same three other-path violations.
