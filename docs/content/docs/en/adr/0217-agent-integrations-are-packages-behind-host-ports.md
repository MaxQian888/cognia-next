---
title: "0217 — Agent integrations are packages behind host ports"
description: "External-agent integrations, the shared adapter contract and the runtime building blocks move out of app-private code into workspace packages that build, test and install on their own. The contract splits a required adapter core from named optional capabilities, adds execution semantics (what a cancel reaches, how a session resumes or forks, where approvals are decided, how processes map to sessions), and replaces vendor class checks with typed adapter extensions. Integrations reach the machine only through host ports (process plane, launch environment, approval policy, a required outbound PII gate, logger), so declaring a capability never grants it. History readers return a neutral transcript that the host maps into its own rows, and native resume returns to the configuration it last ran on."
---

# ADR 0217 — Agent integrations are packages behind host ports

**Status:** Accepted (in progress: contracts, runtime kit, DeepSeek Harness and Codex landed; the remaining integrations, the engines and orchestration follow the phases below)
**Date:** 2026-10-05
**Amends:** [ADR-0090](./0090-unified-agent-execution-and-gateway-compatibility) (the adapter contract and the canonical event contract move to `@cognia/agent-contracts`), [ADR-0062](./0062-external-agent-session-import) (a runtime's session-store reader lives in its integration package and returns a neutral transcript), [ADR-0216](./0216-each-agent-configuration-keeps-its-own-state) (native resume records and returns to its configuration), [ADR-0051](./0051-external-agent-adapter-plugin-type) (plugin adapters are read against the new core)
**Related:** [ADR-0068](./0068-frontend-package-extraction-and-compile-speed) (package extraction rules), [ADR-0107](./0107-coding-agent-migration) (migration readers stay in the migration subsystem), [ADR-0142](./0142-agent-sdk-two-layer-product), [ADR-0169](./0169-one-runtime-one-review-one-control-machine), [ADR-0197](./0197-the-sidecar-runs-its-typescript-unbuilt)

## Context

Every external-agent integration lived in `lib/ai/agent/external/`, next to the manager
that runs them, and imported the app freely: Tauri invoke wrappers, the logger, the PII
gate, the task-workspace store. A second host could not reuse one. The CLI got its own
copies by swapping modules at bundle time (`scripts/build/cli-external-agent-aliases.mjs`).

The adapter contract (`ProtocolAdapter`) had grown to about 90 members, most optional.
The manager called some of them unconditionally (`forgetSessions`, `getSessions`,
`cancel`, `healthCheck`), which a plugin adapter is not required to provide. It also
reached vendor controls with `instanceof CodexAppServerAdapter`.

Boolean capability flags could not express what actually differs between runtimes:

- **DeepSeek Harness** has no wire cancel. Stopping a turn retires the session's own
  process, so the session must be reopened. The manager kept the dead session cached,
  and the next turn went to a runtime that no longer existed.
- **Codex app-server** cancels one turn on a shared process and resumes natively.
- **Aider** can only replay the host's transcript, which is not native resume.

The identity of an agent was spread over several vocabularies:

- **Ecosystem** (`lib/agent-ecosystem`).
- **Runtime** (`protocol/external-agent-runtimes.json`).
- **Preset.**
- **Protocol.**
- **Configuration instance.**

Native resume matched on the recorded preset alone. That hid every other runtime that
reads the same session store, and it never remembered which configuration (and so which
account) a session had been resumed on.

## Decision

### Package layers

```
@cognia/agent-contracts      types and tiny pure helpers; runtime dependency: none
        ▲                    (the ACP SDK is a type-only dependency, pinned exactly)
@cognia/agent-runtime-kit    BaseProtocolAdapter, JSON-RPC peer, LF frame decoder,
        ▲                    spawn reclaim, content blocks, history builders
@cognia/agent-<integration>  ./manifest, ./<runtime client>, ./history when the runtime
                             has its own session store
        ▲
host (app, CLI, headless)    registers integrations, implements the ports, owns policy,
                             PII, sandbox, persistence and the mapping into its own rows
```

Rules:

1. A package never imports `@/…`, React, Tauri, Dexie or zustand. Each package's
   `tsconfig.json` lists only the packages it may depend on in `paths`, so a stray `@/`
   import fails to compile.
2. Integration packages depend on contracts and the runtime kit, never on each other.
3. `./manifest` and `./history` entries load no runtime, process or transport module. The
   pack test proves this through the CommonJS module cache of an installed tarball.
4. Every package is `private`, AGPL-3.0-only, dist-only (`types` / `import` / `require` /
   `default`), and passes `pnpm agent:packages:pack-test`. That test packs the package and
   every `@cognia` dependency, installs them from tarballs outside the workspace, loads
   every entry through ESM and CJS, runs a smoke program and typechecks a strict NodeNext
   consumer.

### Identity

Integrations reuse the existing identity sources; nothing new is registered:

- **Ecosystem:** `lib/agent-ecosystem` stays the identity table. An integration package
  exports its own row (`codexManifest.ecosystem`, `deepseekHarnessManifest.ecosystem`), and
  the catalog lists those rows instead of copying them.
- **Runtime:** `protocol/external-agent-runtimes.json` stays the gated catalog of runtimes
  and presets.
- **Protocol:** read from the configuration or preset, never from the runtime row.
- **Configuration instance:** `ExternalAgentConfig.id`.

### Adapter core and optional capabilities

`ExternalAgentAdapterCore` holds the members every host may call. Everything else is a
named optional capability with a guard:

- `supportsSessionRegistry`
- `supportsResume`
- `supportsFork`
- `supportsTurnSteering`
- `supportsSessionModels`
- `supportsModelCatalog`
- `supportsAuthentication`
- `supportsCompaction`
- `supportsSessionListing`

`ProtocolAdapter` remains `core & optional capabilities`, so every existing implementation
still type-checks. The manager now calls optional members through their guard or optional
chaining (`adapter.forgetSessions?.()`).

`missingAdapterCoreMethods(adapter)` reports what a plugin adapter lacks, for the plugin
compatibility wrapper.

### Execution semantics

Each runtime declares `semantics: AgentExecutionSemantics`:

| Field | Values |
| --- | --- |
| `cancel.scope` | `turn`, `session`, `process` |
| `cancel.reconnectsAfterCancel` | whether the session needs reopening |
| `resume` | `native`, `relaunch-with-session`, `history-replay`, `unsupported` |
| `fork` | `native`, `native-turn-boundary`, `before-entry`, `unsupported` |
| `approvals` | `per-tool-call`, `profile-fixed`, `none` |
| `processModel` | `shared`, `per-session`, `per-turn`, `remote` |

An adapter that declares nothing reads as the conservative
`UNDECLARED_EXECUTION_SEMANTICS`: a cancel may take the process down and needs a reconnect,
nothing resumes or forks, and approvals are asked.

DeepSeek Harness declares a process-scoped cancel on a per-session process. Codex
app-server declares a turn-scoped cancel on a shared process, native resume, and fork at a
turn boundary.

The manager drops a session from its cache when its cancel requires a reconnect and the
adapter no longer reports the session. The next turn therefore opens a fresh session.

### Typed vendor extensions

An integration that exposes vendor controls defines an extension, for example
`defineAdapterExtension<CodexAppServerAdapter>("codex.app-server", resolve)`. Hosts read
it with `manager.getAdapterExtension(agentId, codexAppServerExtension)`, which replaces
`getCodexAppServerAdapter` and the manager's `instanceof` check.

Extension ids are namespaced (`vendor.feature`).

### Host ports

Integrations reach the machine only through ports defined in contracts:

| Port | What the host provides |
| --- | --- |
| `AgentProcessHost` | spawn, write, bounded kill, and host-wide stdout (line or raw), stderr and exit subscriptions |
| `AgentLaunchEnvironmentResolver` | the configuration's own credentials, state root and bound account (ADR-0216), injected right before spawn |
| `AgentApprovalPolicy` | what the configuration's approval lists say about one request |
| `AgentOutboundGate` | the host's PII gate; **required**, called on every prompt or payload an integration sends |
| `AgentLogger` | structured logging; the host bounds entry size |

The desktop app implements the process plane over its existing transport. That transport
is the companion or Tauri bridge with `spawn_external_agent`, `send_to_external_agent`,
`kill_external_agent` and `external-agent://stdout|stdout-raw|stderr|exit`. The app passes
`hasNoLeakingPiiDeep` as the outbound gate.

**Declaring a need grants nothing.** The host still applies the spawn allowlist, sandbox,
placement, permission guard and audit, and registering an integration does not authorize
what its manifest declares.

### History readers and the neutral transcript

When a runtime keeps its own session store, its package exports a pure reader under
`./history`. The reader turns file content into `ParsedHistorySession`:

- **Transcript:** neutral `HistoryPart`s (text, reasoning, file, commentary, tool with its
  recorded result), plus per-turn usage and namespaced annotations.
- **Canonical state:** goals, plans, tasks, compaction and rollback history, inter-agent
  messages and recorded canonical events.
- **Losses:** an explicit loss list of what the reader dropped or approximated.

Readers never read the filesystem, never build host rows and never store anything. A
reader keeps bounded diagnostics of records it cannot map, and every string in them passes
through the host's redactor (`HistoryReaderHost.redactText`, required).

The app owns three things: discovery (roots, budgets, the corpus cache), the one mapping
into `StoredMessage` (`lib/session-import/history-to-stored.ts`, which calls `to-parts`),
and the session graph.

The canonical event and canonical session contracts moved to `@cognia/agent-contracts`
because integrations emit them. `@cognia/agent-config-types` re-exports both unchanged.

Migration readers stay in the migration subsystem (ADR-0107): settings, commands,
subagents and memory. They translate a vendor's files into Cognia's own settings
vocabulary across many vendors, including vendors Cognia cannot launch.

### Native resume binds its configuration

An imported session records the preset that wrote it:

- **Candidates:** native resume treats every preset of that preset's ecosystem as a
  candidate (`presetIdsSharingEcosystem`). Codex's ACP adapter and its app-server read the
  same `~/.codex/sessions` thread.
- **Recorded configuration:** a verified resume records `runtimeBinding.agentConfigId`.
- **Return to it:** a later resume goes back to that configuration.
- **Offline refusal:** when the configuration still exists but is offline, resume answers
  `bound-runtime-unavailable` and offers the connected alternatives. It never moves the
  session to another account silently.

ADR-0216's isolation rule still applies: an isolated configuration cannot see the
runtime's home and is never a candidate.

### Compatibility

- **Old import paths:** each becomes a re-export of its new home:
  - `types/agent/external-agent.ts`
  - `types/agent/external-agent-lifecycle.ts`
  - `lib/agent-ecosystem/types.ts`
  - `lib/ai/agent/external/protocol-adapter.ts`
  - `@cognia/agent-config-types/{agent-execution,canonical-session,ref-safety,external-agent-capability}`
- **Stored data:** configurations, sessions and imported bindings are unchanged.
  `agentConfigId` is optional, and a binding without it resolves as before.
- **Plugin adapters** still register through the existing overlay.

## Implementation status

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Baseline, identity model, migration matrix (`docs/plans/2026-10-05-agent-package-architecture.md`) | Done |
| 2 | `agent-contracts`, `agent-runtime-kit`, `agent-dsh`, `agent-codex` (runtime + history); DSH cancel semantics; native-resume binding | Done |
| 3 | ACP and the remaining integrations, the plugin compatibility wrapper, catalog rows from manifests, CLI port injection | Planned |
| 4 | Neutral tool kernel; the AI SDK engine builds and tests without the Claude SDK | Planned |
| 5 | Orchestration package behind store/journal/executor ports; the Team↔Workflow import cycle broken by a composition root | Planned |
| 6 | Docs, gates, CI and final regression | Planned |

## Consequences

- **Reuse:** a host gets an integration by implementing five ports. The DSH and Codex
  adapters no longer import the app.
- **Contract enforcement:** the integration packages are type-checked and pack-tested in
  isolation. A contract change that breaks an installed consumer fails
  `agent:packages:pack-test`, not a later app build. That test already caught two real
  problems. First, an ACP SDK range that resolved to a release missing types the contract
  uses, now pinned exactly. Second, `@cognia/redact` is not installable as an artifact,
  which is why the PII gate is a required host port.
- **Shipping:** upgrading an integration package does not by itself change native
  behavior. The host still ships the process plane, the security policy and the sandbox.
- **Runtime catalog:** stays the one gated source of runtime and preset rows. Generating
  those rows from manifests is Phase 3 work and keeps the existing gate.
