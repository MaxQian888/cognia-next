# Agent package architecture — inventory, design and phase plan

Date: 2026-10-05 · Owner: agent-architecture upgrade session · ADR: 0217 (to be written in Phase 1)

This plan turns the external-agent integrations, the built-in execution engines and the
multi-agent orchestration from app-private code into packages with explicit host ports.
It is grounded in a source audit run on 2026-10-05 against the working tree (including
other sessions' uncommitted edits). Line numbers drift; module names do not.

## 0. Constraints that shape everything

- **Shared tree.** ADR-0216 (archived session) and at least one Codex-desktop session left
  uncommitted edits in `lib/ai/agent/external/**`, `cli/src/runtime/external/**`,
  `protocol/external-agent-runtimes.json`, DSH/Pi/OpenCode clients. Files are moved only
  after their foreign hunks are committed by their owners (or with the user's explicit
  decision). New modules are preferred over in-place rewrites while that is unresolved.
- **No second authority.** `protocol/external-agent-runtimes.json`,
  `protocol/agent-capabilities.json` and `protocol/external-agent-security-policy.json` are
  gated and read by Rust (`include_str!` in `cognia-external-agent`). Packages may become
  the _source_ of runtime/capability rows only if the JSON becomes a generated aggregate with
  a `--check` gate. The security policy stays host-owned: a package can never widen it.
- **Sidecar runs TypeScript unbuilt (ADR-0197).** Anything the sidecar imports at runtime
  from `packages/` needs a `node` export condition pointing at `dist/`.
- **Licence (ADR-0142 §10).** `@cognia/agent` is Apache-2.0 transport-only and must not gain
  AGPL dependencies. New agent packages follow `@cognia/plugin-sdk` (AGPL-3.0-only, the
  published host-side precedent) unless the user decides otherwise.

## 1. Identity model (current, verified)

| Identity                                                                              | Example                                             | Owner (single source)                                                  | Notes                                                                    |
| ------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `ecosystemId`                                                                         | `codex`                                             | `lib/agent-ecosystem/catalog.ts`                                       | Cross-references only; 17 rows; **Goose missing**                        |
| `runtimeId`                                                                           | `codex-app-server`                                  | `protocol/external-agent-runtimes.json`                                | Launch descriptor, distributions, pinning                                |
| `presetId`                                                                            | `codex`, `pi-rpc`                                   | runtimes JSON `presetIds` + `config/presets.ts`                        | `pi` is a runtimeId, `pi-rpc` the preset                                 |
| `protocol`                                                                            | `acp`, `codex-app-server`, `dsh-sdk`                | config/preset, **not** the runtime row                                 | DSH runtime row says `dsh-sdk`, preset `deepseek-harness-acp` says `acp` |
| config instance                                                                       | `ExternalAgentConfig.id` (nanoid)                   | `lib/db/external-agent-configs` + host configs                         | Several per preset; `stateIsolation` (ADR-0216)                          |
| session source / migration vendor / subagent source / memory agent / plugin ecosystem | `codex` / `codex` / `codex-cli` / `codex` / `codex` | each subsystem's own registry, cross-referenced by the ecosystem table |                                                                          |

Mapping chain: instance → `metadata.preset` → `findRuntimeByPresetId` → runtimeId →
`findEcosystemByRuntimeId` → ecosystemId. Other hand-written identity maps that bypass the
table: `ecosystem-adapters.ts`, `config/preset-provider.ts`, `config/gateway-task.ts`,
`config/agent-binding.ts`, `config/preset-identity.ts`, CLI `backend-install.ts`,
`external-agent-session.ts:externalAgentCredentialEnv`, `backend-capabilities.ts`.

**Decision:** `lib/agent-ecosystem` stays the identity registry. Its rows move into each
ecosystem package's `manifest` export; the app's `catalog.ts` becomes the explicit list of
registered manifests. The other identity maps above are folded into manifests as typed fields
so a new ecosystem edits one manifest instead of eight maps.

## 2. Migration matrix

Legend — **Run**: protocol client; **Hist**: session-history parser; **Res**: native resume
binding; **Cfg**: settings/commands migration; **Sub**: subagent format; **Mem**: external
memory format; **Conv**: plugin conversion. Target package names are defined in §3.

| Ecosystem                                                                    | Run                                                                                           | Hist                                                             | Res                                                                                | Cfg                                                             | Sub                                 | Mem                                  | Conv                                                                                          | Target                                  |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------- | --------------------------------------- |
| codex                                                                        | `acp` (generic) + `codex-app-server` (4.8k LOC, `runtimes/codex/`)                            | `session-import/adapters/codex.ts`                               | preset hard-coded `codex` (bug: app-server-only users get `preset-not-configured`) | `settings-import/adapters/codex.ts`, `commands-import/codex.ts` | `subagent-importers/codex-cli.ts`   | `memory/external/providers/codex.ts` | `convert/ecosystem.ts:convertCodexPlugin`, `hook-dialects`                                    | `@cognia/agent-codex`                   |
| claude-code                                                                  | `acp` (`claude-agent-acp`)                                                                    | `adapters/claude-code*.ts`                                       | `claude-code`                                                                      | settings adapter                                                | `subagent-importers/claude-code.ts` | provider                             | `convert/claude-family.ts` (+ factory-droid, qoder, codebuddy, auggie, open-plugins profiles) | `@cognia/agent-claude-code`             |
| opencode                                                                     | `opencode-v2` (+`@opencode/client`), `acp`; V1 client **dead, unregistered**                  | `adapters/opencode*.ts` (+ Rust/Node SQLite readers)             | **no binding**                                                                     | settings + commands                                             | subagent                            | provider                             | `platform-bundles`                                                                            | `@cognia/agent-opencode`                |
| pi                                                                           | `pi-rpc` (3.1k LOC + peer/events/permission/auth)                                             | `adapters/pi*.ts`                                                | `pi-rpc`                                                                           | settings + commands                                             | subagent                            | provider                             | `convert/pi-package.ts`                                                                       | `@cognia/agent-pi`                      |
| deepseek-harness                                                             | `dsh-sdk` (sdk client, codec, runtime transport, install), `acp` profile `cognia-acp`         | —                                                                | —                                                                                  | —                                                               | —                                   | —                                    | —                                                                                             | `@cognia/agent-dsh`                     |
| aider                                                                        | `aider-cli` (process per turn)                                                                | `adapters/aider.ts` (picker only)                                | no binding                                                                         | —                                                               | —                                   | —                                    | —                                                                                             | `@cognia/agent-aider`                   |
| a2a / remote                                                                 | `a2a` HTTP client                                                                             | —                                                                | —                                                                                  | —                                                               | —                                   | —                                    | —                                                                                             | `@cognia/agent-a2a`                     |
| devin                                                                        | ACP wrapped by `DevinAcpAdapter` (process per session)                                        | —                                                                | —                                                                                  | —                                                               | —                                   | —                                    | `platform-bundles`                                                                            | `@cognia/agent-ecosystems/devin`        |
| kimi                                                                         | ACP + quirks in `acp-client.ts` (fork MCP rebind, compaction, tombstones) + `kimi-management` | —                                                                | —                                                                                  | —                                                               | —                                   | —                                    | `platform-bundles`                                                                            | `@cognia/agent-ecosystems/kimi`         |
| goose, qoder, kiro, droid, copilot-cli, qwen-code, cline, cursor, gemini-cli | ACP rows; quirks for goose/qoder/cline in `acp-client.ts`                                     | portable adapters for copilot/qwen/cline/cursor; `gemini-cli.ts` | cursor/copilot/qwen/gemini preset literals; cline no presetId                      | —                                                               | cursor, cline                       | —                                    | gemini-cli, cursor (bundles), qoder (claude-family)                                           | `@cognia/agent-ecosystems/<id>`         |
| continue-dev                                                                 | none                                                                                          | `adapters/continue-dev.ts`                                       | —                                                                                  | —                                                               | —                                   | —                                    | —                                                                                             | `@cognia/agent-ecosystems/continue-dev` |
| plugin adapters                                                              | `${pluginId}:${adapterId}` via `lib/plugin/bridge/external-agent-adapters-bridge.ts`          | plugin session sources                                           | —                                                                                  | —                                                               | —                                   | —                                    | —                                                                                             | compat wrapper in host (§4.3)           |

Shared, non-vendor pieces and their targets:

| Piece                                                                                                                                                  | Today                                                                                                | Target                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| External-agent wire/config types (3,042 lines)                                                                                                         | `types/agent/external-agent.ts` (imports only `@agentclientprotocol/sdk` types + agent-config-types) | `@cognia/agent-contracts/external-agent`; app path becomes a re-export                                                                                                         |
| `ProtocolAdapter` (≈90 members)                                                                                                                        | `lib/ai/agent/external/protocol-adapter.ts`                                                          | core lifecycle + optional capability interfaces in `@cognia/agent-contracts/adapter`; `BaseProtocolAdapter` in `@cognia/agent-runtime-kit`                                     |
| `JsonRpcPeer`, NDJSON frame decoder, usage folding, content blocks, session-capability resolvers, tool pre-approval, permission cascade, spawn reclaim | `lib/ai/agent/external/{json-rpc-peer,session,capability,policy}`                                    | `@cognia/agent-runtime-kit`                                                                                                                                                    |
| Host indirection (`agent-transport.ts`, `lib/native/external-agent.ts`, `agent-hooks.ts`) — swapped in the CLI by esbuild aliases                      | string-named `agentInvoke("spawn_external_agent", …)`                                                | typed ports `AgentProcessHost`, `AgentFileHost`, `AgentTerminalHost`, `AgentHookHost`, `AgentCredentialEnv` in contracts; Tauri impl in app, Node impl in CLI; aliases deleted |
| ACP client (5.3k LOC) with vendor switches                                                                                                             | `runtimes/acp/acp-client.ts`                                                                         | `@cognia/agent-acp` + `AcpVendorProfile` hook; vendor branches move to ecosystem profiles                                                                                      |
| Manager (5.5k LOC) incl. `instanceof` vendor branches                                                                                                  | `lib/ai/agent/external/manager.ts`                                                                   | stays in app; vendor branches replaced by typed `AgentIntegrationExtensions` declared by integrations                                                                          |
| Session-import registry, IO (Tauri fs), persistence, `to-parts`                                                                                        | `lib/session-import/`                                                                                | stays in app; format parsers move to ecosystem `./history` producing neutral graphs                                                                                            |
| Subagent / settings / commands / memory apply sides (stores, Dexie, Tauri)                                                                             | `*/apply.ts`, `edit.ts`, `home.ts`                                                                   | stay in app; pure parsers move to ecosystem `./subagents`, `./config`, `./memory`                                                                                              |
| Plugin conversion                                                                                                                                      | `lib/plugin/convert/` (16 ecosystems, bundled into the Rust CLI)                                     | per-ecosystem converters move to ecosystem `./plugin-convert`; the orchestrating `convertPluginBundle` and the Rust bundle stay in the app and import them                     |
| Neutral tool kernel                                                                                                                                    | `sidecar/src/tools/kernel/{define,result,failure,args}.ts` (zod only)                                | `@cognia/agent-tool-kernel` (+ neutral `defineTool`)                                                                                                                           |
| Claude SDK coupling in AI SDK rail (41 runtime paths)                                                                                                  | builtin tools call the SDK's pure `tool()` factory; `tools/plugin/server.ts`; host static imports    | cut per §4.5; vendor gate in `sidecar-architecture.json`                                                                                                                       |
| Team orchestration (104 files, 23k LOC)                                                                                                                | `lib/ai/agent/team/`                                                                                 | pure scheduling/durable logic to `@cognia/agent-orchestration` behind store/executor/workflow ports                                                                            |

Declared-but-dormant / drift found by the audit (each is fixed or explicitly labelled in the
phase that touches it): Goose missing from the ecosystem table; OpenCode V1 client unregistered
(3k LOC dead); plugin SDK adapters lack `forgetSessions`/`getSessions`/`cancel`/`healthCheck`
the manager calls unconditionally; Python adapter proxy covers 7 members; CLI spawn allowlist
(`node-backend.ts:89-111`) ungated and duplicates `cline`; `pluginEcosystem` null for
ecosystems that have converters; native-resume never persists the instance id; Pi session dir
read in 3 places, 2 ignore `PI_CODING_AGENT_SESSION_DIR`; OpenCode SQLite read twice with
different path lists; headless brain never runs squad bootstrap; workflow lease renew result
ignored; `resumeInFlightRuns` does not skip `__team__:` rows.

## 3. Target packages and dependency direction

```
@cognia/agent-contracts        types + tiny pure helpers; deps: @agentclientprotocol/sdk (types), none at runtime
  ▲
@cognia/agent-runtime-kit      BaseProtocolAdapter, JsonRpcPeer, frame codecs, capability resolvers, policy helpers
  ▲                            deps: contracts, @cognia/redact, @cognia/logging
@cognia/agent-acp              ACP client over AgentProcessHost; AcpVendorProfile hook
  ▲
@cognia/agent-codex | -claude-code | -opencode | -pi | -dsh | -aider | -a2a | -ecosystems
                               each: ./manifest, and only the capabilities it really has:
                               ./runtime/<protocol>, ./history, ./config, ./subagents, ./memory, ./plugin-convert
  ▲
app host (lib/, stores, components)  ── registers manifests, implements ports, owns policy/PII/sandbox/persistence
CLI host (cli/)                     ── implements the same ports with Node (replaces esbuild aliases)

@cognia/agent-tool-kernel      neutral tool definition (zod); consumed by sidecar builtin tools and both engine adapters
@cognia/agent-orchestration    scheduler, teammate pool, gates, durable coordinator, budget governor, synthesized workflow;
                               ports: TeamRunStore (CAS/lease/fencing), ExecutionJournal, TeammateExecutor,
                               WorkflowInvoker, NodeRegistrar, Clock/IdGen, TeamEvents
```

Rules (enforced by `scripts/gates/check-package-boundaries.mjs` extensions and pack tests):

1. No package imports `@/…`, React, Tauri, Dexie, zustand.
2. `history`, `config`, `subagents`, `memory`, `plugin-convert`, `manifest` entry points never
   transitively import a runtime entry, a process host, or a vendor SDK (closure test).
3. Ecosystem packages may depend on contracts, runtime-kit, acp — never on each other.
4. Capability _declaration_ (manifest) never grants permission; the host's security policy and
   permission guard remain the only authority.

## 4. Contract design

### 4.1 Adapter core and optional capabilities

`ExternalAgentAdapterCore` = `protocol`, `connectionStatus`, `connect`, `disconnect`,
`isConnected`, `createSession`, `closeSession`, `prompt`, `execute`, `respondToPermission`,
`cancel`, `getSession`, `getSessions`, `healthCheck`, `semantics`.
Everything else is grouped into named optional capability interfaces (`SessionResumeCapability`,
`SessionForkCapability`, `SessionModelCapability`, `TurnSteeringCapability`,
`SessionInputQueueCapability`, `SessionTreeCapability`, `CompactionCapability`,
`AuthCapability`, `ProviderCapability`, `DynamicMcpCapability`, `NesCapability`,
`DocumentSyncCapability`, `SessionShellCapability`, `ProviderUndoCapability`,
`AcpIntrospectionCapability`, `SessionRegistryCapability` (`forgetSessions`)) plus type guards.
The existing internal `ProtocolAdapter` becomes `ExternalAgentAdapterCore & Partial<all>` so
every current implementation still type-checks; callers switch from optional-chaining to
guards incrementally.

### 4.2 Execution semantics (replaces boolean capability flags for cancel/resume)

```ts
interface AgentExecutionSemantics {
  cancel: { scope: "turn" | "session" | "process"; reconnectsAfterCancel: boolean }
  resume: "native" | "relaunch-with-session" | "history-replay" | "unsupported"
  fork: "native" | "native-turn-boundary" | "clone-before-entry" | "unsupported"
  approvals: "per-tool-call" | "profile-fixed" | "none"
  processModel: "shared" | "per-session" | "per-turn" | "remote"
  maxProcesses?: number
}
```

Declared by each runtime implementation, refined per preset where the catalog already refines
(`presetRefinements`). Verified values: ACP turn/shared; Codex app-server turn/shared,
fork at turn boundary; DSH **process**/per-session, no resume/fork, profile-fixed approvals;
OpenCode V2 turn/shared (+owned per session); Pi turn/per-session (max 4), relaunch resume,
native fork; Aider process/per-turn, history-replay resume, no approvals; A2A turn(task)/remote.
Orchestration and UI read `semantics` instead of `instanceof` or protocol strings.

### 4.3 Plugin ABI compatibility

`packages/plugin-sdk` keeps exporting its `ProtocolAdapter`, `BaseProtocolAdapter`,
`SUPPORTED_EXTERNAL_AGENT_PROTOCOLS`. Both its types and the internal ones are re-based on
`@cognia/agent-contracts` (removing the `@/types/agent/external-agent` import from the SDK).
The bridge wraps every plugin factory output in `adaptPluginExternalAgentAdapter()` which
supplies the members the manager calls unconditionally (`forgetSessions`, `getSessions`,
`getSession`, `healthCheck`, `cancel`) from the adapter when present and from a session
ledger otherwise, never silently pretending an unsupported operation succeeded (unsupported
operations throw a typed `ExternalAgentCapabilityError`). Python proxies go through the same
wrapper. No `invoke(method, args)` escape hatch.

### 4.4 Host ports

`AgentProcessHost` (spawn/send/kill/exists + stdout/stderr/exit/state subscriptions),
`AgentFileHost` (workspace read/write/delete/list within allowed roots),
`AgentTerminalHost` (ACP terminal lifecycle), `AgentHookHost` (fire/observe/gate),
`AgentCredentialEnv` (resolve launch env for an instance: secrets, state root, bound account),
`AgentLogger`. The app implements them over Tauri/companion transport (today's
`agent-transport.ts`, `lib/native/external-agent.ts`), the CLI over `NodeExternalAgentBackend`
(today's alias targets). PII redaction stays inside the runtime-kit/integrations where it is
today (`hasNoLeakingPiiDeep` from `@cognia/redact`, a package) and in host ports.

### 4.5 Engines and tools (sidecar)

1. Neutral `defineTool` (same output shape as the SDK's pure `tool()` factory) in
   `@cognia/agent-tool-kernel`; neutral `alwaysLoad`/`searchHint` fields translated to
   `_meta["anthropic/*"]` only in `tools/adapters/sdk-mcp.ts`. Codemod ≈90 call sites.
2. Split `tools/plugin/server.ts` into neutral `round-trip.ts` + Claude-only server builder
   next to `adapters/sdk-mcp.ts`; same for `tools/a2ui/server.ts`.
3. Remove type couplings in `shared/wire/inbound.ts` (`Options[...]`) and
   `runtimes/common/call-ledger-gate.ts` (`HookCallbackMatcher`).
4. Host loads engine adapters lazily; router/control import `runtimes/capabilities.ts`;
   `session_api`/warm-pool reset become optional engine hooks returning a typed capability
   error when the Claude engine is absent.
5. Vendor gate: `@anthropic-ai/claude-agent-sdk*` allowed only under
   `runtimes/claude-agent-sdk/`, `tools/adapters/sdk-mcp*`, the Claude tool-server builders and
   `hooks/{native-executor,events}.ts`; closure test from ai-sdk and tool-bridge entries; an
   install test that runs the ai-sdk offline suite with the SDK absent.

### 4.6 Orchestration

Move pure modules unchanged (fair scheduler, teammate pool, gates, durable coordinator,
ledgers, synthesized workflow, wave runner, concurrency/model-preference controllers, budget
governor). Introduce ports grounded in current call sites: `TeamRunStore` (keeps CAS,
dispatch lease, attempt fencing, monotonic trajectory, live-run exclusion — upgrade the
`updatedAt` CAS to an integer revision only through the Dexie schema process),
`ExecutionJournal` (idempotent append), `TeammateExecutor` (four channels, returns semantics),
`WorkflowInvoker` + `NodeRegistrar` (team node descriptors registered by an app composition
root instead of `built-ins/index.ts` importing `../teams`), `TeamRunContextRegistry`,
`CompletionFanout`, `Clock`/`IdGen`, `TeamEvents`.

## 5. Phases and acceptance criteria

### Phase 1 — baseline and design (this document + ADR-0217)

- Deliverables: this plan; ADR-0217 (en + zh); gate extension design.
- Accept: matrix covers every catalog row and every satellite registry id; ADR lists amended ADRs
  (0051, 0062, 0068, 0090, 0107, 0142, 0169, 0197, 0216).

### Phase 2 — vertical pilot: DSH + Codex

- New: `@cognia/agent-contracts` (identity, external-agent types moved with app re-export,
  adapter core/capabilities, semantics, host ports), `@cognia/agent-runtime-kit` (subset needed
  by DSH/Codex), `@cognia/agent-dsh` (`./manifest`, `./runtime/sdk`), `@cognia/agent-codex`
  (`./manifest`, `./runtime/app-server`, `./history`, `./config`).
- App: implement ports over the existing transport; manager registers adapters from the
  integration packages; `lib/ai/agent/external/runtimes/{dsh,codex}` become forwarding modules or
  are deleted where all callers moved; CLI provides the Node port implementation for these two.
- Fix: DSH `semantics.cancel.scope = "process"` respected by manager/orchestration (cancel of a
  DSH session never reported as a turn cancel; reconnect required); Codex resume binding uses the
  ecosystem's presets (not the literal `codex`) and native resume persists the instance id and
  fails explicitly when it is missing.
- Accept: jest suites for moved modules green in their package; app suites for manager/CLI
  green; `pack:test` for the four packages (tarball install, ESM/CJS/tsc NodeNext, no `@/`);
  closure test proves `@cognia/agent-codex/history` and `/config` do not load runtime/process
  code; `build:packages` includes them.

### Phase 3 — all other external integrations

- `@cognia/agent-acp` with `AcpVendorProfile`; vendor branches out of `acp-client.ts`/manager into
  `@cognia/agent-ecosystems/<id>`; `agent-pi`, `agent-opencode`, `agent-claude-code`,
  `agent-aider`, `agent-a2a`; Devin adapter; portable history adapters; satellites (subagent,
  settings, commands, memory, plugin-convert) per ecosystem.
- Catalog generation: runtime rows + protocol capability rows authored in packages, aggregated
  into the existing `protocol/*.json` by a generator with `--check` wired into
  `audit:external-agent-runtimes` / `audit:agent-capabilities`; security policy untouched.
- Plugin ABI wrapper (§4.3) and Python proxy completeness.
- Accept: every matrix row has a package home; manager has no `instanceof` vendor classes;
  `lib/agent-ecosystem` derives from manifests (Goose included); CLI allowlist gated.

### Phase 4 — tools and engines

- §4.5 cuts; `@cognia/agent-tool-kernel`; sidecar `link:` + `node` condition; vendor gate;
  closure gate; offline ai-sdk suite with the Claude SDK uninstalled.

### Phase 5 — orchestration

- `@cognia/agent-orchestration`; ports §4.6; composition root registers team nodes; cycle-free
  import graph test; mixed built-in/external team test; process-level cancel never used as
  session cancel; recovery keeps lease/fencing/replay-safety; fixes for lease-renew result and
  `__team__:` resume filtering.

### Phase 6 — closure

- Docs (subsystem pages en/zh, package READMEs, CLAUDE.md map), gates in `check-all.mjs`, CI
  build matrix, final regression, changeset for user-visible fixes.

## 6. Test inventory and gaps

Existing: co-located suites for every runtime client (`acp-client.test.ts` etc.), manager
(`manager.test.ts`, `manager.instances.test.ts`), session-import adapters, team (109 suites),
workflow runtime, sidecar `node --test` suites, `packages/agent/scripts/pack-test.mjs`,
`scripts/plugin/test-sdk-package.mjs`, capability/runtime catalog gates.
Gaps to add: package pack/consumer tests; import-closure tests per entry point; plugin adapter
wrapper tests (missing members); DSH process-scope cancel through the manager; native-resume
instance persistence; ai-sdk rail without Claude SDK; team/workflow cycle test; lease-lost
abort; `__team__:` resume skip; mixed built-in + external squad.
