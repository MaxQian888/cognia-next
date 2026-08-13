---
title: ADR-0114 — Unified chat message presentation
description: Presets, session overrides, honest run metadata, progressive disclosure, and host-owned message chrome.
---

# ADR-0114 — Unified chat message presentation

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-08-12 |
| Builds on | ADR-0057 — Chat rendering completeness |

## Context

ADR-0057 made rich chat parts complete, but presentation policy remained distributed across the message renderer, the standalone agent-flow setting, mobile actions, and transcript surfaces. Assistant identity, model provenance, timing, usage, actions, and technical parts therefore had inconsistent visibility. Historical messages could also be mislabeled if a renderer inferred their model from the session's current selection.

## Decision

### One resolved presentation contract

Global settings store `MessageDisplayPreferences`; a `ChatSession` may add `messageDisplayOverride`. `resolveMessageDisplayOptions` is the only precedence boundary and produces the complete renderer contract. Its presets are `focused`, `balanced`, and `inspector`; `balanced` is the default. Legacy `agentFlowMode` remains a read fallback for old settings, while new writes go through the unified preference.

The preference is classified as shared settings. Ordinary branches, SDK forks, desktop, Web, and Capacitor therefore retain the same presentation unless a session explicitly resets to inheritance.

### Host-owned shell, extension-owned bodies

`MessageShell` owns layout, semantic identity/time, live or completed status, available runtime details, and footer placement. Existing renderers continue to own Markdown, reasoning, tools, sources, files, artifacts, A2UI, subagents, diagnostics, and plugin bodies. Plugins keep part, tool, and extension slots but cannot replace the host's complete message chrome.

`focused` minimizes technical detail, `balanced` uses automatic disclosure, and `inspector` expands the available trace. Errors, approvals, diagnostics, unknown parts, attachments, artifacts, and security-relevant state remain reachable under every preset. Unknown raw parts are recursively redacted and capped before display.

### Honest immutable run metadata

New assistant turns may persist `metadata.run` with the actual resolved `providerId`, `modelId`, `startedAt`, `completedAt`, `durationMs`, and reported `finishReason`. Built-in, external-agent, and team paths stamp only values known at generation time. Existing `metadata.usage` remains the source for token, cache, and cost metrics.

Old or imported messages are not rewritten, and missing fields are omitted. Renderers never fall back to the session's current model for historical attribution.

### Shared commands and stable rendering

`resolveMessageActionCommands` supplies one capability and safety model to desktop controls, keyboard/overflow menus, and the mobile long-press sheet. Copy and More are stable in the default preset; edit and retry stay directly reachable when available; destructive actions retain confirmation.

Motion uses `motion/react` and is limited to structured block entrance, status, menus, and disclosure. Global or OS reduced-motion overrides message preferences. Streaming and finalized Markdown share geometry and policy, and the streaming caret occupies zero layout width. Virtualized transcripts invalidate row measurements when resolved presentation changes without repinning a reader who has scrolled away from the bottom.

## Persistence and compatibility

The settings and session fields are optional JSON properties, and run data stays inside the existing message metadata blob. No Dexie schema or historical rewrite is required. Session branches copy the optional override; sessions without one continue inheriting global settings.

## Consequences

- Message information density is predictable and configurable without forking rich-part renderers.
- Historical provenance remains truthful, at the cost of leaving unavailable legacy fields blank.
- New presentation options must be added to the resolver and its tests before renderers consume them.
- Plugins remain compatible but cannot take ownership of the whole message shell.
