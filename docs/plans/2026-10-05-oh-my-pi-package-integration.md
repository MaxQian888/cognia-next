# Oh-my-pi integration through the extracted agent packages

Date: 2026-10-05
Status: Independent package implemented and verified on 2026-10-06; host/product integration awaits separate approval
Scope: OMP runtime, native history, host integration, migration surfaces and shared product capabilities
Architecture baseline: inspected working tree plus HEAD `e931feec0`; ADR-0217
Upstream target: OMP `18.6.1`, verified against GitHub and npm in the preceding compatibility investigation

## Decision summary

Implement OMP as `@cognia/agent-omp`, following the landed Codex/DSH package pattern. The package owns OMP protocol semantics and pure native-history parsing. App, CLI and headless hosts inject machine access, outbound privacy checks, approval policy and launch environment. The existing runtime catalog and host security policy remain authoritative.

This supersedes the earlier proposal to place the implementation under `lib/ai/agent/external/runtimes/omp`. That location would add another app-private integration immediately after ADR-0217 extracted its contracts and host ports. Only host composition belongs under `lib/ai/agent/external/integrations/omp.ts`.

The functional target remains the complete supported OMP RPC surface and its configuration/history integration. Work phases are dependency order, not permission to declare basic chat support complete while leaving advanced capabilities silently unavailable. Each upstream operation must have a recorded mapping, product consumer, verification result or explicit platform limitation.

## Current architecture: landed code takes precedence over phase labels

Confirmed from current source:

| Owner                                      | Landed responsibility                                                                                                                        | Consequence for OMP                                                                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `@cognia/agent-contracts`                  | Adapter core, optional capabilities, canonical events/session state, execution semantics, host ports, ecosystem manifest and neutral history | Import these contracts directly; do not create app-local OMP copies                                                               |
| `@cognia/agent-runtime-kit`                | Base adapter, LF framing, JSON-RPC peer, orphan reclaim, history helpers and plugin compatibility                                            | Reuse the base, LF codec and applicable pure helpers; OMP is not JSON-RPC, so its request envelope/correlation stays OMP-specific |
| `@cognia/agent-codex`, `@cognia/agent-dsh` | Packaged adapters with injected host dependencies and separate manifest exports                                                              | Use their package/export/factory pattern                                                                                          |
| `@cognia/agent-orchestration`              | Store ports, replay, ledgers, fair scheduling and durable coordinator                                                                        | Reach OMP through existing executor/adapter semantics; do not import OMP into the scheduler/coordinator                           |
| `lib/ai/agent/external/integrations`       | Codex and DSH composition roots                                                                                                              | Add OMP factory here, inject host ports, register through the existing manager                                                    |
| `lib/session-import`                       | Discovery, IO, native-resume binding and mapping neutral history into stored rows                                                            | Add OMP discovery and delegate parsing to the package                                                                             |
| ADR-0107 migration subsystem               | Settings, commands, subagents and external memory conversion                                                                                 | Keep OMP migration readers and apply flows here                                                                                   |

The architecture plan's Phase 2 is landed. Orchestration has also progressed beyond the ADR table's “Planned” label: `packages/agent-orchestration/src/coordinator.ts` exists and the recent commits move the coordinator and ledgers behind store ports. Conversely, remaining integration extraction and catalog generation must not be assumed complete. Update on 2026-10-06: Pi and the other external adapters now have independent packages. OMP depends only on contracts/runtime-kit and remains independent of Pi.

`scripts/gates/check-package-boundaries.mjs` currently checks four named packages (`error-parsers`, `provider-types`, `vector`, `eval-core`), not the new agent packages. OMP must be added to enforceable boundary coverage, with regression tests; merely running the current gate would not establish its independence.

## Package ownership and dependency rules

| Proposed surface                            | Contents                                                                                                | Allowed dependencies / inputs                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `@cognia/agent-omp/manifest`                | Ecosystem cross-references, protocol identity, execution semantics                                      | Pure contract types and data; no runtime import                                                               |
| `@cognia/agent-omp/rpc-client`              | Adapter lifecycle, prompt tickets, queue/background state, native operations, capability implementation | Contracts, runtime-kit, injected host services                                                                |
| OMP internal wire/event modules             | Versioned commands, responses, chunk reassembly, normalized events                                      | Pure types/helpers; no app paths or host imports                                                              |
| `@cognia/agent-omp/history`                 | Content-to-`ParsedHistorySession` reader and cheap summary                                              | Contract/history helpers and required `HistoryReaderHost.redactText`; no IO                                   |
| `lib/ai/agent/external/integrations/omp.ts` | Adapter factory and host dependency composition                                                         | Existing process-host, environment builder, approval policy, redactor, logger, verified extension preparation |
| Host migration/config/session modules       | Paths, profiles, config writes, MCP synchronization, source discovery, stored-message mapping           | Existing owning registries and IO/persistence services                                                        |

Proposed identities: ecosystem/runtime `oh-my-pi`, preset/protocol `omp-rpc`, package `@cognia/agent-omp`; register cross-references once through `ompManifest.ecosystem`. Preserve Pi's identities and stored bindings. Confirm spelling against any concurrently added catalog entry immediately before implementation.

The new package follows current agent packages: private, AGPL-3.0-only, dist-only `types`/`import`/`require`/`default`, ESM and CJS, explicit dependency paths. No `@/`, React, Tauri, Dexie, zustand, Node process/filesystem implementation or Bun runtime dependency in the adapter. The OMP executable may require Bun; the Cognia adapter must not.

Do not add dependencies on `agent-pi`, `agent-codex`, `agent-dsh` or `agent-orchestration`. Do not change the Apache-2.0 transport SDK `@cognia/agent` into an integration host. Shared helpers move into runtime-kit only if truly protocol-neutral and required by more than one integration; OMP chunk framing belongs in OMP.

## Host ports and security authority

The integration primarily uses these established ports from `packages/agent-contracts/src/host.ts`:

- `AgentProcessHost`: raw stdout, stderr/exit subscriptions, spawn/send/bounded kill.
- `AgentLaunchEnvironmentResolver`: per-configuration state root, credentials and bound account immediately before spawn.
- `AgentApprovalPolicy`: host-owned approval-list evaluation.
- `AgentOutboundGate`: required; check prompt/steering/command inputs, instructions, host results, URI data and other model-bound payloads before delivery.
- `AgentLogger`: bounded, redacted diagnostics supplied by the host.

Update on 2026-10-06: file, terminal and additional host ports have also landed; their existence does not move IO or authorization ownership into the integration package. OMP-specific needs such as verified extension assets and authorized session locators receive narrow typed callbacks in the integration's constructor; only a demonstrated cross-integration requirement moves a port into contracts. No generic `invoke(method, args)` escape hatch.

The package never imports `@cognia/redact` directly: the landed extraction made the gate mandatory at the host boundary, partly because packed consumers cannot rely on app-private redactor packaging. History diagnostics also use the required host redactor. Native extension payloads must be covered by host-supplied policy and verified extension execution; checking only adapter-originated messages is insufficient.

Host-owned work includes binary allowlists, sandbox roots, profile/state isolation, configuration-account selection, extension integrity/staging, tool broker and audit. `set_host_tools` forwards OMP callbacks into that broker; it does not authorize OMP's own native tools. Native tool, direct shell/eval and descendant execution interception require separate real-process tests. Refuse startup or capability activation when the promised enforcement cannot be established.

Keep runtime/preset rows in `protocol/external-agent-runtimes.json`, capabilities in `protocol/agent-capabilities.json`, and permissions in `protocol/external-agent-security-policy.json` while they are current authorities. If Phase 3's generator lands before implementation, author in its established input and regenerate/check the existing aggregates. Never introduce a second hand-maintained authority or let manifest registration grant filesystem/process permission.

## Runtime behavior and shared capability mapping

OMP owns `ready`/v2 negotiation, bounded chunk reassembly with strict UTF-8 validation, id-correlated responses, `prompt_result` completion and `session_settled` quiescence. Reuse runtime-kit's physical LF decoder with appropriate limits; it does not by itself validate OMP logical chunks. Retain streamed messages when terminal frames omit prior content. Reject corrupt/interleaved chunks, bound incomplete data, and settle pending requests on timeout/exit.

One process per native session is the initial ownership model. Keep prompt completion separate from process reclaim eligibility: background work retains its event subscription and broker lease until the session is settled or explicitly terminated. Never replay a prompt after an uncertain outcome that may already have produced side effects.

Use existing optional capabilities in `agent-contracts/adapter` and `session-operations`. Core flows cover models/thinking, input and images, commands, queues, usage, compaction/retry, history/tree, rename/export, branch/fork, shell, resume and background turns. Queue deletion/promotion updates UI only after an upstream success response; duplicate inputs and in-flight admission must not produce false “cleared” states. Resume binds `agentConfigId` and the native locator, respects state isolation, and does not silently choose a different account. Fork/branch adoption updates native identity and usage baselines atomically.

Execution semantics are declared through `AgentExecutionSemantics`, verified against actual behavior. Normal interrupt and hard termination are distinct: if cancellation retires a process/session, the host must observe reconnect requirements and must not report a resumable pause. Test this through the existing teammate bridge, preserving the cancellation fix in `e931feec0`. Do not derive OMP semantics by copying Pi's declaration.

Advanced OMP operations remain in scope: subagent subscriptions/control, goal/todo, handoff, host URIs, fast mode/cache warming, live voice and word prediction. Reuse canonical goal/plan/task/event contracts where their meaning matches. Add a named optional shared capability when it has shared product semantics and a concrete consumer. For genuinely OMP-only operations, use `defineAdapterExtension` with an `omp.*` id and `manager.getAdapterExtension`; do not add `instanceof OmpRpcAdapter` branches or an untyped vendor-method API.

Shared UI/CLI consumers use public contracts. Native subagent IDs remain scoped under the OMP session; they do not become a second Cognia team scheduler. Device-specific voice behavior explicitly identifies whether audio belongs to the executing host or client. Outbound instructions and prediction drafts pass the same privacy boundary. Unsupported device/host combinations are explicit in the capability matrix.

## History, configuration and migration stay with their actual owners

`agent-omp/history` accepts content and returns neutral messages, usage, goals/plans/tasks, relations, recorded events and bounded loss records. OMP entry variants are preserved through namespaced annotations or explicit losses. The package never creates `StoredMessage`, scans home directories or accesses Dexie.

The app performs discovery under the selected `.omp` profile/configuration, bounded file reads and the existing `history-to-stored` mapping. Session listings and resume use the same native locator knowledge, with authorized file access supplied by the host. Do not reuse Pi's `.pi` roots or assume identical session headers.

OMP settings/commands/subagents/memory migration remains under the corresponding existing `lib/` subsystems. MCP projection extends the current config-sync system, preserves unowned fields, validates the chosen transport, and refuses to overwrite unparseable files. Profile/env overrides are resolved by the host; the package receives resolved launch facts. Pi package compatibility is separately assessed, never inferred from a shared ancestry.

## Delivery sequence and acceptance

| Phase / owner role    | Deliverable                                                                                                 | Verification required before proceeding                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — integration owner | Versioned upstream operation inventory; package skeleton, manifest, tests, dependency wiring                | Package build/typecheck, ESM/CJS/strict NodeNext installed consumer; manifest/history import closure                                                     |
| 2 — protocol owner    | Adapter lifecycle, v2 transport, event/completion state, native history                                     | Co-located deterministic tests: Unicode, malformed/large frames, concurrent requests/sessions, command-local completion, background yield, crash/timeout |
| 3 — host owner        | Factory, actual Node/Rust port wiring, catalog/security, environment isolation, broker and extension assets | Host regressions; sandbox startup/refusal; native/projected/descendant tool denials; profile and account isolation                                       |
| 4 — product owner     | Public capabilities, typed OMP extensions where needed, UI/CLI/remote operations, migration/source registry | Shared consumer tests, native-resume binding, queue/fork/usage correctness, remote cancel/decision/event ownership, both locales                         |
| 5 — integration owner | Remaining advanced operation mappings and real OMP process acceptance                                       | Isolated pinned process with local model fixture; subagents/goal/todo/host URI and device-aware voice/prediction checks; every inventory row resolved    |
| 6 — release owner     | Version certification, bilingual docs and rollback controls                                                 | Focused regressions plus package/capability/runtime/i18n/static-export gates; actual UI/CLI verification; platform/provider limits recorded              |

These are roles for one implementation effort, not authorization to spawn parallel agents. Implementation timing begins after user approval; no deadline is assumed.

Extend `scripts/build/pack-test-agent-package.mjs` with OMP's entry imports, behavior smoke and strict NodeNext consumer, including negative construction without the required gate. Prove `./manifest` and `./history` load no runtime/process/vendor SDK. Add the package to build wiring, package resolution for the actual consumers, and the package boundary gate (including forbidden framework/runtime dependencies and cross-integration imports).

Existing commands to use after implementation, with bounded resources and sequential heavy runs:

- `rtk pnpm --filter @cognia/agent-omp typecheck` and `rtk pnpm --filter @cognia/agent-omp pack:test` once the package exists.
- `rtk pnpm audit:package-boundaries` after adding agent coverage and testing the gate.
- `rtk pnpm audit:agent-capabilities`, `rtk pnpm audit:external-agent-runtimes`, `rtk pnpm audit:agent-control-methods`.
- Focused Jest tests in changed packages and host consumers; focused Rust host tests; real OMP process smoke using the existing harness infrastructure.
- `rtk pnpm i18n:build:check`, `rtk pnpm lint:i18n`, relevant lint/static-export checks, then UI/CLI/remote acceptance and broader build checks as resources allow.

Do not certify a version from mocked tests, an installed executable's version output or a passing package tarball test alone. Cloud-provider behavior and hardware audio behavior require their own evidence; a local model fixture certifies protocol/host behavior only. No coverage run is requested.

## Rollout, recovery and review decision

Registration is additive. Existing Pi configurations, session identities and user installations remain unchanged. Upgrade validation rechecks the latest upstream version at implementation time; `18.6.1` is the researched baseline, not a promise that a later release is already compatible.

Before certification, use the catalog's existing unverified-runtime behavior and keep capability claims evidence-based. On failed rollout, disable new OMP launches through the existing lifecycle/policy mechanism while preserving native data and allowing owned cleanup; do not downgrade by routing an OMP session through Pi. Configuration/migration writers preserve unknown fields and use current atomic-write/recovery conventions. Any actual stored-schema change requires a separate migration review; package extraction alone does not require one.

Diagnostics distinguish protocol negotiation, malformed frame, request timeout, extension integrity/handshake, process exit, runtime version and capability refusal. Reuse the host logger and existing lifecycle error surface; log bounded identifiers/codes without prompt text, secrets or raw transcripts.

Q1 — Approve the revised package-first architecture and previously requested full functional scope? Recommendation: yes; implement OMP as a new peer integration package, without making completion depend on extracting Pi or all other vendors.

| Review                       | Date       | Result                                                                                                                    |
| ---------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| Architecture/code inspection | 2026-10-05 | Landed ports, package exports, host factories, history and orchestration boundaries inspected; gate coverage gap recorded |
| User implementation approval | 2026-10-06 | Independent package implementation and live DeepSeek acceptance approved; host/product integration remains deferred       |

## Evidence

- [Agent package architecture plan](2026-10-05-agent-package-architecture.md)
- [ADR-0217](../content/docs/en/adr/0217-agent-integrations-are-packages-behind-host-ports.md)
- `packages/agent-contracts/src/{host,adapter,adapter-extension,semantics,ecosystem,history,session-operations}.ts`
- `packages/agent-runtime-kit/src/{base-adapter,lf-frame-decoder,history,index}.ts`
- `packages/agent-codex/src/{manifest,app-server-client,history,index}.ts`
- `lib/ai/agent/external/integrations/{codex,dsh}.ts` and `host/process-host.ts`
- `packages/agent-orchestration/src/{coordinator,store,decision-ledger,evidence}.ts`
- `scripts/build/pack-test-agent-package.mjs`, `scripts/gates/check-package-boundaries.mjs`, root build scripts
- [OMP 18.6.1 release](https://github.com/can1357/oh-my-pi/releases/tag/v18.6.1)
- [Versioned RPC specification](https://github.com/can1357/oh-my-pi/blob/v18.6.1/docs/rpc.md)
- [Versioned wire commands](https://github.com/can1357/oh-my-pi/blob/v18.6.1/packages/coding-agent/src/modes/rpc/wire/commands.ts)
- [Versioned MCP/profile rules](https://github.com/can1357/oh-my-pi/blob/v18.6.1/docs/mcp-config.md)

## 2026-10-06 approved package-only delivery

The user approved full implementation inside an independent package and explicitly reserved host/product integration for a later confirmation. `packages/agent-omp` therefore implements protocol, lifecycle, guard, typed controls, existing optional capabilities, neutral history/config, manifest declarations, co-located tests and isolated package/process verification. No manager factory, app import, preset/catalog/security registration, UI, migration writer or session discovery source is added.

The current package owns 60 upstream RPC commands. The native guard explicitly handles `session_start`, `session_switch` and `session_branch`; real OMP transitions do not repeat `session_start`. Process cancellation retires the live handle; a known native JSONL locator supports guarded relaunch. Throwing from upstream provider/direct-execution hooks is insufficient enforcement, so host egress revocation and explicit replacement results are mandatory.

See `packages/agent-omp/README.md` for the concrete host contracts, approved boundary, verification commands and platform limitations. Host composition must be reviewed separately before this package is made selectable in the product.

Extended acceptance on 2026-10-06 found and repaired lifecycle races in process admission, fork option inheritance, prompt ownership, stale identity reads, approval/callback generation isolation, unsent transition rejection, and retryable resource release. The package now maintains an explicit 60-command acceptance matrix under `packages/agent-omp/validation/rpc-acceptance-matrix.md`, separating real DeepSeek, native fixture, unit and prerequisite evidence. These checks do not authorize product registration.
