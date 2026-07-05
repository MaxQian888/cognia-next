---
title: ADR-0064 — External-CLI-backed subagent dispatch completion (Claude Code / Codex / …)
description: "Complete the half-built feature where the main agent dispatches subagents backed by external CLI agents (Claude Code, Codex, Gemini, Cursor, …). Fix broken ACP launch commands so the named agents actually spawn, stop silent wrong-engine degradation, thread MCP servers + live progress into the external path on both dispatch surfaces (Agent Team teammates A1 and Task-tool subagents A2), prefer the native Codex app-server, and add a first-class Settings authoring UI for external subagents."
---

# ADR-0064 — External-CLI-backed subagent dispatch completion

**Status**: Accepted (2026-07-06)
**Authors**: Max Qian + Claude Opus 4.8
**Builds on**: ADR-0022 (Agent Team runtime + the `dispatchTeammate` primitive), ADR-0032 (Agent Team plugin integration; subagent capability), ADR-0048/0049/0051 (external-agent subsystem: ACP / Codex app-server / OpenCode adapters, process hardening, plugin adapter type).

## Context

Two dispatch surfaces already let the main agent run a subagent on an external
CLI agent, and both were committed but only ~90% finished:

- **A1 — Agent Team teammates.** `lib/ai/agent/team/dispatch-teammate.ts` forks a
  `TeammateChannel = "sidecar" | "text" | "external"`; a non-`claude`
  `teammate.config.runtime` (or an `externalAgentPresetIds` capability) routes to
  `runExternalBacked()` → `ExternalAgentManager.execute()`.
- **A2 — the main chat agent's Task-tool subagents.** `AgentDefinition.externalPresetId`
  → `lib/plugin/agent-sdk/dispatch.ts:runExternalSubagent()` → the same manager.

The whole execution plane underneath (the manager, the four protocol adapters,
the hardened Rust process layer, presets/ecosystem surfaces, the permission
cascade) is production-grade and was reused unchanged. A full-chain review found
concrete gaps that this ADR closes without omission.

## Decisions

### 1 · Correct the ACP launch commands (the headline fix)

`ecosystem-adapters.ts` shipped launch commands that could never spawn the named
agents — verified against current ACP docs:

- **Claude Code** ran `npx @anthropics/claude-code --stdio` (nonexistent package,
  no native ACP entry). Claude Code speaks ACP only through the official Zed
  adapter: `npx -y @zed-industries/claude-code-acp`.
- **Gemini CLI** passed `--stdio`, which drops it into interactive mode and hangs;
  the ACP entry flag is `--experimental-acp`.
- **Cursor CLI** ran a bare `cursor-agent` with no ACP subcommand; the ACP server
  starts via `cursor-agent acp`.

Codex (`@zed-industries/codex-acp` shim and native `codex app-server`) were already
correct. All executable-preset commands are now locked in a parametrized test.

### 2 · Never degrade to the wrong engine silently

An external-backed teammate whose CLI can't be reached (browser/mobile shell, or
the CLI isn't installed) previously fell through to the built-in engine with no
signal — a "Codex teammate" silently became a Claude teammate. `dispatchTeammate`
now emits a `warn` "External runtime unavailable" notification before the
fallback; `runExternalSubagent` (A2) fails loudly with an actionable error rather
than an opaque spawn failure.

### 3 · Thread MCP servers + live streaming into the external path

Both external dispatch functions previously forwarded only
systemPrompt/permission/cwd/signal. They now also:

- **Forward MCP servers.** New `resolve-acp-mcp-servers.ts` maps a teammate's
  resolved MCP-server ids to `AcpMcpServerConfig[]` (stdio → command/args/env;
  http/sse → url/headers), passed via the execution context the manager already
  reads. Conservative by design — only the ids explicitly granted to the teammate
  are forwarded; the external CLI keeps its own MCP config regardless.
- **Stream live progress.** New `external-event-progress.ts` translates
  `ExternalAgentEvent` → `CaptureStreamEvent`, so an external teammate/subagent
  lights up the same activity panel / `SubagentPart` progress a built-in one does,
  instead of showing only start/terminal markers.

Model selection is intentionally **not** forced onto the external CLI: Claude Code
/ Codex own their model + auth via their own subscription, so pushing a Cognia
model id would be wrong. The Settings UI states this ("the external agent uses its
own model and auth").

### 4 · Prefer the native Codex app-server

A teammate with runtime `"codex"` now upgrades to the first-party
`codex app-server` when the `codex` CLI is installed (via the existing
`resolvePreferredCodexExecutablePresetId` probe), falling back to the ACP shim —
matching the external-agent gallery's quick-add.

### 5 · First-class authoring for external subagents (A2)

The main agent could dispatch an external subagent, but there was no first-class
way to *create* one (only markdown frontmatter / plugin SDK). `SubAgentConfig`
gains `externalPresetId`; `projectSubagentTemplate` carries it onto the
dispatchable `AgentDefinition`; the subagent template editor gains an "External
runtime" selector listing every executable preset (bilingual, desktop-only hint).
A shared `BUILTIN_EXECUTABLE_PRESET_IDS` (derived from `EXTERNAL_AGENT_PRESETS`,
no drift) is the single source for external-runtime pickers.

## Out of scope (tracked follow-ups)

- **Widen the `TeammateRuntime` union to every executable preset.** The teammate
  runtime dropdown still lists 5 of the 12 executable CLIs; the other 7 are
  reachable via the `externalAgentPresetIds` capability but not the dropdown.
  Widening the union is a standalone change: it ripples through an entire
  runtime-availability + streaming subsystem keyed on `TeammateRuntime`
  (`lib/agent-team/use-runtime-availability.ts`'s exhaustive
  `Record<TeammateRuntime,…>`, `runtime-streamers.ts`, `runtime-targets.ts`,
  `team-runtime-dispatcher.ts`, `components/agent/workspace/members.tsx`), several
  of which were concurrently in flight. Deferred to avoid breaking those exhaustive
  maps mid-refactor.
- **Auto-compose proposing external runtimes.** The auto-orchestration composer
  never assigns an external `runtime`; external teammates arrive only via the
  capability overlay. Adding a validated `runtime` to `ProposedTeammate` +
  materialization + the roster editor is a bounded follow-up.
- **MCP forwarding for A2 subagent defs.** `PluginSubagentDef` carries no MCP-id
  list, so A2 external subagents rely on the external CLI's own MCP config.

## Consequences

- The external agents the feature advertises — Claude Code and Codex above all —
  actually launch, stream, and carry the team's MCP tools, or fail loudly when
  they can't.
- The external path stays a thin routing layer over the reused, hardened manager;
  no execution-plane duplication was introduced.
- The `runtime`/`externalPresetId` seams and the shared preset list leave the
  deferred union-widening and auto-compose work as additive changes.

## Verification

Jest: 207 tests across the 9 touched suites green (ecosystem-adapters,
external-event-progress, resolve-acp-mcp-servers, presets, agent-sdk/dispatch,
dispatch-teammate, resolve-external-backing, subagents, subagent-templates-tab).
`tsc --noEmit`: zero errors in any changed file. i18n key parity 0/0 (en + zh-CN,
aggregates rebuilt). Delivered as five independently-revertible commits.
