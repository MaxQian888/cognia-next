---
title: "0203 — External Bridge workspace, git and shell tools"
description: "Local MCP clients get bounded dev-machine primitives over the loopback External Bridge: file listing/reading/searching/writing, git reads and supervised shell jobs over workspace roots granted per client, plus a model-facing result vocabulary (pending/continuation, decision-complete failures, clamped inputs, job attention) and tool-owned audit projections. Studied from WebCodex; nothing vendored."
---

# ADR 0203 — External Bridge workspace, git and shell tools

**Status:** Accepted
**Date:** 2026-09-29
**Related:** [ADR-0008](./0008-external-bridge) (External Bridge; its remote-exposure deferral stands), [ADR-0062](./0062-external-agent-session-import) (external-agent observation), [ADR-0155](./0155-plugins-reach-the-host-through-one-door) (one host door), [ADR-0196](./0196-a-library-crate-links-tauri-only-when-asked), [ADR-0201](./0201-the-desktop-browser-runs-chromium-locally) (same envelope split for `browser_*`)

## Context

The roadmap `docs/plans/2026-09-29-webcodex-evaluation-and-bridge-roadmap.md`
studied WebCodex (a Rust MCP runner exposing a dev machine to cloud chat
clients) and concluded its value for Cognia is protocol discipline, not
topology. Re-verifying the roadmap against the code changed several of its
premises:

- The host `fs_*_workspace` commands confine a path to the root they are
  given, but trust any absolute root from the local renderer. "Thin
  registrations" over them would have exposed every directory on disk.
- `SENSITIVE_FILE_NAMES` (`crates/cognia-files`) only hides credentials from
  `fs_walk_workspace`. Reads, listings and content search return `.env` files.
- The feared pgid-reuse window in `cognia-jobs` does not exist: group signals
  are only sent while the leader is unreaped, from the task that owns it.
- The renderer could only spawn jobs owned by a scheduled task.
- The audit log never stored arguments, so "never raw params" already held;
  a per-tool projection adds information rather than removing any.
- The roadmap's hook-fed "external-agent observation" duplicates ADR-0062,
  which already imports and live-watches Claude Code, Codex and a dozen other
  agents' session histories.

## Decision

### Four default-OFF scopes, one family of sixteen tools

| Scope | Tools |
| --- | --- |
| `workspace:read` | `workspace_roots`, `workspace_list`, `workspace_read`, `workspace_search` |
| `workspace:write` | `workspace_write`, `workspace_edit`, `workspace_move`, `workspace_delete` |
| `git:read` | `git_status`, `git_diff`, `git_log`, `git_show` |
| `shell:run` | `shell_run`, `job_output`, `job_list`, `job_kill` |

The roadmap's separate `jobs:run` scope is folded into `shell:run`: every
command runs as a supervised job, so starting one and reading or stopping it
are one grant. There is no git write tool.

Execution reuses host surfaces only: `lib/files/workspace-fs`, `lib/git/commands`
+ `readWorkspaceDiff`, and the `cognia-jobs` supervisor through
`lib/jobs/background-jobs`. The renderer core is
`lib/external-bridge/handlers/workspace.ts`; the MCP sidecar forwards
`workspace_tool` over the existing orchestration proxy, exactly like
`browser_tool`.

### Roots are granted per client, by id

`ExternalBridgeSettings.workspaceGrants` maps a bridge caller (`mcp:stdio`, or
`mcp:<clientId>` for an HTTP credential) to `WorkspaceRoot.id`s. Tools take a
root id and a root-relative path; absolute paths, drive/UNC prefixes and `..`
are refused, never repaired. No grant means no roots, whatever the scopes. The
grant picker is Settings → External Bridge → Workspace access.

### Two-tier path policy

`lib/external-bridge/workspace/path-policy.ts` builds on the shared
`isSensitiveResourcePath` and adds the credential names and stores the Rust and
sidecar predicates hold, plus `.git` internals:

- **secret** — refused on every tool, including listings, search hits, git
  statuses and diffs;
- **bulk** (`node_modules`, `target`, … — the `SNAPSHOT_SKIP_DIRS` set) —
  skipped in scans, readable by name.

A read of a symlink is refused (its target would escape classification). A
shell command naming a secret-tier path is escalated to in-app approval; that
is a tripwire, not a sandbox, and the `shell:run` description says commands run
with the user's own permissions.

### Consent and outbound gate

`classifyCommand` `deny` refuses; `ask`, or a secret-naming command, asks the
user in-app on every call through the consent broker (grants cleared before and
after, so "always allow" never carries over). Every delete asks the same way.
File content, match lines, diffs, commit text and job output are PII-redacted
and the result must then pass `hasNoLeakingPiiDeep`. A write or edit whose text
carries a redaction placeholder is refused, so a redacted read can never be
written back over the real text. Author e-mail is dropped from git logs.

### Model-facing result vocabulary (`lib/external-bridge/tool-result.ts`)

- **Pending/continuation** — work that outlives its wait budget answers
  `executionState: "pending"` and the exact `continuation` call.
- **Decision-complete failure** — the existing `code`, plus `failureStage`,
  `stateChanged`, `outcomeUnknown` (handler threw mid-flight) and at most one
  `followUp` whose `mechanicallyFollowable` says whether it may be issued
  verbatim. `runWithGate` now answers scope denials (`scope_denied`) and handler
  exceptions (`handler_error`, outcome unknown) in this shape for every tool.
- **Turn economy** — ergonomic inputs (byte budgets, waits, page sizes) are
  clamped and reported under `adjusted`; identity inputs fail closed.
- **Passive attention** — `jobs://exited` is routed by owner session to the
  client that started the job and piggybacks, byte-capped and delivered once,
  on that client's next workspace-family result.

`structuredContent` carries only these control fields; workspace data travels
in the `<untrusted_content>`-fenced text block (the ADR-0201 split).

### Tool-owned audit projection

`runWithGate` accepts an `audit` projection declared by the tool (root id and
path, or only a command's head). `auditProjection` keeps at most eight bounded
scalars; anything unprojectable records nothing. It is stored on
`McpAuditLogRow.projection` and shown in the audit panel's row detail.

### Jobs owned by a client

`background_job_spawn_bridge` (desktop-local, `client.local`) spawns under the
owner session `external-bridge:jobs:<client>`; the id charset is validated in
Rust so it cannot impersonate a chat session. `background_job_wait` exposes the
existing `jobs.wait` long-poll. The per-session job cap bounds each client.

### Plugin alignment

`plugin_tool_invoke` now also requires the bridge scope matching each
workspace-class manifest permission (`filesystem:read` → `workspace:read`,
`filesystem:write` → `workspace:write`, `shell:execute` / `process:spawn` /
`tests:run` / `python:execute` / `notebook:execute` → `shell:run`). The MCP
server stamps the caller's effective scopes; the renderer checks them against
the plugin manifest.

## Rejected

- Vendoring `webcodex-runner` / `webcodex-server`, running them via
  `externalBin`, or a plugin-owned listener (roadmap "Explicitly rejected").
- A hook-fed `record_external_observation` tool: ADR-0062 live session import
  already observes external agents from their own histories.
- Remote reachability over the relay (roadmap Phase 3): `bind_mode = "relay"`
  stays refused until ADR-0008's remote-exposure decision is reopened with a
  relay identity design.
- A global trusted/restricted authority switch: per-scope, per-root and
  per-call consent is finer.

## Consequences

- A local MCP client can do real file, git and command work in the roots the
  user granted it, and nowhere else.
- `shell:run` is the strongest grant the bridge has; its Settings copy says so.
- Deliberately left open: finished jobs are never dropped from the job
  supervisor's in-memory map. That leak predates this ADR and is tracked
  separately.
