---
title: "0090 — Unified Agent Execution and Gateway Compatibility"
description: "Unifies Agent runtime selection, Anthropic-compatible deployment routing, headless hosting, heterogeneous delegation, and recovery without replacing existing execution engines."
---

# ADR 0090 — Unified Agent Execution and Gateway Compatibility

- **Status:** Accepted
- **Date:** 2026-07-23
- **Builds on:** ADR-0022, ADR-0028, ADR-0043, ADR-0059, ADR-0062, ADR-0064, and ADR-0082
- **Research record:** `docs/research/agent-sdk-gateway-non-claude-models-2026-07-23.md`

## Context

Cognia currently has three real Agent runtime rails:

1. the Claude Agent SDK rail in the Node sidecar;
2. the provider-neutral AI SDK tool-loop rail in that same sidecar;
3. the external-Agent rail behind one `ExternalAgentManager`, with ACP, Codex app-server,
   OpenCode, and A2A protocol adapters.

Chat, plugins, workflows, and Agent Teams are callers or orchestrators. Gateway versus direct is a
route decision. Native subagents versus Cognia-orchestrated children are delegation modes.
Desktop, headless, and remote are hosts. None of those dimensions creates another runtime rail.
The `executeAgent` text channel is a completion fallback without tools, not a fourth Agent runtime.

The implementation exposes this simpler reality poorly. Sidecar dispatch selects Claude Agent SDK
only when the provider id is literally `anthropic`; otherwise it selects AI SDK. `claude-host.mjs`
hosts both engines but exposes Claude-specific commands. Agent execution policy is distributed
across caller-specific configuration. Some callers silently degrade to text completion when the
desktop sidecar is unavailable. The built-in Gateway has an Anthropic `/v1/messages` surface and
cross-protocol translation, but it is started only by the Tauri application, consumes a
renderer-produced routing snapshot, and does not implement the complete evolving Claude Code
gateway contract.

Several providers expose Anthropic-wire endpoints. GLM and Kimi are examples, not special cases.
Protocol similarity alone does not establish Claude Agent SDK compatibility: streaming details,
tool-call fragmentation, error envelopes, beta headers, session behavior, prompt caching,
thinking blocks, and future Claude Code fields may differ. Anthropic also explicitly does not
support routing Claude Code to non-Claude models through a gateway. Cognia therefore needs its own
versioned compatibility contract rather than presenting third-party endpoints as officially
supported Claude deployments.

Headless Cognia already owns a `HeadlessSidecarHost` and external-process control plane, but it
does not instantiate the built-in LLM Gateway. Agent Teams already have durable Workflow
orchestration, permission cascade, budgets, recovery, and delegation controls. A new solution must
deepen those modules instead of creating a second headless Gateway, Team engine, permission bus,
budget governor, or session format.

## Decision

### 1. One logical execution service, three runtime adapter families

Cognia will expose one logical `AgentExecutionService`.

```text
Chat / Plugin / Workflow / Team
                |
                v
      AgentExecutionService
                |
       resolveAgentExecutionSpec()
                |
     +----------+-----------+
     |                      |
 Agent Host          ExternalAgentManager
     |                      |
 +---+----+        ACP / Codex / OpenCode / A2A
 |        |
Claude   AI SDK
Agent SDK tool loop
```

The runtime adapter families remain:

- `ClaudeAgentSdkRuntimeAdapter`;
- `AiSdkRuntimeAdapter`;
- the existing external protocol adapters behind `ExternalAgentManager`.

There are two physical services, not one process:

- a generic Node `agent-host.mjs` containing the Claude Agent SDK and AI SDK adapters;
- the existing external-Agent manager and its process/transport boundary.

External agents will be reachable through the logical service, but will not be forced into the
Node sidecar. `agent_send` and `agent://message` become the canonical command and event names.
Existing `claude_*` commands and `claude://message` remain compatibility aliases during migration.

### 2. Resolve and freeze every Agent session

`AgentExecutionPolicy` lives in `@cognia/agent-config-types`. It includes, at minimum:

- `runtimePolicy`: `auto`, `claude-agent-sdk`, or `ai-sdk`;
- `routePolicy`: `gateway-required`, `gateway-preferred`, or `direct`;
- deployment/model binding, credential profile reference, and credential-affinity policy;
- execution target: `colocate`, `auto`, or `pinned`;
- required and preferred capabilities;
- explicit fallback policy;
- Team delegation and depth constraints where applicable.

One `resolveAgentExecutionSpec()` intersects hard policy constraints and then applies preferences.
It produces an immutable `ResolvedAgentExecutionSpec` for one session. The spec pins the runtime
adapter, deployment, model bindings, route, host, compatibility evidence, capability projection,
credential lease reference, and execution fingerprint. A session never silently changes route or
host mid-run.

Desktop defaults to `gateway-preferred`. Headless and managed deployments default to
`gateway-required`; administrators may lock this. A preferred route may fall back to direct only
when the Gateway fails before contacting an upstream. Policy rejection, quota rejection, upstream
errors, or any response bytes forbid a direct replay.

`auto` chooses Claude Agent SDK only for a native, vendor-certified, or Cognia-verified execution
path. A generic compatible endpoint stays on AI SDK. Users may explicitly request an experimental
Claude Agent SDK path, but the UI and trace must identify it as experimental.

### 3. Separate provider, deployment, transport, and compatibility

The versioned Provider Profile Store becomes the source of truth:

- `ProviderProfile` represents the vendor or account;
- `DeploymentProfile` represents an endpoint, protocol, region, credential reference, and model
  inventory;
- `TransportProfile` represents wire behavior: protocol, base URL, authentication scheme,
  permitted static/semantic headers, and model bindings;
- `AgentRuntimeCompatibility` represents evidence for a specific execution path.

This replaces overloaded provider ids such as `zhipu` plus `glm-anthropic`, `moonshot` plus
`kimi-anthropic`, and similar relay presets. Existing ids remain legacy deployment aliases during
migration. No runtime or Gateway branch may hard-code GLM, Kimi, MiniMax, OpenRouter, or any other
provider name.

Transport profiles are data-driven. Supported authentication shapes include `x-api-key`, bearer,
and allowlisted custom headers. Reserved, hop-by-hop, browser-forwarded, and internal `x-cognia-*`
headers cannot be supplied by a profile. Secrets remain in the platform Secret Store and are
referenced by id; they never appear in a resolved spec, event log, export, or trace.

Desktop persists non-secret profiles through existing settings/Dexie projections and secrets
through the OS keyring. Headless uses the existing SQLite/AppStore boundary plus an encrypted
secret store. CLI, admin/service RPC, and declarative import manage headless profiles. Environment,
mounted-secret, or stdin values are bootstrap inputs, not the long-term authority.

### 4. Compatibility is a matrix and a certification artifact

`anthropic` protocol, `anthropic-native`, and Claude Agent SDK compatibility are orthogonal.
Compatibility is scoped by:

```text
runtime + ingress protocol + route mode + translation mode + deployment + model
        + Agent SDK version + Claude Code version + Gateway version + suite version
```

Evidence levels are `native`, `vendor-certified`, `cognia-verified`, `experimental`, and
`unsupported`. Capability levels are `core`, `extended`, and `full`, backed by explicit fields for
streaming, ordinary and parallel tools, fragmented JSON, tool results/errors, MCP, permission
interruption/resume, multi-turn and session resume, prompt caching, thinking, context management,
images, beta features, rate limits, upstream errors, and stream interruption.

The effective capability set is the intersection of model metadata, runtime, Gateway/transport,
host/platform, compatibility evidence, permissions, and available resources. Unknown hard
requirements are unsupported. Tasks declare `requires` and `prefers`; an unsupported requirement
fails before spending a model turn. Optional unsupported features are disabled before the request
and recorded in the trace.

A connectivity probe proves only that an endpoint is callable. It never upgrades compatibility.
An explicit, billable Agent Core smoke test may produce local evidence. Official/CI certification
runs the complete suite and produces a signed manifest. Cross-protocol Claude Agent SDK routing is
eligible for `auto` only when the complete execution path, including Gateway translation, is
certified.

The bundled `@anthropic-ai/claude-agent-sdk` is pinned exactly. Any Agent SDK, embedded Claude Code,
Gateway, or suite-version change makes matching compatibility evidence stale and requires
recertification. The previous certified artifact remains available for rollback.

### 5. The Gateway is the preferred security and routing boundary

The built-in `cognia-gateway` crate is deepened into a host-neutral service. A `GatewayHost`
boundary supplies events, settings, secret resolution, and persistence:

- Tauri uses Tauri events, settings, and keyring;
- headless uses EventBus, SQLite/AppStore, and the encrypted secret store.

`GatewayState` becomes part of `HeadlessServices` and is started by `cognia-server`. Desktop and
headless consume the same provider-profile projection and the same Gateway implementation. The
Gateway can keep serving its last valid snapshot without a renderer; routing authority no longer
depends on an open window.

Agent sessions use an explicit, ephemeral `GatewayRouteTicket`. The Agent Host resolves the
execution spec and asks the Gateway to mint a ticket whose secret is supplied to Claude Code as
the local Gateway credential. The ticket binds:

- route pin id and execution fingerprint;
- frozen ordered deployment/model candidates;
- allowed model aliases and role bindings;
- session lineage, route policy, and expiry;
- credential-affinity and failover constraints.

The Gateway bypasses live alias rerouting for a ticket. It may move only within the ticket's frozen
candidate list and only before response bytes. Native subagents inherit the parent ticket.
Cognia-orchestrated child sessions receive their own ticket. Ticket secrets are never persisted;
recovery reissues a ticket for the same frozen spec or pauses/fails.

Model roles `primary`, `fast`, and `powerful` map inbound Claude selectors such as `sonnet`,
`haiku`, and `opus` to concrete deployment models. A deployment may map every role to the same
model. Bindings are frozen per session, and an unmapped selector fails. Ordinary Chat and AI SDK
traffic may continue using dynamic global aliases.

Agent credential affinity defaults to `sticky-with-failover`; completion traffic may remain
per-request. An Agent session keeps one credential lease and moves to another preauthorized
credential only for an allowed transient failure, then remains sticky. Account failover after
401/403 is off unless explicitly allowed. Revocation invalidates affected tickets and leases.

For same-protocol traffic, the Gateway is security-mediated semantic transparency: it preserves
safe Anthropic version/beta/semantic headers, compatible response headers, SSE byte order, status,
and upstream error bodies while replacing authentication and stripping hop-by-hop, browser, and
internal headers. Cross-protocol traffic uses the canonical IR and reports every semantic loss.
Gateway-generated errors are reserved for Gateway rejection, exhausted candidates, and
translation failures.

### 6. The Agent Host is generic and environment-safe

`claude-host.mjs` evolves into `agent-host.mjs`; desktop and headless use the same host supervisor.
Both built-in runtime adapters accept the same resolved spec and emit the same canonical events.

Per-query environment construction uses a clean allowlisted base environment required for
subprocess operation, then overlays resolved session variables. It explicitly removes inherited
provider routing and authentication variables before applying the route. The current
`{ ...process.env, ...sendOptions.env }` behavior is not sufficient because credentials can bleed
between sessions; passing only `sendOptions.env` is also incorrect because Agent SDK 0.3.183 treats
the map as the complete Claude Code subprocess environment.

Gateway routes inject only the local Gateway endpoint and ticket. Upstream secrets remain in the
Gateway. Direct routes resolve a credential reference ephemerally on the execution host. Native
subagents inherit the parent environment and ticket; orchestrated children get independently
resolved sessions.

### 7. Native subagents and heterogeneous Teams are distinct

Claude Agent SDK native `AgentDefinition` can vary model, tools, and prompt, but cannot provide an
independent provider, base URL, credential, route, runtime, or host. Therefore:

- same runtime, same Gateway ticket, and only a model-role change: native subagent is preferred;
- different provider/deployment, credential, route, runtime, host, or hard capability:
  Cognia creates an orchestrated child Agent session.

Team members select an execution target through `inherit`, a pinned profile, or an approved pool.
The coordinator selects candidate ids, never raw URLs, headers, or keys. Precedence is member
pinned/pool, Team-run policy, Team default, then application default; only an explicit
administrator force-all policy overrides this.

Nested Teams reuse the existing `delegation-orchestrator`. Parent and child keep separate durable
boards and exchange a serializable `HandoffEnvelope`. `maxTeamDelegationDepth` is configurable and
defaults to 2: root depth 0, child depth 1, grandchild depth 2, with no further delegation. It is
separate from native `subagentDepth`.

The Team lead is colocated with the workspace owner by default. Headless Cognia is a local
execution host. Native subagents always remain on the same host. An orchestrated child may cross
hosts only when its handoff is serializable, workspace/resources have stable references, the
target satisfies runtime/tool/sandbox/credential policy, and ADR-0082's remote-host rules permit
it. Credentials stay host-local. Side-effecting work never moves silently during recovery.

### 8. Reuse the existing authorities for permissions, budgets, retry, and recovery

The existing permission cascade remains authoritative. Effective permission is the intersection
of Team policy, parent ceiling, child request, and runtime capability. Unknown permissions fail
closed. The Agent Host is the tool-permission authority; the Gateway is not. A headless run with
no interactive approver denies a request unless predeclared policy authorizes it.

The Team budget guard is extracted/reused as the single `RunBudgetGovernor` for a Team/run. It
limits total executions, concurrency, fan-out, and spend across the identity hierarchy. Duplicate
plugin budget accounting is migrated or removed. Gateway tenant/API-key quota and usage accounting
remain transport-level limits. Every failed attempt counts.

There is no silent external-Agent-to-built-in fallback. The Gateway owns only request-internal,
pre-byte candidate failover. A runtime adapter owns its handshake and transport recovery.
Workflow/Team owns task retry and reassignment. Unknown or irreversible side effects forbid
automatic replay.

Recovery reuses the existing Workflow event log, checkpoints, leases, and idempotency. Zustand is
only a UI projection. Desktop Dexie and headless persistence implement the same port. Approvals are
never reconstructed as approved.

Recovery inputs may include Cognia's canonical log, runtime artifacts, checkpoints, and imported
sessions. Cognia uses canonical hub-and-spoke codecs, extending the existing session-import
registry, rather than N-by-N converters. Conversion fidelity is `native-exact`, `structured`,
`contextual`, `summary-only`, or `unsupported`, with an explicit loss report. Runtime artifacts
may rebuild a missing/corrupt canonical store; canonical history may materialize a new runtime
session when the target runtime supports it. Cognia will not fabricate private Claude JSONL when
the SDK offers no supported import API.

`RecoveryPlanner` proceeds automatically only when one candidate provably dominates. Tool or
side-effect conflicts always pause. Last-modified-wins is forbidden. Headless recovery enters
`recovery_required` or fails according to policy.

### 9. One event envelope, handle, and identity hierarchy

The canonical event contract deepens the existing `CaptureStreamEvent`; it does not create a
parallel stream. Every event carries an envelope containing event id, sequence, session, run,
turn, attempt, parent, host, runtime, and timestamp. Event kinds cover lifecycle, messages,
thinking, tools, permission, subagent, usage, compaction, checkpoint, warning, and failure.
Claude Agent SDK, AI SDK, and external adapters map their native events into it. Raw runtime events
are diagnostic attachments only.

Workflow persists the envelope with at-least-once delivery and idempotent consumers.
`AgentExecutionHandle` exposes ids, resolved spec, events, send, cancel, interrupt,
`resolvePermission`, and capability-gated `steer`, `setModel`, `setPermissionMode`, and checkpoint.
Commands have idempotency ids. `setModel` may select only a frozen ticket binding; unsupported
operations return a typed capability error.

Identity is:

```text
session -> run -> turn -> attempt -> providerAttempt
```

A Gateway pre-byte candidate switch creates a new `providerAttempt`. Host resume creates a new
attempt for the same run/turn. Team reassignment creates a new child run. A native subagent is a
canonical child run with its SDK id stored only as `runtimeBinding`.

### 10. Completion fallback becomes explicit

An Agent request whose hard capabilities cannot be satisfied fails closed by default.
`toolsEnabled: false` means an intentional completion. Degradation occurs only when
`fallbackPolicy: "completion"` is explicit, and the result includes `degradedReason`. Headless and
managed defaults prohibit completion fallback.

Legacy configuration migrates as follows:

| Legacy state | Migrated meaning |
| --- | --- |
| `toolsEnabled: false` | `executionKind: "completion"` |
| `toolsEnabled: true`, `requireTools: true` | Agent requires tools; no fallback |
| `toolsEnabled: true`, `requireTools` missing/false | Explicit completion fallback with `legacyMigrated: true` |
| New Agent configuration | No fallback unless explicitly selected |

Managed policy may override legacy compatibility. Old `runtime: "claude"`, `proxyMode`, provider
relay ids, and `claude_set_*` calls remain read/command adapters only; all new writers use the new
schema.

## First delivery slice

The first vertical slice proves an arbitrary custom Anthropic-protocol deployment through the
built-in Gateway into Claude Agent SDK on both desktop and headless:

- explicit `runtimePolicy: "claude-agent-sdk"`;
- explicit `routePolicy: "gateway-required"`;
- experimental opt-in until certification permits `auto`;
- no provider-name hard-coding;
- Gateway unavailability is an explicit failure, never a direct fallback.

Acceptance covers real SSE, ordinary and parallel tools, fragmented tool JSON, tool results and
errors, MCP, permission interruption/resume, multi-turn, native subagent model bindings, sticky
credentials, restart/recovery, and secret-free tracing. CI uses a deterministic Anthropic
conformance server. Real-provider certification is an optional, explicitly billable job.
Heterogeneous Teams and cross-protocol auto-selection follow only after this slice is stable.

## Consequences

- Cognia gains one understandable Agent execution contract without discarding working engines.
- Anthropic-compatible providers can use Claude Agent SDK when explicitly requested and verified,
  while AI SDK remains the production-neutral path.
- Desktop and headless share the same Agent Host and Gateway semantics.
- Team members may use different models, deployments, runtimes, credentials, and hosts when
  Cognia orchestration is used; native subagents intentionally cannot.
- Route, host, model bindings, compatibility evidence, and credential affinity are inspectable and
  stable for a session.
- The design adds contract and migration work across TypeScript, Node, and Rust. Certification
  must be maintained as SDK and Gateway versions evolve.

## Rejected alternatives

- **Send every model through Claude Agent SDK.** This makes a private, evolving Claude Code
  contract the provider-neutral runtime and contradicts Anthropic's support boundary.
- **Treat every Anthropic-wire endpoint as compatible.** A protocol label does not prove Agent
  semantics.
- **Create a separate headless Gateway.** It would duplicate security, routing, translation, and
  quota logic.
- **Move external agents into the Node sidecar.** Their process and protocol boundary already has
  a shared manager and headless transport.
- **Implement heterogeneous Teams with native Agent SDK subagents.** Native definitions cannot
  carry independent provider, route, credential, runtime, or host state.
- **Allow silent text completion or runtime fallback.** It hides lost tools and can replay
  side effects under different semantics.
- **Convert recovery formats pairwise.** N-by-N conversion is unmaintainable and obscures loss.
- **Let the Gateway choose from live global aliases during an Agent session.** It breaks session
  reproducibility, credential affinity, and recovery.

## Security and operational requirements

- No upstream secret, ticket secret, or raw credential is persisted or emitted.
- Profile custom headers are allowlisted; reserved and internal headers are rejected.
- Every route, capability, credential-lease, fallback, and recovery decision is auditable.
- Gateway tickets are scoped, expiring, revocable, and bound to the frozen execution spec.
- Permission decisions remain fail-closed and approvals never survive as implicit authorization.
- Compatibility and certification records include exact runtime and Gateway versions.

## Addendum (2026-07-24) — implementation record

Phases 0–8 landed on `dev` (contracts → profiles → gateway → agent host →
conformance → certification → caller migration → teams → recovery). This
addendum records the operational facts the plan required to be written down.

### Conformance suite location

`tests/conformance/` (top-level, plain `node:test`): the deterministic
Anthropic-protocol server (`anthropic-server/`), scenario matrix, harness
(real `cognia-server` binary + real sidecar), and cases. Run with
`pnpm test:conformance` after `pnpm conformance:prepare`. Certification
bundles emit from the same suite (`--emit-manifest`); rollback via
`scripts/certify/rollback-bundle.mjs` restores the previous bundle pointer
and reports installed-artifact version mismatches that must move with it.
The contextual-materialization path has its own end-to-end case
(`cases/session-materialize.test.mjs`, byte-pinned against the codec's
replay prompt via a shared fixture), and crashed agent runs reconcile at
bootstrap through the recovery planner
(`lib/ai/agent/recovery/reconcile-crashed-runs.ts` — park or
`recovery_required`, never a replay).

### R1 spike verdict (frozen)

`sidecar/dispatch/session-materialize.spike.live.test.mjs`, run against the
real SDK: no public create-from-external-messages API exists; a foreign-id
resume never silently succeeds as that id; no private JSONL is forged. The
claude-code codec's `materialize` fidelity is therefore **contextual**
(replay prompt). The spike is an SDK-upgrade tripwire — if a materialize API
appears, its surface assertion fails and the verdict must be revisited.

### Retirement schedule (Phase 9)

Every legacy-path deletion is telemetry-gated and ships as its own commit
with a flag escape. Observation counters: sidecar `legacy_dispatch`
(spec-less sends), Rust `DeprecatedCommandCounters` /
`agent_command_telemetry` (`claude_*` alias calls), and the
`agent.execution.resolved` event volume.

| Step | Precondition (observation window) | Action |
| --- | --- | --- |
| 1 | `agentExecutionResolverV2` default-on for one full release AND `legacy_dispatch` = 0 across desktop + headless for 14 consecutive days | Delete the provider-id branch in `sidecar/dispatch/index.mjs`; spec-less sends fail with `LegacyDispatchRemovedError` |
| 2 | Release cadence decision after step 1 | Shrink `claude-host.mjs` to a ≤30-line name-adapter wrapper; verify bundle resources via tauri-smoke (the COPY trap) |
| 3 | `claude_*` alias counters = 0 for 14 consecutive days | Three-stage `claude_set_*` retirement: forward+count → dev-error → delete (+ ACL/registration updates), tauri-smoke each stage |
| 4 | Step 1 complete | Remove duplicate writers: executeAgent's flag-off legacy branch, relay provider creation paths (readers stay, documented LTS); renderer snapshot publisher becomes control-plane only (closes R3) |

Until step 1's precondition holds, the flag-off legacy paths are the
production fleet and MUST keep byte-identical behavior (pinned by the
per-caller parity tests added in Phase 6).

### Long-lived gates

`check:provider-name-branches` (greps runtime code for provider-name
special-casing), `check:runtime-versions` (stale-detection version pins), the
suite-manifest hash pin, and the colocated-test audit all run in `check:all`.
