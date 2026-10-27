# Evidence ledger: Gemini CLI and Antigravity CLI support audit

- Status: verifying
- Lane: deep
- Created: 2026-10-24
- Updated: 2026-10-25
- Related: ADR-0062, ADR-0064, ADR-0217; protocol/external-agent-runtimes.json

## Original request

> 帮我校对一下现在对geminicli和anti gravitycli的支持情况

## Follow-up request

> 继续把 Antigravity CLI 的官方 ACP 接入补齐，同时修复 Gemini 的文档和版本验证漂移，按 evidence-driven-dev 推进到测试和真实环境验证。

The 2026-10-24 audit below is historical evidence. The 2026-10-25 follow-up authorizes implementation, isolated official runtime preparation and real-host validation. New findings and verification supersede the historical matrix only where explicitly stated. No commit or push is requested.

## Knowledge

| ID  | Statement                                                                                                                                           | State    | Basis                                                                                                                                                    | Depends on     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| G1  | Audit the current integrations against source, upstream contracts and reproducible checks.                                                          | Agreed   | User request, 2026-10-24.                                                                                                                                | -              |
| C1  | Preserve unrelated concurrent work; G2 supersedes the initial audit-only restriction for task-owned changes.                                        | Verified | User follow-up and concurrent-tree-safety, 2026-10-25.                                                                                                   | G2             |
| O1  | At the 2026-10-24 audit: Gemini CLI has an executable ACP preset, system runtime descriptor, history source and MCP adapter.                        | Verified | ecosystem-adapters.ts; external-agent-runtimes.json; gemini-cli.ts; agents/gemini.ts, inspected 2026-10-24.                                              | -              |
| O2  | At the 2026-10-24 audit: Antigravity has branding and CC Switch provider records, but no built-in executable preset, MCP adapter or history source. | Verified | Preset, runtime, ecosystem, MCP and session-source registries inspected 2026-10-24.                                                                      | -              |
| O3  | Generic ACP Registry discovery has no production app caller.                                                                                        | Verified | service.ts:711; registry-discovery.ts; repository reference search excluding tests, 2026-10-24.                                                          | -              |
| O4  | Official ACP Registry lists Google Antigravity 1.4.3 as a separate binary distribution.                                                             | Verified | Official registry fetched 2026-10-24; macOS command is agy_acp_server.par, Windows agy_acp_server.exe.                                                   | -              |
| O5  | Gemini individual Free/Pro/Ultra access ended on 2026-06-18; enterprise and paid API paths remain distinct.                                         | Verified | Google Developers transition announcement and upstream discussion #28017, read 2026-10-24.                                                               | -              |
| O6  | At the 2026-10-24 audit: Current Gemini launch uses --acp; the older ADR still names --experimental-acp.                                            | Verified | ecosystem-adapters.ts:476; protocol descriptor; official ACP docs; ADR-0064:40, 2026-10-24.                                                              | -              |
| O7  | At the 2026-10-24 audit: Focused integration checks pass, while broader ecosystem conformance fails because grok is unclaimed.                      | Verified | Node 26 rerun: 18 suites passed, 1 failed; 869 tests passed, 1 failed. No product source edited by this audit.                                           | -              |
| Q1  | Do current contracts and focused tests substantiate the advertised support?                                                                         | Answered | Gemini has implemented and locally tested paths; Antigravity lacks built-in wiring. Capability negotiation and authenticated acceptance remain distinct. | O1, O2, O3, O7 |
| Q2  | Can authenticated provider and actual app flows run on this host?                                                                                   | Answered | Follow-up isolated binaries pass local checks; no real credential selected and Tauri boot hits ENOSPC.                                                   | O11            |

| G2 | Implement official Antigravity ACP end to end and repair Gemini documentation/version evidence, with tests and real-environment checks. | Agreed | User follow-up, 2026-10-25. | G1 |
| C2 | Preserve native credential ownership and sandbox boundaries; do not fabricate certification or silently bypass missing authentication. | Verified | Existing lifecycle/PII/sandbox contracts; user scope, 2026-10-25. | - |
| O8 | Official Antigravity 1.4.3 macOS archive contains ACP server and localharness_external; checksum matched the official registry. | Verified | SHA-256 c57db0a9b8b712daa9c3c17cdb990a61842ea569f279e8bd79d7aa85a303b20b; extracted runtime retained under .cache/antigravity-contract-spike/runtime. Compressed task download removed after repeated disk exhaustion, 2026-10-25. | O4 |

| O9 | Official Antigravity ACP preset, catalog, native/Node launch, labels and profile are implemented through existing ports. | Verified | Source, focused tests and independent wiring review, 2026-10-25. | G2, O8 |
| O10 | Gemini 0.61.0 stores structured memoryScratchpad; importer now preserves it as JSON text instead of assigning an object to a text field. | Verified | Actual upstream recorder fixture and failing-then-passing regression, 2026-10-25. | G2 |
| O11 | Antigravity sandboxed account-free smoke passes through Cognia adapter, including companion startup and reconnect/load. | Verified | .cache/gemini-antigravity-cli-audit/antigravity-smoke.json, 2026-10-25; no model prompt sent. | O9 |
| O12 | Mandatory mode bypass in setters and incoming notifications is closed in Cognia-controlled paths. | Verified | Independent PII recheck: 50 passed; profile/client suites 371 passed; no universal enterprise-admin policy interception claimed, 2026-10-25. | O9 |

| G3 | Complete the account-free real ACP/sandbox lane; retain authenticated inference as a blocked acceptance branch. | Agreed | User answer on 2026-10-25: 先完成无账号的真实 ACP／沙箱验证，推理验收保留为阻塞项。 | G2 |

## Problem frame

For G1, produce an implementation-accurate support matrix covering discovery and launch, authentication, ACP execution, model/permission/session capabilities, MCP configuration, transcript import, CC Switch and host limits. Separate upstream availability, source wiring, test evidence and real-provider acceptance. Follow-up G2 widens the frame to official ACP runtime/preset/native launch and Gemini drift repairs. Reuse the system-runtime lifecycle and shared ACP/PII/permission ports. Antigravity transcript import, MCP config migration, CC Switch credential adoption and building a generic managed installer remain separate features. C1 now means preserve unrelated files and record task-owned changes explicitly.

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                                                                                                 |
| ------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| scale        | medium | Runtime catalog, shared ACP package, import adapters, configuration and Rust spawn policy.                                                                  |
| technical    | medium | Current upstream contracts can differ from historical ADRs.                                                                                                 |
| coupling     | medium | Desktop/headless process hosts and browser/mobile host availability differ.                                                                                 |
| requirement  | low    | Read-only support audit has a clear requested result.                                                                                                       |
| verification | high   | Mocked tests cannot establish authenticated provider or real-shell behavior.                                                                                |
| risk         | high   | Official native runtime, companion integrity, credentials, sandbox and approval authority cross trust boundaries; credentials and schemas remain unchanged. |

## Risks

| ID  | Risk (impact)                                                                              | Severity | Source                                                        | Claim                                                                     | Refuted by                                                                  |
| --- | ------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| R1  | A preset or icon is mistaken for working end-to-end integration.                           | medium   | Risk catalog: runtime wiring; ADR-0064 launch failures.       | Each supported surface has a registered runtime path and scoped evidence. | Missing registration or real launch failure.                                |
| R2  | Current upstream behavior has drifted beyond stored versions or historical ADR statements. | medium   | ADR-0062 import formats; upstream official CLI documentation. | Version-specific statements identify their evidence and limitations.      | Current official launch, auth or file contracts contradict the integration. |
| R3  | Local tests are reported as authenticated acceptance.                                      | medium   | Risk catalog: three shells and real-provider verification.    | Tests and provider/shell checks are reported separately.                  | A support claim relies only on mocked transport tests.                      |

| R4 | Official executable starts with a missing or attacker-selected helper, unsafe native permissions or wrong platform command. | high | Official registry binary layout; ADR-0049 sandbox; lens:STRIDE. | Host resolves the official server/helper and preserves sandbox and permission gates. | Arbitrary helper override executes, missing helper silently falls back, or approval modes bypass host restrictions. |
| R5 | New preset is registered incompletely across UI, CLI, policy or ecosystem catalogs. | medium | Risk catalog: wiring and i18n; ADR-0217 package ports. | Runtime appears through existing pickers and guarded process paths. | Missing mapping, untranslated key, false installation/certification or unreachable preset. |
| R6 | Version evidence is bumped without reproducing current Gemini recording semantics. | medium | Official 0.61.0 recording implementation; ADR-0062. | A fixture produced by the actual selected release imports without corrupting state. | Object scratchpad reaches a string field or fixture provenance does not match the verified release. |

## Verification obligations

| ID  | Risk   | Method                                                                                           | Independence   | Evidence                                                                                                                                                                          | Coverage                                                                                                            | Status |
| --- | ------ | ------------------------------------------------------------------------------------------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------ |
| V1  | R1     | Trace preset, process policy, client, import, MCP and CC Switch registrations.                   | fresh-reviewer | Independent wiring audit found settings/composer/CLI/team/runtime/probe/native call paths connected; historical matrix below remains time-scoped.                                 | Current task source; no new Antigravity history/MCP migration claimed.                                              | passed |
| V2  | R2     | Compare official Gemini and Antigravity CLI/ACP/auth contracts and pinned versions.              | tool           | Official sources below establish --acp, separate Antigravity runtime, account transition and changed MCP layout.                                                                  | Published docs as read 2026-10-24; sandbox 0.61.0 and import metadata 0.57.0 are not current release certification. | passed |
| V3  | R1, R3 | Run focused existing Jest suites for presets, ACP, imports, MCP and CC Switch.                   | tool           | Initial focused run: 12 suites / 606 tests passed. Node 26 consolidated rerun: 19 suites, 18 passed / 1 failed; 869 tests passed / 1 failed. See exact command and failure below. | Headless contracts, fixtures and mocked UI; existing broader conformance failure remains open.                      | failed |
| V4  | R3     | Check runtime availability and bounded local handshake; carry unavailable provider/app branches. | real-env       | Initial system PATH had no CLI; follow-up prepared official runtimes under task cache and verified actual initialization. Global installation remains unchanged.                  | Local isolated runtime availability passed; authenticated inference and Tauri branches remain V8/V10.               | passed |
| V5  | R2     | Validate ledger and formatting, inspect final task diff.                                         | tool           | ledger.mjs check --final, task-file Prettier and whitespace checks after the follow-up update.                                                                                    | Task-owned source/docs; preserve unrelated shared changes.                                                          | passed |

| V6 | R4, R5 | Failing behavioral tests then preset/runtime/ecosystem/UI and native spawn tests. | tool | Final broad Jest: 22 suites passed, 1 failed; 1118 tests passed, 1 failed, 1 existing skipped. Only failure is unchanged Grok conformance. Rust crate: 336 passed. Independent native recheck: 17 passed. Red logs and source regressions cover runtime, helper, digest, permissions, labels and platform aliases. | Task integration contracts pass; broad conformance failure carried as X2. No coverage run. | passed |
| V7 | R6 | Official Gemini 0.61.0 recording capture, regression test and bilingual docs correction. | real-env | Official recorder and loader differential passed; real CLI version and ACP v1 initialization passed. Adapter/fixture/registry/import tests passed 91 tests. Pinned fixture and smoke script checked in working tree. | Recording/import contract and account-free CLI startup; no authenticated inference. | passed |
| V8 | R4, R3 | Official Antigravity binary through Cognia adapter and sandbox: initialize, auth/session negotiation, cancellation/permissions when auth available. | real-env | Actual sandboxed initialization, no-credential refusal, synthetic-key local session/modes/list/reconnect-load passed. No real authentication, model inference, active-turn cancellation or model-driven native/MCP tool calls. | macOS; account-free portion passed, authenticated branch remains blocked. | blocked |
| V9 | R4, R5 | Independent PII/wiring/test/i18n and native review; applicable lint/type/static/contract gates. | tool | Full typecheck and lint passed; agent-capabilities, static-export, plugin-contract, i18n build/parity/sort passed. Review findings repaired and rechecked. Global colocated gate fails on unrelated Lume workspace.rs. Author types regenerated and final freshness check passed; docs typecheck passed. | Task-owned review clean; unrelated repository gate failures carried. | failed |
| V10 | R3, R5 | Real Tauri boot, external-agent settings/preset path and adjacent surface; capture console/native evidence. | real-env | Two tracked debug launches failed before app startup: rustc-LLVM ERROR: IO failure on output stream: No space left on device. Both tracked sessions stopped. No screenshot or UI acceptance claimed. | macOS real Tauri unavailable due disk; CLI sandbox evidence is separate. | blocked |

| V11 | R3, R4 | Run real official Antigravity account-free acceptance through the production ACP adapter and OS sandbox. | real-env | antigravity-smoke.json: version 1.4.3, protocol 1, unauthenticatedSessionRefused, localSessionAndModeNegotiation, listed and reconnectLoad all passed; no remaining server/helper processes. | Fresh GEMINI_HOME and explicit file-only synthetic credentials; no inference; empty-session reload only. | passed |

## Decisions

| ID  | Date       | Decision                                                                                                                                                     | Action   | Based on                       | Reversal trigger                                                                           |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------ | ------------------------------------------------------------------------------------------ |
| D1  | 2026-10-24 | Audit current source and official contracts before recommending repairs.                                                                                     | diagnose | G1, C1, O1                     | A concrete failing behavior or revised task scope requires implementation.                 |
| D2  | 2026-10-24 | Report Gemini as implemented with scoped verification, and Antigravity as lacking a built-in integration; carry provider acceptance and the broader failure. | diagnose | G1, O1, O2, O3, O4, O5, O6, O7 | A new production registration, a passing live provider run or a changed upstream contract. |

| D3 | 2026-10-25 | Reopen for authorized implementation; inspect official server and helper before fixing launch wiring. | spike | G2, C2, O8 | Actual executable contract contradicts published registry or safe native launch cannot be established. |

| D4 | 2026-10-25 | Implement system-owned official ACP support through existing host/PII/lifecycle ports; keep managed installation, transcript import and MCP migration outside this runtime change. | implement | G2, C2, O8 | Official contract or host acceptance contradicts the selected runtime path. |
| D5 | 2026-10-25 | Repair mandatory-mode notifications and helper identity/alias/hash findings before reporting verification; retain account and desktop blockers. | diagnose | O9, O10, O11, O12 | Further review finds a bypass or real authenticated execution contradicts the tested contract. |

| D6 | 2026-10-25 | Record the user-selected account-free acceptance scope as verified; keep authenticated inference explicitly blocked without initiating login or model requests. | scope-down | G3, O11 | User later requests authenticated acceptance and configures the appropriate local account or credential. |

## Residual risks

| ID  | Residual                                                                                                         | From   | Why still open                                                                                                                                                           | Next action                                                                                                              | Status |
| --- | ---------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------ |
| X1  | Authenticated inference, active-turn cancellation and model-driven native/MCP tool acceptance remain unverified. | V8     | User explicitly selected account-free verification on 2026-10-25 and instructed that inference remain blocked. Native keychain credentials were not inspected or copied. | Resume only when the user later requests authenticated acceptance and configures the official login or local credential. | open   |
| X2  | Existing ecosystem conformance failure: grok runtime is absent from ecosystem ownership rows.                    | V3     | Present in the unchanged checkout and outside the two audited integrations.                                                                                              | Repair its owning catalog entry and rerun conformance separately.                                                        | open   |
| X3  | Gemini import validation metadata and sandbox pin now both identify 0.61.0.                                      | R2, V7 | Resolved by actual upstream recorder output, loader differential and pinned-release regression; no claim about other releases.                                           | Revalidate whenever the selected release changes.                                                                        | closed |

| X4 | Real desktop UI and renderer-to-Rust acceptance remain blocked by disk exhaustion. | V10 | Both Tauri attempts reached ENOSPC before boot. | Free sufficient disk space and rerun the tracked Tauri debug flow; capture settings preset, connection and adjacent surface. | open |
| X5 | Repository-wide colocated gate fails on existing unrelated Lume workspace.rs. | V9 | File belongs to concurrent work and has no in-file unit test; task-owned files have tests. | Owning task adds the missing test; rerun global gate. | open |
| X6 | Native runtime context and enterprise administrator auto-proceed are outside universal Cognia interception. | R4, V8 | Official server independently loads native context; enterprise terminal policy can proceed without a client permission request. | Keep limitations visible; validate the selected account/admin policy before claiming full tool/PII enforcement. | open |

## Outcome

| ID  | Signal                                                                                        | How / when measured                                                               | Result                                                                                                           | Status |
| --- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | A support matrix distinguishes implemented, locally verified, absent and unaccepted behavior. | Source trace, official contract comparison and actual Jest results on 2026-10-24. | Matrix below establishes the requested current support status; product acceptance remains explicitly unverified. | met    |

| M2 | Official Antigravity runtime is reachable through Cognia and completes a bounded real-host interaction; Gemini selected-release recording imports correctly. | Official 1.4.3 bundle via production adapter/sandbox and official Gemini 0.61.0 recorder on 2026-10-25. | Account-free real-host interaction and recording import met; authenticated/provider and desktop UI branches remain explicitly carried. | met |

## Follow-up implementation and measured results (2026-10-25)

| Acceptance surface            | Measured result                                                                                                                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Official Antigravity runtime  | System-owned antigravity-acp preset/catalog, official server (not agy print), UI/team/CLI identity, no automatic installer claim.                                                                                                                                  |
| Host integrity and sandbox    | Canonical release sibling helper required; caller/inherited helper override replaced; both files bound into consent digest; async/streamed probe hashing; narrow native state writes; private-state/Bot cloning refused. Linux registry argument is injected once. |
| ACP behavior                  | Namespaced systemPrompt is preserved on setup/restore; native modes map explicitly, Plan fails; persisted modes reset. Mandatory rules retain native default and terminate transport on unsafe mode responses/notifications.                                       |
| Gemini drift                  | Bilingual ADR uses current --acp; selected release 0.61.0 verified by real recorder/loader and CLI init. Structured scratchpad regression fixed, fixture/provenance/version-pin check added.                                                                       |
| Existing infrastructure       | Shared lifecycle consent, native account ownership, PII frame gate and process host reused. Generic Registry discovery stays dormant.                                                                                                                              |
| Unit and deterministic checks | 1118 Jest passed / 1 existing Grok failure / 1 skipped; 336 Rust passed. Full lint/typecheck passed. See gate details below.                                                                                                                                       |
| Real environment              | Official Antigravity account-free sandbox checks passed; actual Gemini recorder/CLI init passed. Real inference and full desktop UI are not accepted.                                                                                                              |

New files are limited to a vendor-specific profile/test and reproducible smoke/recording artifacts: generic ACP behavior cannot supply Antigravity-specific metadata/modes, and generic acp-live does not drive Cognia’s host/sandbox or an official recorder-vs-importer differential. Existing modules own catalog, launch, version and UI changes. A minor root changeset was generated with pnpm changeset. No commit or push was made.

## Historical support matrix (2026-10-24)

As of 2026-10-24, Gemini CLI has an implemented integration with passing focused contracts. Antigravity CLI has no built-in Cognia integration. These are source/test conclusions, not authenticated acceptance.

| Surface                                      | Gemini CLI                                                                                                                                                                                                                                       | Antigravity CLI                                                                                                                | Owning evidence                                                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quick-add and execution                      | Executable `gemini-cli` preset starts installed `gemini --acp` over stdio.                                                                                                                                                                       | No shipped preset, runtime descriptor or ecosystem row for `agy` or the official ACP server.                                   | `lib/ai/agent/external/ecosystem-adapters.ts:451`; `config/presets.ts`; `protocol/external-agent-runtimes.json:293`; `lib/agent-ecosystem/catalog.ts:104`.            |
| Installation and versions                    | Desktop descriptor is system-owned, with no managed distributions; inspect executable/path/version. Sandbox bundle separately pins 0.61.0.                                                                                                       | No governed installation or certification entry.                                                                               | Runtime descriptor; `deploy/bundle/agent-versions.json:88`. A sandbox pin is not a desktop install or live certification.                                             |
| Authentication                               | Uses CLI-native credentials/configuration or configured environment. No Gemini subscription-provider mapping in Cognia's account picker. Hint names API key, Vertex, gateway and enterprise.                                                     | No dedicated login/account integration.                                                                                        | `config/preset-provider.ts`; `ecosystem-adapters.ts:470`; generic ACP `authenticate({methodId})` in `packages/agent-acp/src/client.ts`.                               |
| Chat, progress, permissions and cancellation | Routed through registered shared ACP adapter and host ports, with PII gate. Existing tests cover these generic protocol paths.                                                                                                                   | Shared ACP transport is reusable infrastructure, not evidence of a connected Antigravity agent.                                | `external/manager.ts:390`; `external/integrations/acp.ts`; `packages/agent-acp/src/client.test.ts`.                                                                   |
| Models and native sessions                   | Shared client supports advertised model/config selection, mode changes, list/load/resume and gated extensions. Actual support depends on the running agent's negotiated capabilities.                                                            | No observed negotiation or live behavior.                                                                                      | Shared ACP client's `setSessionModel`, `setSessionMode`, `listSessions`, `loadSession`, `resumeSession`; no Gemini-specific vendor profile or live run in this audit. |
| Cognia model gateway                         | Explicitly unsupported for Gemini runtime. The CLI's own upstream gateway auth hint does not mean Cognia model switching works.                                                                                                                  | No supported runtime mapping.                                                                                                  | `config/gateway-task.ts:72`; rejection case in `gateway-task.test.ts:2006`.                                                                                           |
| History import                               | Registered source scans `~/.gemini/tmp`; supports JSON/JSONL recordings, updates/rewinds, reasoning/tools/usage, exported content and subagent links. Import stamps native-runtime binding; actual native recovery remains capability-dependent. | No registered session source or vendor root.                                                                                   | `lib/session-import/registry.ts`; `adapters/gemini-cli.ts`; tests; verified metadata is 0.57.0, 2026-08-29.                                                           |
| MCP settings import/sync                     | Writable adapter for `~/.gemini/settings.json`; stdio, `url` SSE and `httpUrl` HTTP; preserves unmanaged fields.                                                                                                                                 | No adapter for Antigravity's separate MCP layout.                                                                              | `lib/claude/agents/gemini.ts`; adapter registry; `crates/cognia-agents/src/paths.rs:403`; official migration guide.                                                   |
| CC Switch                                    | Gemini rows can be read, but normal switch propagation targets only Claude Code and OpenCode. A Rust Gemini settings writer alone does not establish UI support.                                                                                 | `agy` provider metadata can be read; switching is disabled/rejected before settings writes.                                    | `lib/ccswitch/provider.ts:12`; `switch-plan.ts`; `switch.ts`; `crates/cognia-ccswitch/src/provider_config.rs:75`; passing `agy` rejection and disabled-button tests.  |
| ACP Registry                                 | Generic fetch/classification/config helpers exist.                                                                                                                                                                                               | Official registry has `antigravity-acp` 1.4.3, but Cognia discovery is intentionally dormant and has no production UI caller.  | `lifecycle/service.ts:695`; `registry-discovery.ts`; `packages/agent-acp/src/registry.ts`; upstream registry.                                                         |
| Host boundaries                              | Process execution requires a local desktop/headless/CLI host or a paired process host. Pure browser/mobile cannot locally spawn `gemini`; picker-based history parsing is separate.                                                              | Adding a custom ACP configuration would still require installation, spawn admission and acceptance; none was established here. | `external/host/process-host.ts`; `agent-transport.ts`; Rust spawn allowlist and operator admission in `crates/cognia-external-agent/src/presets.rs`.                  |

## Findings and next work

1. **Antigravity is an integration gap, not a rename of Gemini.** Its official CLI entry is `agy`; its registry ACP entry is `antigravity-acp`, launched by a separate server binary. A prospective integration should use the official contract and account flow, add a governed runtime/preset and handle packaged helpers, environment and sandbox admission. Simply adding an icon, changing `gemini` to `agy`, or pointing an ACP client at print-mode NDJSON does not establish compatibility. No Antigravity process was started here.
2. **Gemini support needs account qualification.** Google's 2026-05-19 announcement and 2026-06-18 upstream notice retire individual Free/Pro/Ultra access, while preserving enterprise and paid API access. Existing Cognia auth hints already name those distinct routes; this audit does not find a universal `GOOGLE_API_KEY` requirement or claim all Gemini access has ended.
3. **Gemini documentation and release evidence drift.** ADR-0064's historical `--experimental-acp` statement differs from current source/tests and official `--acp` docs. Import validation metadata and sandbox pin identify different versions; this proves an evidence gap, not a demonstrated parser failure.
4. **MCP and history need separate Antigravity owners.** Official migration docs locate global MCP at `~/.gemini/config/mcp_config.json`, workspace MCP at `.agents/mcp_config.json`, and remote endpoints under `serverUrl`. Cognia's Gemini adapter does not cover those contracts. History import must be based on an observed supported format; none is registered.
5. **Broader conformance is not green.** The unchanged checkout's catalog omits ownership of `grok`. This is unrelated to a demonstrated Gemini/Antigravity behavior defect but prevents claiming every integration gate passed.

## Reproducible verification

The initial required-root-runner invocation selected the first twelve suites below and passed 606 tests. The installed fallback `pnpm` emits a Node 24 engine warning even though shell `node` is 26.12.1. To remove that environment uncertainty, the consolidated run invoked the same pnpm CLI under explicit Node 26.12.1. The broad failure remained.

```sh
node /Users/bytedance/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pnpm/bin/pnpm.mjs test \
  --runInBand --runTestsByPath \
  lib/ai/agent/external/ecosystem-adapters.test.ts \
  lib/ai/agent/external/config/presets.test.ts \
  lib/ai/agent/external/config/installed-runtimes.test.ts \
  lib/ai/agent/external/config/install-catalog.test.ts \
  lib/session-import/adapters/gemini-cli.test.ts \
  lib/session-import/registry.test.ts \
  lib/session-import/fixtures/upstream-generations.test.ts \
  lib/claude/agents/gemini.test.ts \
  lib/ccswitch/provider.test.ts \
  lib/ccswitch/switch.test.ts \
  packages/agent-acp/src/client.test.ts \
  packages/agent-acp/src/vendor-profiles.test.ts \
  lib/ai/agent/external/config/gateway-task.test.ts \
  lib/ai/agent/external/policy/security-policy.test.ts \
  lib/ai/agent/external/lifecycle/registry-discovery.test.ts \
  lib/agent-ecosystem/catalog.test.ts \
  lib/agent-ecosystem/conformance.test.ts \
  packages/agent-acp/src/registry.test.ts \
  components/settings/ccswitch/tabs/providers-tab.test.tsx
```

Actual execution used `/Users/bytedance/.nvm/versions/node/v26.12.1/bin/node` for the leading `node` above. Full output is local and ignored at `.cache/gemini-antigravity-cli-audit/jest.log`.

```text
Test Suites: 1 failed, 18 passed, 19 total
Tests:       1 failed, 869 passed, 870 total
Snapshots:   1 passed, 1 total
FAIL lib/agent-ecosystem/conformance.test.ts:42
claims every catalogued runtime exactly once
Expected includes "grok"; Received does not.
```

The CC Switch UI suite also emitted existing React `act(...)` warnings and passed its assertions. No full typecheck/build/lint, Rust test build, coverage run, device run or live UI/provider run was performed: this task changes only an audit document. Source tracing cannot replace those forms of acceptance. No implementation, credential mutation, CLI installation, commit or push was performed.

## Official sources

Read on 2026-10-24; these support upstream facts rather than prove Cognia runtime behavior.

- [Gemini ACP mode](https://geminicli.com/docs/cli/acp-mode/): current `gemini --acp` entry point.
- [Google's transition announcement](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/): individual account end date and continuing enterprise/paid API routes.
- [Gemini maintainer transition notice](https://github.com/google-gemini/gemini-cli/discussions/28017): transition effective 2026-06-18.
- [Antigravity quickstart](https://antigravity.google/docs/getting-started?tab=cli): `agy` CLI entry point.
- [Official ACP Registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json): `antigravity-acp` 1.4.3 and platform-specific server binaries/checksums.
- [Antigravity migration guide](https://antigravity.google/docs/cli/gcli-migration/): separate MCP locations and endpoint key.
- [Antigravity CLI reference](https://antigravity.google/docs/cli/reference): print-mode output formats; availability of structured stdout alone is not ACP compatibility.

## Follow-up verification artifacts and commands

- Final source tests: `.cache/gemini-antigravity-cli-audit/final-jest.log` (exact 23-suite root runner invocation and the single unchanged Grok ownership failure).
- Native full crate: `cargo test -p cognia-external-agent --lib`; `.cache/antigravity-contract-spike/native-crate-tests.log`, 336 passed. Independent streaming/cancellation recheck: 17 passed.
- `pnpm typecheck` and `pnpm lint`: exit 0, logs `typecheck-final.log` and `lint-final.log` under the task cache. Nested fallback pnpm still emits its Node24 engine warning; the task's main checks used the Node26 host and no warning was treated as success evidence.
- `pnpm audit:agent-capabilities`, `pnpm lint:static-export`, `pnpm plugin:contract:check`, `pnpm i18n:build:check`, `pnpm lint:i18n`, `pnpm i18n:sort:check`: passed. Generated SDK author types were rebuilt after the new contract vocabulary; final author-types:check passed (85 declarations). pnpm --filter docs typecheck also passed.
- `pnpm audit:colocated-tests`: failed on existing `crates/cognia-automation/src/cua_sandbox/lume/workspace.rs`; no baseline rewrite or unrelated repair made.
- Official Antigravity: `pnpm exec tsx scripts/smoke/antigravity-acp-smoke.ts`; `antigravity-smoke.json` and `.log`. Explicit authenticated lane is `--live-provider` with locally configured `GEMINI_API_KEY`; it has not been run.
- Official Gemini recorder: `pnpm exec tsx scripts/smoke/gemini-history-smoke.ts <installed-core-directory>`; `gemini-0.61.0/history-smoke.log`. Official CLI version/init artifacts: `gemini-0.61.0/cli-version.log` and `acp-probe.json`. The task-owned downloaded Gemini node_modules was removed after verification to recover disk; package/lock, fixture, logs and smoke procedure remain.
- Desktop: tracked `agent-debug.mjs launch --shared --no-watch` and retry `--timeout 240000` failed before boot due ENOSPC; tracked `stop` succeeded for both. No browser result substitutes for Tauri acceptance.
- Independent PII, wiring, test/i18n and native reviews found mode-notification, renamed-symlink identity and blocking-hash issues; all actionable task findings were fixed and rechecked. Upstream native-context/admin-policy limits remain X6.

The historical audit's “no implementation/install/tests” scope statements describe only 2026-10-24. This follow-up performed the implementation, isolated runtime downloads and checks above. No credential harvesting, native-account copying, global CLI installation, coverage command, commit or push occurred.

## User-confirmed acceptance scope (2026-10-25)

The user selected: “先完成无账号的真实 ACP／沙箱验证，推理验收保留为阻塞项”. Existing official Antigravity account-free production-host/sandbox checks satisfy that lane (V11). V8 remains blocked for authenticated inference and model-driven behavior; V10 remains independently blocked by the observed Tauri build disk exhaustion. No login or model prompt is required for the selected lane, and no blocked branch is reported as passed.
