# Evidence ledger: CC Switch current-release support

- Status: verifying
- Lane: standard
- Created: 2026-10-22
- Updated: 2026-10-22
- Related: https://github.com/farion1231/cc-switch/releases/tag/v4.0.18

## Original request

> 检查一下现在的ccswitch的支持情况，看看是否符合最新的版本的支持情况，进行对照和测试，确保覆盖完整，不需要兼容旧的，及时清理死代码

## Knowledge

| ID  | Statement                                                                                                     | State    | Basis                                                                | Depends on |
| --- | ------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------- | ---------- |
| O1  | Latest stable CC Switch is v4.0.18, schema 21, eleven app types.                                              | Verified | GitHub release API and tagged schema.rs/app_config.rs, 2026-10-22    | -          |
| O2  | Installed CC Switch is v4.0.17/schema20; local DB contains 21 providers, 9 MCP servers, 1 prompt, 123 skills. | Observed | Read-only plist/SQLite inspection on macOS, 2026-10-22               | -          |
| O3  | Old reader drops server_config and installed skill bodies; Codex can choose an unrelated endpoint.            | Verified | Release-schema regressions: 5 failed, 2 passed before implementation | O1         |
| G1  | Audit and repair current-release read/import/switch integration; remove obsolete schema guessing.             | Agreed   | User request, 2026-10-22                                             | -          |
| C1  | CC Switch DB stays read-only; no credential or agent configuration changes during acceptance.                 | Verified | Existing module contract and read-only acceptance procedure          | -          |

## Problem frame

Repair the existing Settings CCSwitch surface against the tagged current schema (O1, G1). Browse all eleven app types, import MCP/prompts/installed skill bundles, distinguish Anthropic SDK compatibility from other app protocols and managed logins, preserve composite identities and paths. CC Switch's proxy, terminal launcher, OAuth account manager and usage execution remain owned by CC Switch; do not label them supported by Cognia.

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                      |
| ------------ | ------ | ---------------------------------------------------------------- |
| scale        | medium | Rust reader/path resolution plus TS IPC/import/hooks/UI          |
| technical    | medium | Eleven current per-app configuration shapes                      |
| coupling     | medium | Shared settings and credential projection                        |
| requirement  | low    | Existing interop ownership remains explicit                      |
| verification | high   | Current-release native bootstrap and isolated acceptance profile |
| risk         | high   | Credentials must never cross incompatible protocols              |

## Risks

| ID  | Risk (impact)                                             | Severity | Source              | Claim                                                            | Refuted by                                              |
| --- | --------------------------------------------------------- | -------- | ------------------- | ---------------------------------------------------------------- | ------------------------------------------------------- |
| R1  | Silent missing configuration or obsolete schema           | high     | O3                  | Exact current columns; explicit errors on schema mismatch        | Empty successful MCP config for populated server_config |
| R2  | Credential misrouting and false success                   | high     | Source review       | Non-Anthropic and managed cards cannot switch the bundled SDK    | An agy key reaches setProviderEnv                       |
| R3  | Skill reads escape source roots or imports lose resources | high     | Filesystem boundary | Constrained installed roots; existing parser/resource persister  | Traversal leaks a body or script disappears             |
| R4  | Tabs disagree on path or tear down another watcher        | medium   | Source review       | Saved manual directory reaches all reads; shared watch lifecycle | Content tab uses default DB despite saved override      |

## Verification obligations

| ID  | Risk           | Method                                                           | Independence | Evidence                                                                                                                                                                                                                                                                                                                                                      | Coverage                                                                                                                | Status  |
| --- | -------------- | ---------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1, R3         | Rust fixture and local snapshot tests                            | tool         | cargo test -p cognia-ccswitch --lib: 48 passed, one opt-in test ignored; opt-in local snapshot: 1 passed, 21 providers/9 MCP/1 prompt/123 skills, 116 readable skills. Original source file hash unchanged.                                                                                                                                                   | Exact schema21; all eleven app formats; missing/future schema; read-only writes; skills/resources/path rejection        | passed  |
| V2  | R2, R4         | Focused Jest regressions                                         | tool         | Before fix: 5 new regressions failed. After modularization and final UI regressions: 18 suites/274 tests passed.                                                                                                                                                                                                                                              | Composite IDs; protocol/managed auth guards; subscription failure; shared watchers and manual paths; imports            | passed  |
| V3  | R1, R2, R3, R4 | Preflight auditors, lint/type/static checks                      | subagent     | Scoped ESLint, no-deps Clippy, Tauri-host feature check, i18n generation/check/lint pass. Test-gap and wiring reviewers confirm extracted modules are reachable with colocated tests. Full typecheck has 26 unrelated diagnostics; full lint fails on an existing public fixture bundle; static-export script fails ENOBUFS while listing tracked paths.      | Scoped diff; full lint and typecheck where feasible                                                                     | blocked |
| V4  | R1, R2, R3, R4 | Rebuilt real Tauri host and official CC Switch v4.0.18 bootstrap | real-env     | `.cache/ccswitch-native/acceptance.json`: every assertion true. Actual upstream generated schema21; UI read 17 providers/all 11 apps, imported MCP/two prompts/skill with 3 resources, switched Claude A and Claude Desktop B and completed both loopback chats, including reload. Watcher refreshed automatically; schema20/22 rejected, schema21 recovered. | Read/import/switch, composite IDs, stale OAuth rejection, resource bytes, manual directory, live updates, schema errors | passed  |

## Decisions

| ID  | Date       | Decision                                                                                                            | Action    | Based on           | Reversal trigger                                                   |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------- | --------- | ------------------ | ------------------------------------------------------------------ |
| D1  | 2026-10-22 | Pin schema21 and remove guessed legacy table/column aliases; do not migrate user's external DB.                     | implement | O1, O2, O3, G1, C1 | Current tagged schema contradicts fixture                          |
| D2  | 2026-10-22 | Expose other protocols and managed OAuth as browse-only instead of sending their keys to the bundled Anthropic SDK. | harden    | O1, G1, C1         | Verified protocol adapter and end-to-end dispatch become available |

## Residual risks

| ID  | Residual                       | From | Why still open                                                                                              | Next action                                     | Status |
| --- | ------------------------------ | ---- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------ |
| X1  | Whole-tree gates are not green | V3   | Existing unrelated TypeScript errors, generated public fixture lint errors, static-export path-list ENOBUFS | Repair owning changes/gate separately and rerun | open   |

## Outcome

| ID  | Signal                                                           | How / when measured                                          | Result                                                                                                  | Status |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------ |
| M1  | Current release contracts verified with isolated native fixtures | Official v4.0.18 bootstrap plus rebuilt Tauri UI, 2026-10-22 | All read/import/switch assertions passed; original installed CC Switch and source DB restored unchanged | met    |

## Maintainability follow-up

The user clarified that feature additions are welcome but must not become one large file. The Rust reader is split by responsibility: db.rs (311 lines), provider_config.rs (426 including inline tests), skill_files.rs (160 including inline tests), and types.rs (137 including wire-contract tests). TypeScript switch.ts is 198 lines; provider identity/registration, pure planning, active-state matching, and subscription activation each have a separate implementation and co-located tests. Existing command entry points remain wired through db.rs and switch.ts; no old implementation is retained beside the extracted modules.

The watcher remains desktop Settings UI-owned, as before this change. It is not a new headless runtime; the wiring review's request for an additional headless-roster comment is therefore not a runtime defect or an omitted implementation.

The tagged upstream sources were read through the GitHub connector and are cached in .cache/ccswitch-audit/upstream/. Local verification logs are under .cache/ccswitch-audit/. Native acceptance logs and scripts are under `.cache/ccswitch-native/`. The original Cognia process was preserved. Only isolated acceptance processes are stopped at cleanup.

Local snapshot follow-up: the seven unavailable skill bundles are six above the existing 50-resource limit and one above the existing 2 MiB resource-size limit. Their directories/manifests exist; they were not partially imported.

## Native findings repaired

- Use the actual current CC Switch bundle identity `com.ccswitch.desktop` for redirected app-store paths.
- Sanitize imported MCP namespaces while preserving source display names, including overwrite operations.
- Propagate status/schema errors into all content tabs instead of showing successful empty lists.
- Resolve explicitly switched CC Switch API credentials before default OAuth accounts; preserve explicit account selection and local account unlock checks. Persist relay endpoint/custom headers and register a fallback model when no model was declared.

A/B requests used fixture keys only. Captured requests verified the intended model and endpoint and absence of a seeded stale OAuth token. The upstream DB remained read-only; external agent configuration was not propagated during acceptance. Actual paid-provider inference was not tested.

## Magpie addition

User selected local gateway + model discovery. Verified against official Magpie v0.1.1318 and its integration contract, using the actual released CLI in an isolated XDG directory, custom port18995, and a loopback upstream. The native UI discovered `native/native-coder` (128K), tested its connection, selected it as default, sent a chat through Magpie and displayed `MAGPIE_NATIVE_GATEWAY_OK`. Full renderer reload preserved the chat/settings; Models refresh and repeated discovery passed. Stopping Magpie displayed an error and preserved saved configuration.

The new modules separate desktop port reading (`src-tauri/src/magpie.rs`), shared public API/catalog parsing (`packages/provider-core/src/providers/magpie.ts`), desktop client (`lib/magpie/client.ts`), and settings UI (`magpie-settings.tsx`). Existing provider persistence, model selection, OpenAI-compatible runtime and PII gates are reused. No Magpie provider keys are read. The proxy is deliberately not classified as local inference.

Auditors found one late-response overwrite risk: changing settings while discovery was pending could overwrite the new selection. A failing rerender regression confirmed it; the response now checks its settings snapshot before saving. Scoped test, wiring, Rust, PII and i18n audits otherwise passed. Final Magpie Jest run: 6 suites/157 tests passed; native Magpie Rust tests: 3 passed. CC Switch native acceptance is complete; the ledger remains verifying only because unrelated whole-tree gates in X1 are still open. Logs are under `.cache/magpie-native/`.

Sources: [CC Switch v4.0.18](https://github.com/farion1231/cc-switch/releases/tag/v4.0.18), [Magpie v0.1.1318](https://github.com/yetone/magpie/releases/tag/v0.1.1318), [Magpie integration contract](https://github.com/yetone/magpie/blob/main/docs/integrating.md).

Cleanup: isolated Cognia native PID66947, loopback fixture PID68242 and Magpie PID75352 exited after SIGTERM. The stopped acceptance CLI pointer was removed rather than restoring an already-dead original endpoint. The frontend server remains available on port3000. Screenshot `.cache/magpie-native/magpie-focused.png` was visually checked; it shows the native Magpie panel and a desktop notification, so it is not intended for publication. Original CC Switch support files and source DB were restored before Magpie acceptance.

## Follow-up maintainability review — 2026-10-22

Review scope: this task's uncommitted CCSwitch/Magpie changes and their direct callers, against HEAD; unrelated dirty work was preserved. Four review angles covered reuse, simplification, efficiency and module ownership.

Findings repaired:

1. The native status command resolves successfully with an `error` field for a schema/counts failure. Four content tabs only considered rejected IPC promises. They now display the payload error and avoid starting a content read while status is invalid. A missing `skills` table previously let the Providers query succeed and hide the database error. Regression tests cover this exact response shape.
2. The bundled switch accepts Anthropic sources, but its old propagation plan offered Codex/Gemini and remapped the same key into incompatible protocol fields. A single `CCSWITCH_PROPAGATION_AGENTS` constant now owns the Claude Code/OpenCode destinations for planning, dialog and sync defaults. Unsupported saved selections are filtered. Unreachable Codex/Gemini planner/executor branches and TS IPC wrappers were removed, and previous unsafe positive tests were replaced with no-write assertions. Generic native writer commands predate this task and remain registered public IPC capabilities; they are not obsolete schema compatibility code or unregistered dead modules.
3. Header removal with unchanged key/URL did not restart the SDK. Planning now compares old/new header maps, including removal; identical maps in different insertion orders avoid a redundant restart. The dialog supplies current persisted headers.
4. MCP transport parsing duplicated the established `normalizeMcpEntry`. The adapter now reuses that helper, including streamable HTTP normalization, while retaining per-row bulk validation for malformed drafts. No second parser was added.
5. The endpoint limitation badge described Codex, while OpenCode's remaining credential-only propagation also needs that information. The preview now shows the applicable OpenCode limitation with matching EN/ZH keys and docs.

Magpie's desktop port reader, shared public gateway client, desktop adapter and settings component remain separate and reachable. Review found no additional Magpie defect requiring implementation changes. No new module or dependency was introduced in this follow-up.

Verification: before the repairs, seven new behavioral assertions failed (four status payload cases, incompatible propagation, header removal, streamable HTTP). Final focused Jest: **24 suites / 440 tests passed**. Scoped ESLint, Prettier, i18n generation/check/lint/sort and diff whitespace check passed. Full `pnpm typecheck` was actually rerun: **26 existing errors in nine unrelated files**; `pnpm lint` was actually rerun and remains blocked by `public/.p0-native-fixture/bundle.js` (15 errors, 1391 warnings). Rust source was unchanged in this follow-up, so the earlier 51 passing Rust tests were not rerun.

Real Tauri verification used the existing rebuilt acceptance binary and fresh isolated profile. Both dialog/sync show only Claude Code/OpenCode, and selecting OpenCode displays the endpoint limitation. A separate SQLite backup with `skills` deliberately dropped displayed the native status error in Providers, MCP servers, Prompts and Skills. No external agent file was written. Evidence: `.cache/interop-review/{propagation-final,status-errors}.log`; final unit/lint/type logs are in the same folder. The initial debug bridge did not answer until direct native navigation reloaded the main document; no product change was made for that test-host issue.

Follow-up cleanup: native test PID7624 exited after SIGTERM; its global CLI endpoint pointer was removed. The frontend dev server remains available on port3000.
