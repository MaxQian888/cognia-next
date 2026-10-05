---
title: "0216 — Each external-agent configuration keeps its own state"
description: "Several configurations of one external runtime used to share its home folder, its login, the globally active subscription account and, after a restart, none of their own keyring secrets. A configuration now carries stateIsolation (absent = shared, so existing configurations keep their logins; every new configuration and every duplicate is isolated). An isolated configuration launches with a per-configuration state root that the spawn backends map onto the runtime's home variables and fence in the sandbox. Every route into the manager runs one launch preparer that resolves the configuration's own secrets, state root and bound account. Duplicating is a dialog, session limits and approval lists are enforced, and plugins get ctx.externalAgents with read and manage permissions."
---

# ADR 0216 — Each external-agent configuration keeps its own state

**Status:** Accepted (implemented)
**Date:** 2026-10-05
**Amends:** [ADR-0090](./0090-unified-agent-execution-and-gateway-compatibility) (the manager prepares every launch), [ADR-0119](./0119-pi-native-rpc-integration) (Pi honours the configured approval lists)
**Related:** [ADR-0025](./0025-unified-subscription-module) (subscription accounts), [ADR-0145](./0145-python-plugin-runtime-alignment) (Python contributions), [ADR-0182](./0182-a-project-names-the-image-it-runs-in) (sandbox placement), [ADR-0199](./0199-an-agent-variant-follows-its-base) (variants of Cognia's own agents, a different mechanism)

## Context

The External Agents page lets a user keep several configurations of one runtime: a
read-only Codex next to a workspace-write one, or one CLI on two accounts. An audit
on 2026-10-05 found that the configurations were not actually separate:

- **Secrets after a restart.** Keyring secrets reached a launch only through
  `ExternalAgentLifecycleService.register()`. Startup rehydration, `lifecycle.connect`
  and the Connect button passed the scrubbed store config, so after a restart every
  configuration ran without its own credentials.
- **One home folder.** Every configuration of a runtime used the runtime's state home
  (`~/.codex`, `~/.claude*`, `~/.qwen`, `~/.pi` …): one login, one config file, one
  MCP list, one session history, and refresh-token races between them. Setting
  `CODEX_HOME` by hand was undone by the sandbox's writable roots.
- **One account.** Codex environment injection always used the globally active
  subscription account.
- **One Python adapter object** for every configuration a plugin adapter served.
- **Sessions across configurations.** Imported-session resume picked any
  configuration of the runtime.
- **Host configurations** launched without resolving their secrets, deleted inline
  secrets and accepted credential refs that named another configuration.
- **Duplicate** copied the state-folder environment, a fixed OpenCode port and a
  plaintext server password, auto-connected the copy, kept no lineage, produced
  "(copy) (copy)" and dropped the session limits.
- **Preset binding** preferred whichever duplicate happened to be connected, and
  local↔host pairing fell back to matching names.
- **Logout** signed the shared CLI account out of every sibling without saying so.
- **Declared but dormant:** `autoApprovePatterns`, `requireApprovalFor` and
  `maxConcurrentSessions` were stored and never enforced.
- **No plugin API** could read or manage configurations.

## Decision

### Configuration fields

`ExternalAgentConfig` (`types/agent/external-agent.ts`) gains:

| Field | Meaning |
| --- | --- |
| `stateIsolation?: "shared" \| "isolated"` | Absent means `shared`: every configuration saved before this change keeps its behaviour and its logins. The create normalizer and the duplicate builder default to `isolated`. |
| `subscriptionAccountId?: string \| null` | Codex family. Launch as this account instead of the active one. `null` on update clears. |
| `duplicatedFromAgentId?: string` | Lineage, written only by duplicate. The UI shows it while the source exists. |
| `maxConcurrentSessions?: number` | Absent means unlimited. Settable, `null` on update clears. |
| `sessionIdleTimeout?: number` | Settable, `null` on update clears. |

### The state root

`protocol/external-agent-security-policy.json` gains `agentStateIsolation.rules`: per
runtime, which home variables to set (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`,
`QWEN_HOME` …), which shared roots exist and which to deny reading. Supported:
codex, claude, qwen, pi, kimi, cline, qoder, copilot, opencode. A runtime without a
rule (gemini, goose, devin, kiro, droid, cursor, aider, dsh) cannot be isolated: an
isolated configuration on it is blocked with `state_isolation_unsupported`, and the
UI offers only the shared state for it.

The TypeScript side (`lib/ai/agent/external/lifecycle/launch-preparation.ts`) sets
`COGNIA_AGENT_STATE_KEY=<configId>` and removes any env key the rule owns. Each spawn
backend — Rust `crates/cognia-external-agent/src/state_isolation.rs` and the CLI's
`cli/src/runtime/external/state-isolation.ts` — validates the key
(`^[A-Za-z0-9_-]{1,128}$`), resolves `<data_dir>/cognia/external-agents/<key>` from
the host environment, creates it `0700`, maps the rule's variables into it, removes
the key from the child environment, and under a sandbox makes the root writable,
drops the shared roots from the writable set and denies reading them. On Linux the
launcher re-opens a state root that falls under a shadowed secret store
(`crates/cognia-exec-sandbox/src/launcher.rs`). Deleting a configuration removes its
root (`external_agent_state_root_remove`); the inspector shows the path and size
(`external_agent_state_root_info`).

Gateway-task and bot-isolated launches keep their own isolation and are not given a
second root.

### One launch preparer

`ExternalAgentManager.addAgent` runs every configuration through one preparer before
anything else: resolve keyring secrets by `credentialRefs` (now including the
`serverPassword` slot), apply the state root, and for a bound Codex account read that
account's environment (`subscription_get_account_env`), refreshing it if stale
without making it the active account. Every route into the manager therefore launches
with the configuration's own credentials. A preparation failure refuses the
registration.

### Instances in the runtime

- **Session limit.** Opening a session past `maxConcurrentSessions` closes the least
  recently active idle session; if every session is mid-turn the request is refused
  with `session_limit_reached`.
- **Approval lists** are enforced with the `allowedTools` syntax against a request's
  title, tool name and kind: in the ACP client, the Codex app-server client (plan mode
  still declines), Pi (a static overlay plus dynamic approval) and the manager's
  event stream for OpenCode and plugin adapters. "Ask" wins over a bypass mode.
- **Preset binding** orders by enabled, then creation time, then id. Pairing a local
  configuration with a host record by name happens only when the name is unique on
  both sides and the host record carries no provenance.
- **Imported-session resume** excludes isolated configurations (their history is not
  the runtime's) and lets the user choose when several shared ones qualify.
- **Python adapters.** The contribution envelope gains a fifth element, the
  instance id. A class-decorated contribution gets one instance per configuration;
  `__release__` drops it.

### Duplicate

`externalAgentDuplicateInput` copies settings, session limits and the bound account,
records lineage, defaults to `isolated`, keeps the source's enabled state but never
connects the copy, and strips the env keys the isolation rule owns, `metadata.port`
and `metadata.serverPassword`. Secrets are copied into the copy's own keyring slots,
so deleting either never breaks the other. Names are unique ("X (copy)",
"X (copy 2)" …). The desktop and the phone ask for the name, the state and the
enabled switch in a dialog first. The Host offers the same through
`external_agent_config_duplicate`.

### Host configurations

Host-side configurations keep secrets in keyring slots under their own id, launch
with only their own refs, reject foreign refs, accept `null` to clear limits, and
clear their slots and state root on delete.

### Management surfaces

Desktop settings group the rail by status or by runtime, show what sets each
configuration apart (state, permission, model, account, directory, arguments,
sandbox, session limit, approvals), and push list → detail in a narrow pane. The
inspector edits name, description and enablement inline and has a "This
configuration" section with the state choice, folder, session limit, siblings and
what it shares. The editor is a Dialog on desktop and a Drawer on a phone, waits
for the save and stays open on failure. Mobile `/me/external-agents` gains a detail
screen per Host configuration. The chat-side manager warns that logging out affects
the configurations that share state, and links to Settings.

### Plugin API

`ctx.externalAgents` (TypeScript and Python, desktop):

- `agent:external:read`: `list`, `get`, `getReadiness`, `listPresets`,
  `listRuntimes`, `getSettings`, `listDelegationRules`, `onChange` (Python: the
  `onExternalAgentConfigChange` hook).
- `agent:external:manage` (dangerous): `create`, `createFromPreset`, `update`,
  `duplicate`, `remove`, `setEnabled`, `connect`, `disconnect`, the delegation-rule
  writes and `updateSettings`.

Projections never carry a secret, env, headers or keyring refs. Inputs with inline
credentials are refused; credentials and unsandboxed consent stay in the host UI.
Writes go through the lifecycle service and record `metadata.createdByPluginId`.

`runExternalAgent` refuses when the master switch is off or the target is disabled or
not ready, clamps the requested permission mode to the configuration's default (the
global default for a preset's temporary instance) and removes that temporary
instance after the run. `dispatchSubagent` aimed at an external agent also requires
`agent:dispatch-external`.

## Consequences

- An isolated configuration starts signed out of its runtime; the duplicate dialog,
  the editor and the inspector say so before the change is made.
- Existing configurations change nothing until the user switches them to their own
  state.
- A runtime gains isolation by adding a rule to the policy file; the gate
  `scripts/gates/check-agent-capabilities.mjs` keeps the rule table and both spawn
  backends in step.
- Bumping the security policy version would invalidate unsandboxed consents, so this
  change did not bump it.

## Verification

- `lib/ai/agent/external/lifecycle/launch-preparation.test.ts`,
  `lib/ai/agent/external/manager.instances.test.ts`,
  `lib/ai/agent/external/lifecycle/service.test.ts`,
  `lib/ai/agent/external/config/{duplicate-config,instance-family,agent-binding,env-builder,host-config-service}.test.ts`
- `crates/cognia-external-agent/src/state_isolation.rs` (in-file tests),
  `cli/src/runtime/external/state-isolation.test.ts`
- `lib/plugin/api/external-agents-api.test.ts`,
  `lib/plugin/messaging/external-agent-config-hook-source.test.ts`,
  `plugin-sdk/python/tests/test_contributions.py`
- `components/settings/agent/*.test.tsx`, `components/mobile/external-agents/*.test.tsx`
