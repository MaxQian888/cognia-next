---
title: ADR-0040 — Hooks mechanism completion
description: "Defines one capability-aware lifecycle Hook architecture for the Claude Agent SDK, Codex, OpenCode, and external agents, including native handler execution, failure policy, PII controls, recursion limits, and canonical audit events."
---

# ADR-0040 — Hooks mechanism completion

**Status:** Accepted (2026-06-01), amended (2026-08-06)
**Research record:** `docs/research/hooks-agent-fleet-gap-analysis-2026-08-06.md`

## Context

Cognia historically had two partially overlapping systems:

- in-process product/plugin hooks in TypeScript; and
- Claude-Code-style lifecycle hooks loaded from `settings.json`.

The lifecycle implementation was split again between a Rust compatibility runner, SDK events in the Node sidecar, and provider-specific external-agent bridges. That split produced duplicate execution for some built-in events, a static and incomplete event catalog, inconsistent handler support, and incomplete outbound-data and audit controls.

The 2026-08-06 review checked the pinned Claude Agent SDK `0.3.220`, local Codex `0.145.0`, and OpenCode SDK `1.17.13` against their primary upstream contracts. Claude exposes 31 hook events; the local Codex schema proves 11. Provider version strings alone do not prove which events or controls are usable at runtime.

## Decision

### One semantic core, one owner per runtime path

Every native event is normalized into Cognia's canonical hook envelope. Matching, decisions, policy, redaction, diagnostics, and audit use one semantic contract, but each runtime path has exactly one execution owner:

| Runtime path | Execution owner | Reason |
| --- | --- | --- |
| Built-in Claude Agent SDK | SDK-native hooks in the Node sidecar | The SDK supplies the complete event and decision contract; Rust must not pre-run the same event. |
| Rust compatibility/external bridge | Rust hook runtime reached through typed commands | External adapters already parse their provider protocol and reuse the shared settings/trust boundary. |
| Product/plugin hooks | Existing TypeScript dispatch | This remains a separate in-process extension API, not a second lifecycle-hook executor. |

The built-in `UserPromptSubmit` duplicate Rust pre-run is removed. Native SDK callbacks are the sole built-in lifecycle owner.

### Capability negotiation

A static provider manifest is a safety ceiling, never proof of runtime support. The effective capability set is the intersection of:

1. the audited Cognia event and handler catalog;
2. the installed runtime's probed schema or SDK surface; and
3. the selected runtime adapter's implemented controls.

The pinned Claude SDK catalog contains 31 events:

`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart`, `SessionEnd`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `PermissionRequest`, `PermissionDenied`, `Setup`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`, `Elicitation`, `ElicitationResult`, `ConfigChange`, `WorktreeCreate`, `WorktreeRemove`, `InstructionsLoaded`, `CwdChanged`, `FileChanged`, `DirectoryAdded`, and `MessageDisplay`.

Codex installation probes `codex app-server generate-json-schema` and intersects the discovered `HookEventName` enum with Cognia's audited 11-event ceiling. Probe failure degrades to no installable Codex events instead of guessing.

### Handler contract

The canonical handler kinds are:

- `command` — local subprocess with the event JSON on stdin;
- `http` — outbound HTTP POST; legacy `webhook` remains a read-compatible alias;
- `mcp_tool` — one declared MCP tool call;
- `prompt` — one model-backed hook evaluation;
- `agent` — a bounded model-backed agent task.

Settings UI choices are filtered by the effective runtime capabilities. Unsupported kinds remain visible only with an explicit reason; they are never silently accepted as working.

### Failure and security policy

User-authored hooks fail open on timeout, process failure, network failure, or unavailable native adapters, and emit visible diagnostics. Hooks with `policyClass: "managed"` fail closed for the same conditions.

Before any `http`, `webhook`, `mcp_tool`, `prompt`, or `agent` handler receives locally derived text, Cognia redacts the serialized payload and then applies a residual deep PII check. Remaining sensitive content blocks dispatch rather than crossing the outbound boundary.

Project/local hook settings still pass the Rust-enforced trusted-workspace gate. An untrusted or unsynchronized workspace loads user-scope hooks only.

### Model-backed handlers

Native handlers run through the pinned Claude Agent SDK adapter with:

- `<hook-origin depth="1" />` injected into the prompt;
- `settingSources: []` and no nested hooks, making recursive hook execution impossible by construction;
- bounded turns (`prompt`: 1, `mcp_tool`: 2, `agent`: 3);
- a shared hook budget governor (default USD 0.25 per execution context); and
- tool narrowing (`prompt`: none, `mcp_tool`: exactly the requested MCP tool).

A depth greater than or equal to one is rejected. Budget exhaustion blocks the handler instead of starting an unaccounted model turn.

### Canonical audit

Every matched handler emits a structured canonical hook audit event containing at least:

- hook id and event;
- provider and handler kind;
- policy class and outcome;
- latency;
- whether outbound data was redacted;
- block reason or warning.

The SDK canonical-event mapper persists this as a `kind: "hook"`, `phase: "completed"` event. Logs and UI notices are projections, not the audit authority.

## Consequences

- Settings.json hooks now fire across the built-in agent and all three external agents; PreToolUse can block tools on every path.
- Project/local hooks are usable but safely gated behind workspace trust, enforced in Rust.
- No Dexie schema change (the trust table already existed).
- Limitation: external-agent tools that auto-execute without a `permission_request` can only be observed (via `tool_use_start`), not blocked — a protocol boundary, documented rather than worked around.

## Addendum (2026-08-06) — versioned capabilities and execution ownership

The original injection model above is superseded for the built-in Claude Agent SDK rail. The
sidecar now owns SDK-native hook dispatch because it is the only layer that can preserve the
SDK's event-specific inputs, outputs, concurrency, and abort behavior. Rust remains the owner of
external-agent and compatibility command execution. An event occurrence has exactly one owner;
the Rust host must not pre-run `UserPromptSubmit` and then inject the same hook into the SDK.

Hook support is a versioned capability matrix, not one global event or handler list. The pinned
Claude Agent SDK surface is checked against its 31 public events. Codex and OpenCode adapters
publish only capabilities verified from their installed runtime/client. TypeScript, Rust, CLI,
Settings, and Fleet share event identities and parity gates while retaining provider-specific
matcher, timeout, concurrency, blocking, and output semantics.

Unsupported handlers and outputs are explicit diagnostics rather than silent no-ops. Legacy
`webhook` settings remain readable as Cognia's HTTP-handler compatibility form. Every outbound
HTTP/model/MCP path is subject to the shared PII gate, and persisted traces contain only
sanitized inputs, decisions, timing, and errors.

- Built-in lifecycle hooks no longer execute twice.
- Event and handler choices follow runtime evidence rather than provider-name assumptions.
- All five current Claude handler kinds execute through a bounded, audited path.
- User customization remains fail-open, while centrally managed policy is fail-closed.
- Outbound hook handlers cannot bypass the PII gate.
- External adapters keep their protocol-specific ingestion but converge on the same semantic decisions and trust rules.
- `webhook` remains compatible for existing settings, while all new configuration writes use `http`.

## Amendment — agent scoping, plugin contribution, and rail parity (2026-08-21)

This amendment extends ADR-0040 rather than superseding it. Five defects and one
missing capability drove it; the decisions below are the ones that stand.

### What was wrong

1. **No agent identity reached any hook.** `AgentHookContext.agentId` was declared but never sent:
   `fireAgentHook` omitted it, `run_agent_hook` had no parameter for it, and the CLI firer named the
   context `_ctx`. A teammate turn, a plan step, a connector auto-reply and a plain chat turn all
   produced indistinguishable payloads. The SDK's own `agent_type` / `agent_id` populate only inside
   SDK-Task subagents, so they could not carry a cognia identity.
2. **Plugins could not contribute a lifecycle hook.** No hooks plugin API, no hook registry, and
   `BUILTIN_HOOKS` was a hardcoded array.
3. **Three matcher implementations disagreed.** Sidecar and Rust used an unanchored regex; the CLI
   split on commas only and then anchored its fallback, so an author's `"^Notebook"` matched on the
   desktop and silently matched nothing on the CLI.
4. **The CLI never had SDK-native hooks at all.** `cli/src/runtime/protocol.ts` maps `claude_send`
   straight to sidecar stdin, bypassing the host-side injection in `src-tauri/src/claude/commands.rs`,
   and the CLI never injected `sendOptions.hooks` itself. Its only engine was the reduced
   `cli/src/tui/runtime/hook-runner.ts`, wired into the TUI alone and never parsing hook stdout — so
   the default-ON `auto-context-loader` silently did nothing there, and CLI subagents and headless
   runs were hook-blind.
5. **Eight handler fields were typed but unimplemented in every runner** — `args`, `if`,
   `statusMessage`, `once`, `async`, `asyncRewake`, `shell`, `allowedEnvVars`.

### Decisions

- **Agent identity is a closed enum plus a free reference.** `HookAgentKind`
  (`chat` / `teammate` / `subagent` / `goal-judge` / `plan-step` / `connector` / `scheduler` /
  `external` / `system`) reaches hooks as `agent_kind`, with `agent_ref` carrying the specific id.
  Closed so the `agents` selector has a domain the settings UI can enumerate and validate.
- **`HookGroup.agents` is a second, orthogonal selector.** `matcher` narrows by tool, `agents` by
  producer, and they are ANDed. It applies to every event, including the matcher-less ones. An
  absent selector matches everything, so every pre-existing config is untouched; a **present**
  selector never matches an unidentified turn, which is the fail-safe direction for a guard.
  This is a cognia extension to a file real Claude Code also reads, where the unknown key is ignored
  and the group therefore runs unconditionally. The settings UI states that inline.
- **Matcher semantics canonicalize on the sidecar**, because that is the rail the built-in agent
  runs on and what users' existing Claude Code settings were written against. `hooks/matcher-conformance.json`
  is asserted by all three runners' suites, so a future divergence fails on the rail that drifted.
- **The CLI injects rather than reimplements.** It resolves its merged config once
  (`cli/src/hooks/resolve-hooks-config.ts`) and injects it into `sendOptions.hooks`, so a CLI turn
  runs the real SDK-native engine — including subagents and headless runs. `hook-runner.ts` stands
  down whenever there is a group to inject, derived from the same read so the two cannot disagree.
- **Plugins contribute through a `{ type: "plugin", pluginId, hookId }` handler.**
  `host_rpc` is NOT the transport: `answer_host_rpc` is deliberately terminal, answered in Rust and
  never forwarded to the renderer, dispatching only `jobs.*` and the agent-session-store methods.
  That is also why the plugin `onPreCompact` hook had been dead since it was written — it called a
  `preCompact` method that was never registered. The bridge instead mirrors the `plugin_tool_exec`
  round-trip: the sidecar emits `plugin_hook_exec`, Rust's default branch forwards it on
  `SIDECAR_EVENT`, the renderer answers, and `claude_plugin_hook_response` writes back to stdin.
  `onPreCompact` now rides the same channel and works.
- **Two independent gates on that handler.** Writing it into `settings.json` is the user's
  authorization; the plugin's declared `hooks:chat-intercept` capability is the plugin's — required
  only when bound to an event whose decision can deny a turn (`PreToolUse`, `UserPromptSubmit`).
  Everything else fails OPEN: absent plugin, disabled plugin, missing hook, refused permission,
  timeout and throw all resolve to a warning, never a block.
- **One plugin hook registry.** `lib/plugin/registries/hook-registry.ts` replaces the class-private
  Map plus Zustand pair, which were written together but read apart with two different liveness
  rules — so a disabled plugin kept receiving half its hooks. Enablement is read from the plugin
  store rather than mirrored, because a cached copy is how the two drifted.
- **Fire-point coverage is finished where it was a genuine omission, and labelled where it is not.**
  `lib/agent/plan/turn-driver.ts` gained the firer seam its sibling goal driver already had (a
  blocking hook PAUSES the plan rather than failing it); teammate dispatch and cognia-dispatched
  subagents now carry identity, and the latter synthesize `SubagentStart`/`SubagentStop` the SDK
  only emits for its own Task subagents. Desktop-pet proactive messages, Attention Radar and the
  text-only `runCompletionRail` fallback are NOT covered — they use a renderer-side `LlmClient` and
  would need a fourth rail — and the Hooks settings panel says so.
- **The capability tables tell the truth.** `prompt` / `agent` / `mcp_tool` ARE executable on the
  sidecar (`hook-native-executor.mjs`, cost-governed, recursion depth 1) and were reported as
  unsupported long after that shipped; the CLI's own runner really is command-only.
- **The eight unimplemented handler fields are labelled, not implemented** — typed as dormant,
  surfaced in the handler form when a config actually carries one, and pinned by a test that greps
  the runners so a future implementation forces the list to change.
- **`hook_audit` lands in traces.** The sidecar had emitted an audit per matched handler all along
  and the adapter dropped it, so "why didn't my hook fire?" had no answer anywhere. It now emits a
  span on the existing `/logs` → Traces surface. This matters more now that a group can miss for two
  different reasons.
- **The two `BUILTIN_HOOKS` registries are pinned together.** `hooks/builtin-hooks.lockstep.json` is
  asserted by both the TS and Rust suites; because `builtinHookOverrides` is keyed by id, a drifted
  id also orphaned a user's enable/disable choice on one shell.

## Primary sources

- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Claude Agent SDK TypeScript](https://github.com/anthropics/claude-agent-sdk-typescript)
- [Codex advanced configuration: hooks](https://developers.openai.com/codex/config-advanced/#hooks)
- [OpenAI Codex](https://github.com/openai/codex)
- [OpenCode](https://github.com/anomalyco/opencode)
