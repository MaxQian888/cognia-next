# Backup and sync gap audit and repairs

Date: 2026-10-21 (Asia/Shanghai). Scope: current local checkout, production repairs and isolated Jest/IndexedDB/store fixtures. No production data, provider account, deployed service, or real device was restored or modified.

Evidence ledger: [backup-sync-gap-audit](../evidence/2026-10-21-backup-sync-gap-audit.md). Adversarial review: 2026-10-21; three fresh-context reviewers plus an independent concurrency probe. Cross-model review was offered and the user explicitly skipped it.

## Implementation result

The user authorized repairs after the audit: fix F2/F7/F8 first, verify, then extend F1 coverage and review adversarially again. The initial P1-focused check passed 9 suites / 81 tests before coverage work began. Further failure injection and review added regressions and hardened the implementation.

| Finding                        | Current result                                                                                                                                                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F2 live-secret rotation        | Fixed: plugin encryption and browser credential vaults use a stable install root. Legacy root adoption must be durable before rotation; native cache/disk failures fail safely. Browser, native-store and stateful headless regressions cover real ciphertext.             |
| F7 nested WebDAV DEKs          | Fixed by forwarding the successful outer passphrase into the existing importer. Real crypto/import tests cover success, wrong outer key, mismatched nested key, and no-DEK legacy files.                                                                                   |
| F8 streamed parent consistency | Fixed for session/skill/plugin children by pinning emitted IDs. New authored associations use shared membership checks; late conversations retain content with missing associations detached.                                                                              |
| F1 authored coverage           | Added 17 table bindings: projects, sessionFolders, workflowFolders, workflows, workflowVersions, knowledgeBases, knowledgeBaseSources, knowledgeNotes, labels, issueProjects, issueCycles, issues, issueEvents, issueCounters, agentTeams, agentTeammates, agentTeamTasks. |

The coverage implementation extends the existing payload, two writers, reader and atomic importer. One shared authored adapter owns table selection, secret handling, parent membership and reference remapping. No UI component, second backup engine, schema migration or native command was added. The new helper is needed because the previous codec and merge primitives did not own these authored domain graphs. New boundary integration tests exercise behavior the old unit mocks bypassed; the shared helper has its own co-located integration suite.

Version conflicts never overwrite an existing immutable workflow artifact. Imported machine provisioning consent is removed; running squads pause. Source originals survive with indexes pending for the existing rebuild controls. Issue counters retain deleted-number watermarks and never decrease. The existing Squad bridge now flushes pending edits, cancels stale queued projection, refreshes committed definitions, preserves edits made during restore, and disables projection if committed data cannot refresh its cache. The existing share-consent scanner covers added text and base64 originals.

### Final verification

- `pnpm test --runInBand lib/data lib/webdav ...` (exact complete command in `.cache/backup-sync-verification/backup-regression-final.log`): **86 suites / 817 tests passed**, exit 0, 57.923 s.
- Final importer/graph/store recheck: **3 suites / 94 tests passed**, exit 0, 18.861 s; scoped lint, format and whitespace checks also passed.
- `pnpm typecheck`: **passed**, exit 0, including the root and sidecar checks. Earlier interim failures were corrected; concurrent unrelated integration-test errors were absent in the final checkout.
- `pnpm lint`: **passed**, exit 0, zero warnings permitted.
- `pnpm audit:data-governance`: **passed** — schema v247, 392 tables, 57 sync tables. Portable bindings increased from 60 to **77**.
- `pnpm lint:static-export`: **blocked** by three Node-only imports outside this change: `lib/browser/extension-engine.ts:450` (`node:fs/promises`), `lib/plugin/core/builtin-artifact-fixture.ts:15` (`node:fs`), and `:16` (`node:path`). Production export/build acceptance remains open.
- No coverage command, production restore, real provider write, native clean-install/restart test, or mobile/two-device acceptance was run.

Fresh-context adversarial reviews and the test-gap/wiring auditors found and closed the key-migration, pagination, credential stripping, immutable-version, actor remapping, folder ancestry, binary consent, concurrent association, runtime hydration and cache-failure counterexamples. Each substantive repair has a behavioral regression; the final bounded closure checks reported no remaining blocker in the repaired scope. The user chose to skip cross-model review; no external model CLI ran.

### Remaining scope limits

Arbitrary plugin-owned tables and encrypted plugin-local storage still need explicit portable export/restore contracts. Auto-key recovery still requires the original key; old auto-key backups need their old key. Knowledge indexing must be rebuilt from restored originals. A v4 file preserves these membership constraints rather than a single database-wide point-in-time snapshot. F3–F6 remain product limits, including provider-specific recovery, remote size bounds, preview account-sync lifecycle and mobile upload change tracking. Real-device/provider acceptance and the repository static-export blockers remain open.

## Original audit evidence (before repairs)

The following assessment, findings and counterexamples document the original checkout. The implementation status above supersedes their statements about repaired behavior and the original portable-binding count.

## Assessment

Cognia has working backup codecs, encrypted local export/import, scheduled writes, WebDAV recovery, companion replication, and a preview account-sync engine. It does **not** yet provide complete disaster recovery or complete account-wide replication. The main gaps concern recovery keys, durable-data coverage, provider recovery, and automation semantics. Adversarial review additionally reproduced destructive key-rotation coupling, WebDAV recovery failure for DEK-bearing backups, and an internally inconsistent concurrent streaming export. Some are explicit scope limits; they remain product gaps even when tests correctly enforce that limited contract.

The governance gate reports schema v247, **392 static tables and 57 companion protocol tables**. The portable backup binding map contains **60 table bindings**, supplemented by attachment adapters and 12 persisted-state snapshot modules. These counts are inventory, not a completeness percentage: many other tables are caches, queues, audit logs, secrets, or deliberate local state.

## Capability map

| Mechanism               | Actual behavior                                                                                     | Important boundary                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Local backup            | v4 streaming export, encrypted or explicitly confirmed plaintext; v1/v3 compatibility imports       | Selected portable subset, not the entire account/database or filesystem                                |
| Local interval schedule | Encrypted file, retention, history; open-app tick every 30 minutes                                  | Desktop filesystem; uses this device's auto-key                                                        |
| Cron backup             | Local and/or WebDAV, GitHub, Google Drive; selectable content                                       | Host support required; local and remote legs use different keys                                        |
| WebDAV                  | Encrypted upload/list/download; DEK-bearing restore fails (F7); newer-snapshot notice               | Snapshot exchange with explicit recovery, not continuous bidirectional merge; desktop/mobile transport |
| GitHub / Google Drive   | Encrypted timestamped uploads, latest pointer, retention                                            | No matching provider-specific recovery UI or public download/restore adapter                           |
| Companion sync          | 57 protocol tables mirrored from an authoritative host; supported writes route back as host intents | A paired-host model, not a general independently writable account replica                              |
| Account sync            | Device approval/recovery, encrypted operations, merge and live updates for six tables               | Build flag defaults off in production; preview domain coverage; no blob/snapshot/compaction phase      |

## Findings and priorities

### F1 — P1: full backups omit durable authored domains and can restore dangling references

`PORTABLE_BACKUP_BINDINGS` omits `projects`, `sessionFolders`, `workflows`, `workflowVersions`, `issues`, `knowledgeBases`, `knowledgeBaseSources`, and `knowledgeNotes`. Their policies generally classify them as authoritative, permanent, device-local data; the two builders and the payload/import contract have no matching sections. This is an established subset contract, rather than a newly introduced schema drift.

The practical defect is stronger than an inventory omission: a session retains its `projectId` and `folderId`, but its project and folder do not travel. An isolated round trip seeded a workspace, folder and session, built both formats, cleared those three tables, and imported the v3 package. The session returned with its original references; both referenced rows remained absent.

Workflow definitions have a separate manual JSON export in the workflow editor, so they are not wholly unexportable. That export is not incorporated into the full/scheduled backup. Plugin installation/configuration records also do not imply that arbitrary dynamic plugin tables are backed up: the catalog defaults those tables to device-local pending an explicit exporter.

The Agent Teams snapshot comment says squads moved to Dexie and reach backup through the table pipeline. The current binding map/builders do not contain `agentTeams`, `agentTeammates`, or `agentTeamTasks`; the registered snapshot carries preferences. Do not treat that comment as a recovery guarantee.

Evidence: `lib/data-governance/table-catalog.ts:457`, `:1344`, `:2029`; `lib/data/types.ts:1`; `lib/data/build-package.ts`; `lib/data/build-stream.ts`; `lib/data/apply-package.ts:934`; `lib/data/snapshots/agent-teams.ts:1`; `components/workflow/editor/canvas.tsx:751`; isolated fixture below.

Recommendation: define the portable recovery contract per authored domain, include parents and children together, and verify restore into an empty account. Rebind machine paths and credentials separately. Expand the governance gate beyond internal consistency to detect authored-data exclusions and dangling references.

### F2 — P1: auto-key has no portable recovery flow, and rotation also breaks current secrets

The default manual backup and local schedules encrypt with a random device-stored key. Desktop stores it in `cognia-backup-key.json`; web uses localStorage; headless hosts use their secret store. The backup snapshot registry excludes that key. The data settings expose key rotation, but the inspected product paths expose no key export/recovery-kit/import workflow or old-key archive. The UI says another device can read the file if the key is also exported, without providing that action there.

Consequences: copying only the encrypted file to iCloud/Drive does not make it independently recoverable after loss of the original key store. Rotation replaces the key and can strand older files. The isolated fixture decrypted with the original key, cleared it, generated a replacement, and confirmed decryption failed. This is expected cryptography and a missing recovery workflow, not a cipher defect. Custom-passphrase backups, or independently recovering the original key store, avoid this specific failure. The account-sync recovery key is a different credential.

Adversarial review found a more immediate impact: the backup auto-key is also the root for plugin secure-storage encryption (`deriveInstallKey`). Replacing it without migration makes existing ciphertext unreadable through the normal new-key and legacy-fallback paths. Browser Logto sessions use this key to provision the fallback keyring: an already provisioned JS session can keep working, but the next boot injects the rotated key and existing vault reads return null. Desktop Logto's native keyring does not depend on this auto-key and was a passing negative control. A three-case isolated fixture reproduced these boundaries with real crypto and synthetic stores. This is current-data accessibility loss, not merely loss of old backup generations.

Evidence: `lib/plugin/api/crypto-helpers.ts:58`; `lib/plugin/api/storage-api.ts:243`; `lib/logto/session-store.ts:95`; `lib/keyring/index.ts:340`; `lib/data/backup-key.ts:70`, `:87`; `lib/data/snapshots/registry.ts:21`; `hooks/data/use-full-backup.ts:59`; `lib/data/backup-scheduler.ts:138`; `components/settings/data/tabs/backup-restore-tab.tsx:419`; `i18n/messages/en/settings/data.json` (`backup.encryption.autoKey`, rotation and cloud-folder guidance).

Recommendation: first inventory and separate or migrate every auto-key consumer so rotation preserves live credential/plugin data as well as old backups. Then provide a verified recovery-key/export or portable-passphrase flow and demonstrate restore on a clean device. Changing only backup decryption would leave the live-secret defect unresolved.

### F3 — P2: account sync is a limited preview, with missing data and lifecycle phases

`accountSyncEnabled({nodeEnv: "production"})` is false unless a build explicitly enables it. `AccountSyncHost` mounts at the root but returns before running hooks when disabled. This is a default-build conclusion, not a claim about the currently deployed environment.

When enabled, the engine replicates sessions, messages, non-built-in characters, non-built-in skills, non-project memories, and shared settings keys. Projects, folders, workflows, plugins and knowledge bases are absent; dependent fields such as session project/folder bindings remain local. Attachment/image bytes are not carried by this six-table operation log, so syncing a message does not ensure its media is available on another device.

A separate per-operation ceiling applies even inside those six tables: the client permits at most **512 KiB of serialized operation plaintext**. Oversized operations remain in the outbox and are reported as `tooLarge`; smaller rows can continue syncing. A 600 KiB text field already exceeds this cap, even without attachments or a full account log. The existing pusher behavioral test for this path passed (1 selected test; 15 skipped).

The server currently exposes operations, enrollment and registry routes without snapshot/blob routes. Snapshot compaction and stale-device restart are unfinished. New devices replay the log; above the configured `Math.floor(2 * 1024 ** 3 * 1.25)` stored-op threshold (2.5 GiB), push returns `413 quota_readonly` before interpreting operations, including deletes. ADR-0215 explicitly lists these as open phases.

Evidence: `lib/account-sync/feature-flag.ts:25`; `components/account/sync/account-sync-host.tsx`; `lib/account-sync/data/tables.ts:371`; `packages/sync-protocol/src/limits.ts:19`; `lib/account-sync/data/pusher.ts:173`, `:255`; `services/sync-server/src/routes.ts:33`; `services/sync-server/src/ops.ts:28`; `services/sync-server/src/space.ts:611`; ADR-0215 implementation phase 3a and remaining work.

Recommendation: retain accurate preview/scope labeling, complete blobs and log lifecycle before broad rollout, then extend authored-domain policies. A successful identity login or device enrollment does not establish full replication.

### F4 — P2: GitHub and Google Drive stop at upload inside the app

Both destinations implement verification/authentication, upload, latest-pointer maintenance and pruning. Their cards provide save/connect/verify/upload actions. Neither has the WebDAV equivalent of `listRemoteSnapshots` and `restoreFromWebDav`, nor a provider restore dialog. Internal lists used for retention or SHA lookup do not constitute a recovery path.

Users can retrieve a file using the provider's own UI and pass it to Cognia's file importer. Thus these integrations are not unrecoverable, but their backup-and-restore workflow is incomplete and less discoverable than WebDAV's.

Evidence: `lib/data/destinations/{github,google-drive}.ts`; `components/settings/data/{github,google-drive}-backup-card.tsx`; compare `lib/webdav/restore.ts:25`, `:65` and `components/settings/data/webdav-sync-card.tsx:47`.

Recommendation: add common list/download/preview/restore adapters and recovery provenance for all destinations, reusing the validated import pipeline.

### F5 — P2: remote backup still uses bounded whole-package serialization

Local export and local scheduled writers use v4 streaming. Manual WebDAV, GitHub/Drive sync and cron remote legs still call `buildBackupPackage`, stringify and encrypt a complete v3 payload. The builder rejects selected retained session/media sources above 32 MiB and estimated compact payloads above 64 MiB in character accounting. Those are separate limits, not one universal maximum database size.

Large local streaming backups can therefore succeed while remote backups fail. The interval scheduler correctly preserves local success and records remote failure. The existing stream-reader test explicitly checks rejection of an oversized source before its bytes are read.

The v4 reader also accumulates non-binary rows into a payload before applying them; streaming export does not establish bounded-memory or resumable restore for arbitrarily large databases. Large-device acceptance remains unmeasured.

Evidence: `lib/data/build-package.ts:515`, `:553`; `lib/webdav/sync-now.ts:28`; `lib/data/destinations/sync-now.ts:36`; `lib/scheduler/executors/backup-executor.ts:236`; `lib/data/backup-scheduler.ts:254`; `lib/data/read-stream-package.ts:87`; `lib/data/read-stream-package.test.ts`.

Recommendation: finish remote streaming/chunked adapters and an appropriately staged restore path; show per-destination limitations and partial success clearly until then.

### F6 — P2: WebDAV automation lacks an independent change signal and can miss or repeat uploads

Desktop interval uploads occur only after an enabled, due, successful local scheduled backup. Enabling WebDAV alone does not give it an independent upload schedule. Explicit cron remote jobs remain a separate working option.

Mobile uploads run opportunistically on boot/resume/network events with a five-minute floor. Their dirty check reads only settings `updatedAt` and the latest successful backup-history timestamp, rather than transcript/domain revisions. The original pure-helper fixture demonstrated a predicate boundary but did not establish that the production upload flow reaches that state. Adversarial review added an actual upload-cycle fixture using real settings, history and orchestration, with transport/package/crypto boundaries substituted. It reproduced both outcomes:

- When upload metadata lands in the same millisecond, a later session insert is missed: a trigger 150 minutes later still reports `fresh`.
- When the settings read crosses a millisecond, saving the upload timestamp itself makes `updatedAt` newer than `lastSyncAt`; a later trigger uploads again after the five-minute floor with no authored-data edits. This can repeat on subsequent events.

The source comment claiming deep data-only changes are always swept up by the next minimum interval is unsupported. Both omission and redundant uploads are timestamp-dependent; their prevalence on real phones remains unmeasured.

Evidence: `lib/data/backup-scheduler.ts:136`, `:254`; `lib/webdav/sync-now.ts:75`; `lib/db/settings.ts:623`; `lib/webdav/auto-upload.ts:42`; `components/providers/webdav-mobile-autosync-provider.tsx`; isolated fixture.

Recommendation: use a durable change sequence and an independent remote scheduling policy; test a data-only edit after a successful upload, with no settings change, followed by resume/network recovery.

### F7 — P1: WebDAV restore rejects valid snapshots carrying portable retrieval keys

WebDAV upload attaches passphrase-wrapped retrieval-profile DEKs. `restoreFromWebDav` decrypts the outer envelope successfully, then invokes `applyBackupPackage` without the `retrievalDekPassphrase` needed to unwrap those DEKs. If `payload.retrievalProfileDeks` is nonempty, the real importer throws exactly `A backup passphrase is required to restore retrieval keys` before its database transaction. The existing WebDAV restore suite mocks the entire applier and never tests this handoff.

An isolated fixture generated a real profile DEK, wrapped it, built a checksum-valid encrypted backup, verified outer decryption/migration and independent DEK import, then reproduced rejection through the actual WebDAV restore path. Only the remote transport factory was mocked. Snapshots with no portable DEKs do not hit this particular failure. Manually downloading and using the file importer is a workaround: that path forwards the passphrase correctly.

Evidence: `lib/webdav/sync-now.ts:42`; `lib/webdav/restore.ts:80`; `lib/data/apply-package.ts:217`; `lib/data/retrieval-key-backup.ts:53`; `hooks/data/use-import-flow.ts:178`; `.cache/audits/backup-sync-gap-audit/webdav-retrieval-restore.test.ts`.

Recommendation: repair and test the passphrase handoff across outer-envelope decryption and nested retrieval-key restoration before claiming the WebDAV recovery path is generally usable. Do not replace the importer with a mock in this regression test.

### F8 — P1: concurrent streaming export can produce a valid backup with orphan messages

The v4 builder reads sessions first and messages later. Its message filter checks whether a session is currently visible in the live database, not whether that session was actually emitted in the sessions section. A conversation created while export is in progress can therefore contribute a message after the session section has already passed. Hash-chain integrity authenticates the records it receives; it does not establish a single database snapshot or referential consistency.

An isolated fixture consumed the existing-session section, inserted a new session and message, continued the same producer, encoded and decoded a complete checksum-valid v4 stream, then imported it after clearing the fixture's sessions/messages. The new message was restored, but its parent session was absent. This is separate from F1: sessions are a supported portable table, yet the exported generation can still miss its parent. The producer can yield between these operations during ordinary asynchronous encryption/file output; no malformed input was needed.

Evidence: `lib/data/build-stream.ts:215`–`:236`; `lib/data/paged-table-reader.ts`; `lib/data/stream-format.ts`; `lib/data/apply-package.ts:934`; `.cache/audits/backup-sync-gap-audit/concurrent-export.test.ts`.

Recommendation: define a consistent export generation or equivalent snapshot/staging contract and test mutations between parent/child sections. At minimum, do not admit child records whose parents were never emitted. Validate supported-domain referential integrity before reporting successful recovery.

## Checks that prevent overstatement

- Root providers are actually mounted; this is not a blanket dormant-code finding.
- WebDAV has a real encrypted download/apply path, but its existing mocked-applier tests miss the DEK-bearing failure in F7. The earlier blanket recovery wording was too broad.
- Local v4 streaming export **and** its importer adapter exist and pass tests; ADR-0001's statement that writers still wait for adapters is stale.
- Cron backup filenames already include task/execution ids. The date-only helper collides within a day, but this is not a demonstrated general cron overwrite bug. Interval identity changes/retries sharing one directory warrant a separate targeted scenario before assigning severity.
- API keys, device credentials, active execution authority, derived indexes and caches should not automatically be included merely to increase table coverage.
- Google OAuth's failing repository test uses a `saveSettings` mock that merges only objects. Production supports functional updaters; `updateBackupDestinationsSettings` uses one. A copied test with the mock evaluating functions passed all seven cases. This failure is a test-contract issue, not confirmed real-provider OAuth breakage. The repository test remains unchanged.

## Verification record

All commands ran from the repository root with `rtk proxy` on this macOS checkout. No coverage command ran.

| Check                                                                                                                                                        | Result                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `pnpm audit:data-governance`                                                                                                                                 | Passed: schema v247, 392 tables, 57 companion sync tables                                            |
| First focused Jest batch: builders, applier, keys, interval scheduler, destinations, WebDAV restore/auto-upload, account policies/integration, table catalog | 19 suites; 261 passed, 1 failed (stale OAuth settings mock)                                          |
| Second batch: cron executor, full import/export hooks, stream codec, account host flag wiring, mobile autosync provider                                      | 6 suites; 59 tests passed                                                                            |
| `pnpm test --runInBand lib/data/read-stream-package.test.ts`                                                                                                 | 1 suite; 4 tests passed, including encrypted stream round trip and oversized remote source rejection |
| Original isolated gap fixture                                                                                                                                | 5 checks passed, reproducing the limited behavior; passing means the gap was observed, not repaired  |
| Isolated OAuth fixture with corrected mock                                                                                                                   | 7 tests passed                                                                                       |

Existing-suite aggregate: **26 suites, 324 tests passed, 1 failed**; a fresh reviewer independently reran their union with the same sole failure. Additional original isolated audit fixtures: **12 checks passed**. Adversarial fixtures add **7 checks passed** across four suites (rotation 3, mobile upload cycle 2, WebDAV DEK restore 1, concurrent export 1), for **19 isolated checks passed** in total. Passing these fixtures means reproducing defects, not fixing them. A separate existing pusher size-limit check passed **1 selected test, 15 skipped**. The first gap fixture was rerun after adding the actual project/folder import assertions; these are not double-counted.

Reproduction fixtures are temporary verification artifacts under `.cache/audits/backup-sync-gap-audit/`. Run:

```bash
rtk proxy pnpm test --runInBand --selectProjects jsdom \
  --runTestsByPath .cache/audits/backup-sync-gap-audit/repro.test.ts \
  .cache/audits/backup-sync-gap-audit/google-oauth-mock.test.ts \
  .cache/audits/backup-sync-gap-audit/rotation-coupling.test.ts \
  .cache/audits/backup-sync-gap-audit/mobile-upload-cycle.test.ts \
  .cache/audits/backup-sync-gap-audit/webdav-retrieval-restore.test.ts \
  .cache/audits/backup-sync-gap-audit/concurrent-export.test.ts \
  --testPathIgnorePatterns node_modules
```

The first batch command is recorded in the evidence ledger. Typecheck, application lint/build and browser/native interaction were not run: the deliverable is a source/test audit with documentation only, not a changed application. No live provider, two-device, clean-install native recovery or production-flag verification was performed. These are explicit limits on runtime claims, not inferred passes.

## Suggested implementation order

1. Repair currently reachable failures first: rotation of shared key consumers (F2), WebDAV retrieval-key handoff (F7), and concurrent backup consistency (F8), each with a real boundary regression.
2. Establish portable disaster recovery and clean-install acceptance; close authored-domain parents/children in the same recovery contract (F1/F2).
3. Complete provider recovery and large-data remote support; use a durable change signal for unattended uploads (F4/F5/F6).
4. Complete account-sync blobs, compaction/snapshots and stale-device lifecycle; make operation-size limits visible before extending domains and general release (F3).

This audit identifies work; it does not implement those changes or accept their residual risks on the user's behalf.

## Adversarial reconciliation

| Review item                                                     | Classification                  | Resolution                                                                                                      |
| --------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| A1: F2 omitted current plugin/browser-secret impact of rotation | Valid + actionable              | Expanded F2 and moved shared-key consumers into the first repair increment; three real-crypto fixture cases     |
| A2: blanket WebDAV recovery wording omitted nested-key failure  | Valid + actionable              | Qualified capability/overstatement text; added F7 with real decryption/import failure                           |
| A3: F6 pure predicate did not prove reachable post-upload state | Valid + actionable              | Replaced the practical inference with two actual upload-cycle checks; documented opposite redundant-upload path |
| A4: six-table account sync omitted per-operation size ceiling   | Valid + actionable              | Added 512 KiB plaintext operation cap, pending/tooLarge behavior and existing selected regression result        |
| A5: supported-table export could be inconsistent during writes  | Valid + actionable              | Added F8 after full encode/decode/import reproduction; separate from intentional domain exclusions              |
| F1 scope, F4 fallback, F5 limits and original test counts       | No material contradiction found | Retained with existing qualifications; no declaration that the product is repaired                              |

Cross-model escalation was explicitly offered and skipped by the user. All reviewers used fresh context and bounded artifacts/contracts; no external review CLI ran. A second bounded cycle reviewed the materially revised text and the new concurrency counterexample; all three reviewers reported no substantive new issues. The provider reviewer independently reran the two new WebDAV/concurrency fixtures: 2 suites / 2 tests passed. Stop condition: the next cycle found no substantive new issue; two cycles completed, no third cycle needed.

Final combined reproduction command ran all six isolated audit fixture files with `--selectProjects jsdom --runTestsByPath ... --testPathIgnorePatterns node_modules --silent`: **6 suites / 19 tests passed**, 4.46 s, exit 0. Passing records the reproduced behavior, not a production fix.
