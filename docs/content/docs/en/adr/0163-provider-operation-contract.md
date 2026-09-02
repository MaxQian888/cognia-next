---
title: "0163: One provider operation contract, and the gateway stays inference-only"
description: "Every provider capability is one of fifty named operations in a single JSON contract, served by a registry that resolves provider, then protocol, then any. The gateway listener only ever accepts the stateless inference family. Management rides the CLI bridge, the headless RPC and the in-process executor through one dispatcher, and a management credential never reaches an agent subprocess."
---

# ADR 0163: One provider operation contract

**Status:** Accepted  
**Date:** 2026-09-02  
**Builds on:** [ADR-0025](./0025-unified-subscription-module), [ADR-0090](./0090-unified-agent-execution-and-gateway-compatibility), [ADR-0145](./0145-python-plugin-runtime-alignment)

## Context

Before this decision the provider surface was five things that did not know
about each other. The chat path resolved a provider through
`lib/ai/provider-consumption.ts` and called the AI SDK. The subscription
subsystem (ADR-0025) kept its own balance adapters and limits sources. The
settings UI asked a hand-written capability table which buttons to show. The
CLI had `/limits` and nothing else. The gateway listener served chat to Claude
Code and Codex and, because it was the one port an external agent already
knew, kept attracting proposals to also serve "list models", "read balance" and
"mint a ticket" on it.

Three defects made the drift visible. A route ticket could name a model the
gateway then failed to bind, so `cognia-agent x claude` launched against a
listener that answered 404. The token-count endpoint Claude Code calls on every
turn did not exist, so the agent's context gauge was blank. And `unknown` was
the answer for most operations on most providers, which told a user nothing
about whether an operation was unsupported, unconfigured or merely untried.

## Decision

### 1. One contract, fifty operations, named schemas

`protocol/provider-operations.json` is the contract. It carries one descriptor
per operation (id, group, kind, risk, idempotency, billing gate, scopes,
surfaces, remote exposure, PII gate, streaming, stateful-handle rule) and names
the zod schema for its input and output. The schemas live in
`packages/provider-types/src/provider-operation-schemas.ts` and are exported
from `@cognia/provider-types`. They ARE the wire: a handler types its input and
output as `z.infer` of the named schema, and a test parses every output with
it. A descriptor without a handler fails `pnpm provider-ops:check`, and a
handler for an id the contract does not know fails the same gate.

### 2. A registry that resolves provider, then protocol, then any

`lib/ai/operations/registry.ts` binds one operation id to one provider match.
Resolution scans provider-pinned registrations, then protocol-wide ones, then
`any`. There is no `switch (providerId)` anywhere in the dispatcher and the
vendor-neutrality gate (`check:provider-name-branches`) scans the directory for
vendor names. Vendor behaviour is a registration keyed by a provider id.
Protocol behaviour is a registration keyed by a wire protocol.

The executor (`lib/ai/operations/executor.ts`) owns what no handler may
re-decide: scope checks, the surface check (an operation whose descriptor
excludes `sidecar` refuses to run there), the PII gate for `outbound-text`
operations, and the failure taxonomy. A handler receives the resolved provider,
the settings snapshot and the validated request, and returns the output.

### 3. Support is `native`, `translated`, `derived`, `plugin`, or `unsupported` with a reason

`unknown` is not an honest terminal state for a built-in provider. The pure
capability matrix in `@cognia/provider-core` (`capability-matrix.ts`) answers
every operation for every built-in provider from vendor facts, and where a
vendor's job API is not shaped like the wire the host speaks, `HOST_GAPS`
records `unsupported` with the reason. `unknown` is reserved for a custom
deployment nothing has probed yet, and it carries the probe failure and a retry
condition. The gate asserts that no built-in provider has an `unknown` cell and
that every `unsupported` cell has a reason.

### 4. The gateway listener stays inference-only

The gateway listener (`crates/cognia-gateway`) accepts exactly the stateless
JSON inference family: chat, count-tokens, models, embeddings, responses. It
does not list balances, mint tickets, read capabilities, upload files, or serve
any operation that carries account state.

The reason is structural, not a matter of taste. The listener's port is handed
to Claude Code and Codex as their base URL, and an agent subprocess runs
arbitrary tool calls. Anything reachable on that port is reachable by the agent
and by anything that can read its environment. A management operation on that
port would be a privilege escalation from "may call the model" to "may read the
account". Route tickets therefore scope only the inference family, and an
operation outside it answers 403 on the listener regardless of credential.

This line is expected to be reopened whenever a new operation looks convenient
to serve there. The answer is the same each time: the listener is the agent's
port, and management does not belong on the agent's port.

### 5. Management rides the planes that already authenticate, through one dispatcher

Management operations have three legs and one dispatcher:

- **desktop bridge** (`src-tauri/src/cli_bridge`): `X-Cognia-Dev-Token`,
  loopback only, with an allowlist (`provider_admin.rs`) that every entry must
  prove is a low-risk read with no approval. The bridge serves the contract at
  `/api/dev/provider-operations/manifest` so a CLI can degrade per verb against
  an older desktop instead of failing.
- **headless** (`cognia-server`): `POST /internal/_rpc/{name}` with the
  service token.
- **in process**: the executor itself, which the CLI runs over its own config.

All three dispatch through `remote_execution::execute`. There is no second
dispatcher and no second allowlist. Neither gateway plane may fabricate a
synchronous result for an operation the host has not actually run.

### 6. A management credential never reaches an agent subprocess

The dev token and the service token are sent only to the plane that issued
them. `cognia-agent x` stamps a route ticket (inference-only, session-scoped)
into the agent's environment and nothing else. No verb forwards a management
credential to Claude or Codex, and the CLI's transport layer has no path that
could.

### 7. Stateful resources are provider-pinned, and there is no failover

Files, vector stores, batches, fine-tuning jobs, videos and realtime sessions
live inside one provider, one deployment, one account and one credential. A
`ProviderResourceHandle` records all four plus a credential fingerprint. Later
operations on the handle pin to all four and refuse a handle whose owner does
not match. Provider failover and key-pool failover are disabled for every
operation with a stateful handle, because the resource does not exist on the
other side.

### 8. The CLI and the TUI are the same modules

`cognia-agent provider <capabilities|models|balance|limits|usage|probe>` and
the TUI's `/provider …`, `/models` and `/balance` delegate to
`cli/src/provider/*`. Answers come from the first plane that is up (bridge,
then headless, then local), and every verb has a local path so the CLI never
needs a desktop to answer. Reads that bill the account require an explicit
`--live`, a probe additionally `--yes`, and live probes never run in CI.

### 9. Plugins contribute through one new point and three projected ones

`provider-operation-adapter` is the contract-native contribution point. A
plugin serves one operation for a provider, a protocol or everyone. The
registry binds the handler with `support: "plugin"` and
`via: "<pluginId>:<adapterId>"`, and drops it with the plugin. The three points
that predate the contract (`balance-adapter`, `limits-source`,
`protocol-adapter`) keep executing exactly as before and are projected into
the matrix as plugin cells, so a provider that gains a plugin balance adapter
shows `balance.read` as `plugin` without any change to the vendor facts.

### 10. Snapshots are per deployment and per account

Operation profiles and model inventories are cached in Dexie
(`providerOperationSnapshots`, schema v217) keyed by deployment and account,
because a key rotation or an organisation switch changes what a provider lists.
An inventory is reused only for the same account reference and only while its
TTL holds.

## Consequences

- Adding an operation means one descriptor, one named schema pair, one
  handler registration and one matrix answer per built-in provider. The gates
  refuse anything less.
- Adding a provider means vendor facts and, where its job APIs diverge from
  the wire, a `HOST_GAPS` entry with a reason. It never means a branch in the
  dispatcher.
- The listener's operation set is closed. Widening it is a new ADR, not a
  route.
- The CLI can answer capability questions offline, and its answers cannot
  differ from the panel's because they share the modules.
- Plugins see the same fifty ids the host does. A plugin cannot invent an
  operation the contract does not name.

## Gates

`pnpm provider-ops:check` (bidirectional descriptor and handler binding, no
`unknown` on built-ins, reasons on every `unsupported`),
`pnpm check:provider-name-branches`, `cargo test -p cognia-gateway`,
`lib/ai/operations/contract-parity.test.ts`, and the CLI suites under
`cli/src/provider` and `cli/src/tui/runtime/provider-controller.test.ts`.
