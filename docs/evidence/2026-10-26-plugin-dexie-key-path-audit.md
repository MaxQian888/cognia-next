# Evidence ledger: Plugin Dexie key-path patch audit

- Status: verifying
- Lane: standard
- Created: 2026-10-26
- Updated: 2026-10-26
- Related: commit `e0f823a21a`; ADR-0239; ADR-0224

## Original request

> Audit plugin APIs for Dexie key-path patches. Trace plugin-supplied objects from `lib/plugin/api/*.ts`, `lib/plugin/bridge/*.ts`, and `lib/plugin/python/host-request-router.ts` to Dexie `update` / `modify`; fix real patch-forwarding holes, add co-located regressions, and report safe paths. Run focused Jest and file-scoped lint only; no typecheck or full suites.

## Knowledge

| ID  | Statement                                                                                                         | State    | Basis                                                                                                                                     | Depends on |
| --- | ----------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| O1  | Dotted changes keys are interpreted as paths by Dexie update/modify.                                              | Verified | Installed `node_modules/dexie/dist/dexie.mjs`, `Table.prototype.update`, `setByKeyPath`; disposable IndexedDB reproduction on 2026-10-26. | -          |
| O2  | The named commit already refuses dotted connector API patches and filters recipient roots in the adapter helper.  | Verified | `git show e0f823a21a -- lib/plugin/api/connectors-api.ts lib/db/adapter-instances.ts`; current source agrees.                             | -          |
| O3  | The other audited host mutation methods rebuild changes, wrap data in fixed fields, serialize values, or use put. | Verified | Call-chain inventory below; targeted regression results below.                                                                            | O1         |
| O4  | Raw Dexie handles expose core tables outside the named host mutation methods.                                     | Verified | `lib/plugin/api/dexie-api.ts`, `lib/plugin/core/context.ts`; disposable database reproduction below.                                      | O1         |
| G1  | Determine whether other host patch methods can bypass guarded fields using dotted keys and fix confirmed cases.   | Agreed   | User request, 2026-10-26.                                                                                                                 | -          |
| C1  | Preserve concurrent work; do not run typecheck, coverage, full suites, or repository-wide lint.                   | Observed | User task constraints, 2026-10-26.                                                                                                        | -          |

## Problem frame

The changes-object vulnerability is real (O1), and the connector boundary already has the requested mitigation (O2). Audit other host mutation methods for the same forwarding pattern (G1). Do not treat a literal dotted property in a `put` value or a nested value as a Dexie changes key. O4 is a separate database-capability escape: it reaches core tables directly, without a host patch API. It remains an open security finding requiring a restricted Dexie facade, with all raw-handle and callback escape routes considered together.

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                                                                                                                          |
| ------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| scale        | medium | 93 top-level API and 50 top-level bridge production TypeScript files inventoried; traced mutation sinks into DB/store/runtime owners, plus Python routing and bridge shared helpers. |
| technical    | low    | Existing Dexie implementation and focused tests establish key-path semantics.                                                                                                        |
| coupling     | medium | Some APIs persist through stores, serializers, runtime services, or remote scheduler routing.                                                                                        |
| requirement  | low    | Requested patch-forwarding pattern and protected fields are explicit.                                                                                                                |
| verification | medium | Tests exercise real IndexedDB helpers and API routing; store projection is checked at its writer seam.                                                                               |
| risk         | high   | Recipient grants, automated-turn provenance, credentials, task ownership, and permission fields.                                                                                     |

## Risks

| ID  | Risk (impact)                                                              | Severity | Source                                                        | Claim                                                                                                   | Refuted by                                                                                             |
| --- | -------------------------------------------------------------------------- | -------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| R1  | A plugin bypasses a protected-field check through a dotted changes key.    | high     | e0f823a21a; ADR-0239 outbound grants; ADR-0224 item ownership | Named host mutation methods do not forward an unchecked dotted changes key into a protected host field. | A focused API/helper test changes the protected nested field.                                          |
| R2  | A raw database capability bypasses host methods altogether.                | high     | Independent reviewer; `dexie-api.ts` rawDb proxy and Table.db | Namespace checks on table()/transaction() alone do not prove core-table isolation.                      | A complete restricted-facade test matrix refuses all core-handle escape routes.                        |
| R3  | Audit work changes unrelated shared-tree files or overstates verification. | medium   | concurrent-tree-safety; user constraints                      | This task edits only its tests and report and runs scoped checks.                                       | Unrelated task-authored edits, a skipped result represented as passing, or a prohibited broad command. |

## Verification obligations

| ID  | Risk | Method                                                     | Independence | Evidence                                                                                                                                                                                                                         | Coverage                                                                                                                                 | Status |
| --- | ---- | ---------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| V1  | R1   | Focused Jest on six changed test files                     | tool         | Final exact requested Jest entry point: 8 suites / 271 tests passed; exit 0. Full output: `.cache/plugin-key-path-audit/jest-final.log`.                                                                                         | Fixed connector boundary, Python routing, account put, monitor nesting, message projection, scheduler serialization, session projection. | passed |
| V2  | R1   | Trace all identified mutation call chains                  | self         | Inventory below; direct-sink search under APIs/bridges and transitive DB/store/runtime source inspection.                                                                                                                        | Changes-object vulnerability only; no claim of general plugin isolation.                                                                 | passed |
| V3  | R2   | Disposable Dexie reproduction using actual createDexieAPI  | tool         | `.cache/plugin-key-path-audit/raw-dexie-repro.log`: reproduced=true, rawTableDatabase=true, tableEnumeration=true, mutatedRecipient=injected.                                                                                    | No real account DB or credentials touched; temporary DB deleted in finally.                                                              | passed |
| V4  | R3   | Scoped ESLint, formatting, and direct diff/test-gap review | tool         | ESLint exit 0 with --max-warnings=0; Prettier passes; git diff --check passes; direct review confirms only existing test files and report. Automated preflight subagent was blocked by tool policy and is not counted as passed. | Six test files and this report; no production changes.                                                                                   | passed |

## Decisions

| ID  | Date       | Decision                                                                                                     | Action    | Based on       | Reversal trigger                                                                 |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------ | --------- | -------------- | -------------------------------------------------------------------------------- |
| D1  | 2026-10-26 | Pin the existing protections with regressions; no additional ordinary patch-forwarding hole was found.       | implement | O1, O2, O3, G1 | A reachable raw changes object is found in another named host mutation method.   |
| D2  | 2026-10-26 | Report the raw Dexie capability escape separately; do not present named-method safety as database isolation. | escalate  | O4             | A separately scoped facade change closes and tests every raw-handle entry point. |
| D3  | 2026-10-26 | No changeset: this change adds tests and documentation without changing runtime behavior.                    | implement | O3, C1         | Production behavior is changed.                                                  |

## Audited write paths

Safety statements below are restricted to the dotted changes-object pattern.
They do not assert that every unrelated input validation or authorization property is correct.

| Plugin surface                                                                | Traced sink / owner                                                                                                                                        | Result                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connectors.updateInstance`                                                   | `updateAdapterInstance` → `adapterInstances.update`                                                                                                        | Already fixed: API rejects every dotted key before any write; DB helper removes exact recipient-list keys and descendants. No additional source patch. New tests include a valid field alongside each malicious key, proving whole-call refusal.                                                                                                                                      |
| Connector creation / enable / dispatch rules                                  | `createAdapterInstance` uses add/put; other methods pass `{ enabled }` / `{ dispatchRules }`                                                               | Dotted input names on creation are literal row properties; nested rule contents are values, not changes keys.                                                                                                                                                                                                                                                                         |
| Connector chat management                                                     | Running adapter methods via `resolveChatAdapter`                                                                                                           | Platform operations, not host Dexie changes objects.                                                                                                                                                                                                                                                                                                                                  |
| `session.updateSession`                                                       | Session store projects title, effort/thinkingLevel, squadId and routed project moves → `db/sessions.updateSession`                                         | Safe through this API. The DB helper itself has an exact workingSet guard, but caller keys are not spread into its patch. New regression proves workingSet/executionContext/metadata paths never reach it.                                                                                                                                                                            |
| `session.updateMessage`                                                       | `messageRepository.update` in `db/plugin-bridge.ts` → `messages.update`                                                                                    | Safe: reconstructs role/parts/sender fields and merges selected metadata fields. Dotted keys and arbitrary metadata are not forwarded. New real-DB regression preserves the automatedTurn marker and chooses explicit content over a parts key path.                                                                                                                                  |
| `session.addMessage` / seeded sessions                                        | API constructs the message and automation marker; repository uses put                                                                                      | No plugin changes object reaches update/modify.                                                                                                                                                                                                                                                                                                                                       |
| `integrations.updateAccount`                                                  | `updateIntegrationAccount` → `{ ...existing, ...withoutRecipientList(patch) }` → `integrationAccounts.put`                                                 | Safe from key-path interpretation. Exact recipient replacement is stripped. A dotted property is stored literally and does not change the nested recipient grant or create nested settings. New real-API tests cover both TypeScript calls and Python router calls.                                                                                                                   |
| Integration account/subscription creation, health, ingress, action/event APIs | Integration DB helpers; provider health projects fixed status fields; jobs/events/subscriptions use complete rows                                          | No uncontrolled changes object reaches update/modify. Generic DB subscription/job patch helpers are not exposed as plugin patch methods.                                                                                                                                                                                                                                              |
| `bots.recordMonitor`                                                          | `botInstallations.update(id, { monitor: { ...current.monitor, ...patch }, updatedAt })`                                                                    | Safe: only monitor is a changes key. New real-DB regression preserves owner, recipient list, and credential bindings while storing dotted names inside monitor literally.                                                                                                                                                                                                             |
| `bots.writeTriggerState`, progress, checkpoints, results                      | Exact input-key whitelist for trigger state, then fixed state writer; other payloads are nested journal/step values                                        | Safe: unknown keys, including dotted names, fail the whitelist or stay inside a value.                                                                                                                                                                                                                                                                                                |
| External-agent Bot binding                                                    | `external-agent-api.ts` calls `updateBotInstallation` with host-built bindings                                                                             | No raw plugin patch spread into Dexie changes.                                                                                                                                                                                                                                                                                                                                        |
| `storage` / `configuration.update`                                            | Storage writes `{ storage: values }`; applyPluginConfig → setPluginConfig → `{ config }`                                                                   | Safe: dotted plugin-owned config/storage names are nested values, so they cannot update plugin permissions, owner, or credentials.                                                                                                                                                                                                                                                    |
| User scheduler `updateTask`                                                   | `scheduler-tasks.ts` → store/data source → TaskScheduler.updateTask → schedulerDb.updateTask                                                               | Safe: runtime enumerates allowed top-level fields, and serializer enumerates stored columns and JSON-serializes config/payload/owner/creator. New serializer regression preserves creator and owner and keeps config dotted names literal. Remote data source wraps input in an RPC payload; scheduled-task-rpc routes it back through the same TaskScheduler projection on the host. |
| Plugin scheduler / scheduled-task bridge                                      | Core context maps validated inputs; bridge builds trigger/config patches explicitly                                                                        | No caller-controlled changes keys; nested values are serialized by the same scheduler writer.                                                                                                                                                                                                                                                                                         |
| `goals.updateConfig`, objective changes                                       | Goal runtime wraps config in `{ config }`; objective path rebuilds host fields → `chatGoals.update`                                                        | Safe: plugin config keys cannot become root goal changes keys.                                                                                                                                                                                                                                                                                                                        |
| `plans.updateDraft`, step/status/refinement mutations                         | Plan runtime enumerates title/description/steps/config/etc. → `agentPlans.update`                                                                          | Safe: input patch is not spread into DB changes. Nested config/metadata remain values.                                                                                                                                                                                                                                                                                                |
| `memory.update`                                                               | updateExternalMemory → runMemoryMutation                                                                                                                   | Safe: effective DB patch explicitly enumerates text/importance/tags/key/pinned after caller and policy checks; raw spread is only in the request hash, not the DB patch.                                                                                                                                                                                                              |
| `issues.update`                                                               | Builds typed IssueBulkAction entries from explicitly read fields → bulk action service                                                                     | Safe: dotted patch keys do not become actions or DB changes keys.                                                                                                                                                                                                                                                                                                                     |
| `team.updateTask` / teammate / team config                                    | API field projection and store normalization → agent-team definition bridge → bulkPut                                                                      | Safe: task/teammate patches are projected; config is a nested value in a complete definition row. Host `db/teams.updateTeam` is not the Squad definition persistence path.                                                                                                                                                                                                            |
| `project.updateProject`                                                       | Store merge → putProject → `projects.put`                                                                                                                  | Safe from key-path interpretation; arbitrary names are row properties, not changes keys.                                                                                                                                                                                                                                                                                              |
| Canvas / artifact / theme updates                                             | Explicit field projection; document/artifact bridges use bulkPut; theme stored within settings                                                             | Safe: patch data cannot become arbitrary host table changes keys.                                                                                                                                                                                                                                                                                                                     |
| Workflow authoring                                                            | Editor commands patch node/edge data in memory; persisted graph is a complete workflow value                                                               | Safe: node/edge parameter keys remain graph data, not row changes keys.                                                                                                                                                                                                                                                                                                               |
| Template library and agent-config edits                                       | Ownership/consent service; template DB uses put/bulkPut; agent-config passes edited text through the resource owner                                        | No unprojected plugin changes object at a Dexie update/modify sink.                                                                                                                                                                                                                                                                                                                   |
| Connector / tool-route / provider / integration / external-service bridges    | Connector seed row built explicitly; tool routes upsert full rows; provider status updates use fixed keys; remaining bridges register runtime capabilities | No additional patch-forwarding sink found. `.modify` callbacks reached by internal bulk operations are host-authored; no plugin object is supplied as their modifications map.                                                                                                                                                                                                        |
| `glance.update`                                                               | `glancePluginModules.update`                                                                                                                               | Registry update, not Dexie Table.update.                                                                                                                                                                                                                                                                                                                                              |
| Sites / subscriptions / resources / logs / export                             | Read/query surfaces (export may register a serializer)                                                                                                     | No host patch write.                                                                                                                                                                                                                                                                                                                                                                  |
| Remaining API/bridge files                                                    | Permissions, events, UI/renderer registration, native filesystem/network/auth/automation/service calls                                                     | No host Dexie changes-object sink identified. Namespaced plugin-owned Dexie writes are addressed separately below.                                                                                                                                                                                                                                                                    |

## Python router

`host-request-router.ts` does not interpret patch keys. It resolves a catalogued
method against the guarded PluginContext and forwards arguments unchanged.
Supported account calls therefore retain the account helper's put semantics.
`connectors.updateInstance` is currently unavailable to Python and is refused by
the runtime catalog before the implementation runs. New tests assert that refusal
for recipient, owner, credential, settings, and escalation dotted keys. The router
must not reject dots recursively in arbitrary values: config maps, payloads and
user-owned table rows may legitimately contain literal dotted names.

## Separate open finding: raw Dexie capability escape

`core/context.ts` mounts `createDexieAPI(getDb(), pluginId)` when the plugin has a
Dexie manifest. `dexie-api.ts` validates names on table()/transaction(), but
rawDb() forwards other members and table() returns an actual Dexie Table. A
plugin can reach core tables through rawDb().adapterInstances, rawDb().tables,
or table("ownTable").db. This bypasses the connector API and its DB helper:

```ts
await ctx.dexie.rawDb().adapterInstances.update("victim", {
  "outboundRecipients.0": injectedGrant,
})
```

Run `node .cache/plugin-key-path-audit/raw-dexie-repro.cjs` from the repository root to repeat the local check. The disposable reproduction compiled the checked-out createDexieAPI and namespace
helper with the installed TypeScript, used installed Dexie/fake-indexeddb, created
only adapterInstances and auditor:rows in a fresh process-specific database,
updated a fixture recipient, and deleted that database. The output was:

```json
{
  "reproduced": true,
  "rawDbCoreTableName": "adapterInstances",
  "rawTableDatabase": true,
  "tableEnumeration": true,
  "mutatedRecipient": "injected"
}
```

The core table name and successful recipient mutation establish access. This is broader than dotted-key filtering:
plain-field writes, put, modify, delete, table enumeration, Table.db, transaction
callbacks, and other raw capabilities must be covered by a restricted facade.
Adding only another dotted-key guard would leave this escape usable. No production
change to this separate capability design was made in this patch audit.

## Validation results

- Initial six-file Jest run: 4 passed, 2 failed, 198 passed tests / 6 failed tests.
  Five failures were test expectations that Python reached connector updateInstance;
  the catalog correctly refuses that method first. One was the scheduler's existing
  default overlapPolicy normalization. Production code was unchanged.
- Corrected rerun of connectors, scheduler DB and bots: 3 suites / 146 tests passed.
- Final aggregate Jest: **8 suites passed, 271 tests passed, 0 failed**, exit 0
  (8.918 seconds), using:

  ```sh
  pnpm_config_verify_deps_before_run=false node scripts/test/jest.mjs --runInBand \
    lib/db/plugin-bridge.test.ts \
    lib/plugin/api/integrations-api.test.ts \
    lib/plugin/api/bots-api.test.ts \
    lib/scheduler/scheduler-db.test.ts \
    stores/chat/session-store.test.ts \
    lib/plugin/api/connectors-api.test.ts \
    lib/db/adapter-instances.test.ts \
    lib/plugin/python/host-request-router.test.ts
  ```

- File-scoped ESLint on the six edited test files: exit 0, `--max-warnings=0`.
- File-scoped Prettier: passed for the six tests and this report. `git diff --check`: passed.
- Added **11 regression cases** across six existing co-located test files.
- Direct final diff review found no production-source edit or unrelated hunk in
  this task's six test paths. An independent source pass found the raw capability
  escape, but its agent subsequently hit capacity. The automated preflight
  test-gap subagent was blocked by the tool's cybersecurity filter; it did not
  complete and is not represented as passing. Test pairing and assertions were
  reviewed directly instead.
- No typecheck, coverage, build, UI/device checks, or full suite was run. This is a
  headless persistence audit with no UI or runtime source change.
- Six existing co-located test files were extended. No new production module, schema
  migration, dependency, translation, changeset, commit, or shared-tree reset/stash.

## Residual risks

| ID  | Residual                                                                             | From | Why still open                                                                                                               | Next action                                                                                                                                       | Status |
| --- | ------------------------------------------------------------------------------------ | ---- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| X1  | Raw Dexie capability escape exposes core tables, independently of host patch guards. | R2   | A complete capability facade needs a separate security design and compatibility test matrix. No risk acceptance is inferred. | Restrict the raw database/table/collection/transaction surface, cover every handle escape, and re-run the disposable exploit as a rejection test. | open   |
| X2  | Final scoped gates and direct review completed.                                      | V4   | All scoped deterministic checks passed; automated reviewer limitation recorded above.                                        | No further scoped gate action.                                                                                                                    | closed |

## Outcome

| ID  | Signal                                                                                                   | How / when measured                            | Result                                                                                                                                     | Status  |
| --- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| M1  | Identify all additional changes-object holes in the audited host patch methods and pin protected fields. | 2026-10-26 source tracing plus focused Jest.   | No additional named host patch-method hole found; existing connector mitigation and safe projections/put semantics covered by regressions. | met     |
| M2  | Establish whether the entire plugin Dexie surface isolates core tables.                                  | 2026-10-26 disposable raw-handle reproduction. | It does not; the separate capability escape remains open.                                                                                  | not-met |
