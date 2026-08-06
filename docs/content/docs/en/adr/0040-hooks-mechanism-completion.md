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

- Built-in lifecycle hooks no longer execute twice.
- Event and handler choices follow runtime evidence rather than provider-name assumptions.
- All five current Claude handler kinds execute through a bounded, audited path.
- User customization remains fail-open, while centrally managed policy is fail-closed.
- Outbound hook handlers cannot bypass the PII gate.
- External adapters keep their protocol-specific ingestion but converge on the same semantic decisions and trust rules.
- `webhook` remains compatible for existing settings, while all new configuration writes use `http`.

## Primary sources

- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Claude Agent SDK TypeScript](https://github.com/anthropics/claude-agent-sdk-typescript)
- [Codex advanced configuration: hooks](https://developers.openai.com/codex/config-advanced/#hooks)
- [OpenAI Codex](https://github.com/openai/codex)
- [OpenCode](https://github.com/anomalyco/opencode)
