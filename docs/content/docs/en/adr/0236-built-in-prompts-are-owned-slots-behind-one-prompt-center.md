---
title: "0236 — Built-in prompts are owned slots behind one Prompt Center"
description: "Adds the Prompt Center: every model-facing text Cognia ships, and every prompt a user or plugin owns, is listed, compared, edited, scoped, previewed, exported and reset in one place, while each text keeps its single authority — a code slot in a revisioned override store, or the record, file or plugin that already owns it."
---

# ADR 0236 — Built-in prompts are owned slots behind one Prompt Center

**Status:** Accepted
**Date:** 2026-10-20
**Related:** ADR-0030, ADR-0090, ADR-0155, ADR-0194, ADR-0198, ADR-0199, ADR-0217, ADR-0237
**Design:** [Built-in prompt management](../../../../plans/2026-10-20-built-in-prompt-management.md) (read through its section 0)

## Context

Cognia sends hundreds of model-facing texts: chat bases and personas, mode
sections, built-in subagent identities, title and summary templates, completion
and judge prompts, team planners, twin, wiki and memory distillers, Router Fusion
roles, the environment bootstrap agent, and the wording of first-party plugins.
They lived as constants next to their callers. A user who wanted a stricter
command judge, a terser title, or a different research report had no way to
change them short of a new build.

Meanwhile the prompts users *do* own were spread over many screens with different
rules: characters (with plugin overlays and variants), presets (seeded built-ins
that refuse edits), Skills (generated bundles), custom and plugin modes,
repository instruction files, workspace instructions, the default system prompt,
subagent and team templates, and composer templates (which are user messages,
not instructions).

A single string table would have created a second authority for every one of
these and erased what each one means at runtime.

## Decision

### One read model, one authority per text

`lib/prompts/` is the management layer. It lists two kinds of resource behind
one model (`resources.ts`):

- **Code slots.** A shipped text is declared once with `definePrompt` next to
  its consumer: id, kind, group, operation, scopes, activation, risk, hosts,
  default body, variables, required fragments, output contract, budget,
  consumers. `catalog.ts` only references these definitions; the catalog test
  fails on a duplicate id, a default that fails its own contract, or a
  definition no consumer resolves. Overrides live in a revisioned store
  (`lib/db/prompt-overrides.ts`): bindings per scope with optimistic `rev`,
  immutable revisions, drafts, inheritance tombstones on reset, bounded history.
- **Owner resources.** Owner adapters (`lib/prompts/adapters/`) read and write
  through each owner's own service and declare what an edit means:
  - `source`: saved in place.
  - `custom-copy`: a variant or copy. A built-in character gets an ADR-0199
    variant; a seeded preset, a Skill, a plugin mode, a seeded subagent template
    or a shipped team template gets a copy that keeps every non-text setting.
  - `owner-only`: composer templates.
  - Checked writes: instruction files.

  An adapter never keeps a second active copy of a domain text.

### Resolution stays at the consumer

Each consumer calls `resolvePrompt` or `resolvePromptAsync` at its own call.
The resolver selects the most specific allowed scope (session, agent,
workspace, account) from a snapshot of the active account. It skips an
override that no longer meets the definition's contract or fails the PII gate,
renders `{{name}}` values clipped to their budgets, and records the last
resolution for the editor.

Several behaviours are owned by the consumer, not the resolver:

- **Command judge.** It is narrow-only: a command is auto-allowed only when both
  the shipped judge and the customised judge call it safe.
- **Machine-read protocol text** is inspect-only. This covers loop trailers,
  the A2UI protocol and the subagent frame.
- **Team planning** resolves against one snapshot frozen per run.

### Every host resolves the same slots

- **CLI.** `cognia-agent prompts` lists, shows, sets, resets, exports and
  imports in its own store.
- **Portable profiles.** These move overrides between stores. Import maps each
  scope target explicitly and never trusts an exported id.
- **Environment bootstrap agent.** It runs as Rust or as Bash/PowerShell
  scripts, so it gets one slot per runtime (`developer.bootstrap.*`). A test
  pins each slot's default to the runtime's own text.
  - The launcher passes a resolved override through the `systemPrompt` field
    every runtime already accepts, and passes nothing without one. Each
    runtime's default is therefore byte-identical.
  - An environment's own prompt wins over a Prompt Center override.
  - The 48 KiB launch budget counts the prompt actually sent.

### Plugins declare, the host assigns authority

A plugin cannot import host code (ADR-0155), so its wording reaches the Prompt
Center through a versioned SDK namespace, `ctx.prompts` (frontend, hybrid and
Python):

- `register` turns declarations into slots `plugin:<pluginId>/<id>`.
  - The plugin supplies only wording and contract: title, default, variables,
    fragments, contract version and budget.
  - The host assigns scope, activation and risk, and refuses a default that
    fails its own contract.
- `resolve` returns the user's override for the session's workspace or the
  account, else the default. A plugin can only reach its own namespace.

Other plugin contributions follow the same rules:

- **Subagents.** A plugin subagent's prompt is an account-scoped slot,
  `plugin:<id>/subagent.<subagent>`, registered with the subagent. Copying into
  a subagent template would have dropped `effort` and `disallowedTools`. Every
  dispatch rail reads the prompt through one resolver.
- **Modes.** A plugin mode is listed with the custom modes and changed through
  a copy that keeps its tools, permission and output format.
- **Disabled plugins.** When a plugin is disabled its slots disappear, but
  overrides do not. They are listed as unavailable, kept in exports, removable,
  and applied again when the plugin returns with a compatible contract.

Deep Research declares its five system instructions this way. Dates, locale
lines and the JSON shapes it parses stay in code.

### The Prompt Center UI

Settings → Prompts (desktop and standalone web) has:

- **A rail.** It is searchable over titles, ids, descriptions and shipped
  bodies, filters by source, group, workspace and modified state, and groups
  entries by owner.
- **Code detail.**
  - Header facts: activation, hosts, risk, last use, contract, consumers.
  - A scope target picker.
  - Variable-aware editing with live validation, drafts and publish.
  - Stale-edit and upstream-change warnings.
  - Comparisons against the shipped and published text.
  - History with restore, and reset with an inherited-text preview.
- **Owner detail.** It saves through the owner, offers custom copies,
  "use by default" and follow-base, and resolves file conflicts.
- **Effective preview.** It shows the sections of a new chat in send order for
  a chosen agent, mode and workspace. It uses the base-selection rule extracted
  from the send path, and labels the sections assembled only at send time.
- **Profile import/export.**

## Consequences

- Shipped wording can change without a build, per account, workspace, agent or
  session. A wrong edit is one reset away, and history is kept.
- Every owner keeps its semantics: built-ins stay immutable, files stay files,
  variants follow their base, plugins own their definitions.
- A new model-facing text must be declared and resolved at its call. The
  catalog test enforces that every declared definition is consumed.
- Plugin authors get a stable, permission-free contract to make wording
  tunable, and cannot widen where an edit applies.
- Out of scope:
  - Hidden provider prompts.
  - Tool schemas and authorization code.
  - The unmounted terminal AI Shell, whose prompts are not registered until the
    feature is wired or removed.
  - Paired-client writes. Companion sync has no configuration-write channel;
    profiles cover transfer.
