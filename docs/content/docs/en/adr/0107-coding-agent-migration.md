---
title: ADR-0107 — Unified coding-agent migration
description: "Composes Claude Code, Codex, and OpenCode settings, sessions, skills, subagents, MCP servers, commands, and memory into one previewable migration flow."
---

# ADR-0107 — Unified coding-agent migration

**Status**: Accepted (2026-08-03)

## Context

Cognia already had independent import paths for agent sessions, MCP configuration, subagents, skills, and external memory. Users nevertheless had to discover and run each path separately, while settings and command prompts had no complete import path. Vendor roots also need to respect `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and the OpenCode XDG roots.

## Decision

`lib/agent-migration/` is a pure orchestration layer. It probes installed Claude Code, Codex, and OpenCode installations, delegates preview and apply operations to each existing subsystem, and exposes one cancellable, progress-reporting migration plan. It owns no persistence and creates no parallel data model.

The supported artifact matrix is settings, sessions, skills, subagents, MCP servers, commands, and memory. Each preview cell is explicitly `ready`, `shared`, `empty`, `unsupported`, or `error`; lossy or unmappable source settings remain visible as warnings instead of being silently dropped. Conflict handling uses the existing `skip`, `overwrite`, and `duplicate` vocabulary.

Claude Code hooks and slash commands are marked **shared**, not imported: Cognia intentionally reads and writes the same `~/.claude/settings.json` hooks block and `.claude/commands/` tree. Codex and OpenCode commands are translated into that canonical command store. The environment-aware vendor-root resolver is shared across session, skill, command, memory, and migration discovery.

The wizard is additive. Existing focused import dialogs remain available and authoritative for their domains.

## Consequences

- A user can inspect all available artifacts before Cognia writes anything.
- Every apply operation still flows through the domain subsystem's validation and persistence rules.
- Unsupported source concepts are reported without expanding `AppSettings` merely to mirror another tool.
- Current OpenCode paths follow its documented plural `agents/`, `skills/`, and `commands/` directories while retaining legacy-agent recognition where it is safe.

## Verification

Co-located adapter, orchestration, component, and Rust tests cover root overrides, conversion, merge strategies, cancellation, and wizard wiring. i18n catalogs are generated from paired English and Chinese namespaces.
