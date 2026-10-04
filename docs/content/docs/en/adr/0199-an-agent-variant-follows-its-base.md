---
title: "0199 — An agent variant follows its base"
description: "Agent configurations were detached copies. A copied strict reviewer did not receive later prompt or skill changes from its source. Adds Character variants linked to a base. Each variant owns only its changed profile fields and inherits the rest. Workspaces can select the agent or variant used for new conversations."
---

# ADR 0199 — An agent variant follows its base

**Status:** Accepted
**Date:** 2026-09-27
**Related:** [ADR-0198](./0198-a-runs-capabilities-are-granted-not-patched) (per-run grants), [ADR-0161](./0161-agent-identity-runtime-and-host) (identity vs runtime), [ADR-0030](./0030-character-pack-overlay-capability) (plugin character packs and their clones), [ADR-0144](./0144-workspace-as-the-unit-of-work) (workspaces)

## Context

An agent (`Character`) bundles a prompt, model routing, tools, MCP subset,
skills, knowledge bases, memory policy, sandbox and more. People want the same
agent in more than one configuration: a lenient and a strict reviewer, one
tuned for a particular repository, one on a cheaper model for scheduled runs.

The only tool for that was Duplicate, which writes a detached copy. The copy
records no link to its source (only plugin-pack clones keep lineage, for the
pack-update flow), so every later fix to the original has to be repeated by
hand in each copy, and nothing says which copies exist.

Workspaces had no way to say which agent their conversations start as, so a
repository-specific configuration had to be picked by hand each time.

## Decision

### A variant owns what it changed

`Character.variant = { baseId, ownFields }` (`packages/agent-config-types/src/agent-variant.ts`).

- **Row fields** (id, name, description, avatar, timestamps, built-in flag,
  pack lineage) always belong to the variant.
- **Profile fields** listed in `ownFields` come from the variant. Every other
  profile field comes from the base's current effective profile. An owned field
  with no value clears the base's value rather than inheriting it.
- The base may be a user agent, a built-in, a plugin-pack overlay, or another
  variant. Chains are resolved up to `MAX_VARIANT_DEPTH`, with cycle detection.

`resolveCharacterById` and `listCharactersByIds` apply the overlay, so every
runtime consumer (the send-option resolver, `executeAgent`, the scheduler,
teams) sees the effective agent without change. `resolveCharacterVariants` /
`listResolvedCharacters` do the same for already-loaded lists.

### The row keeps a full snapshot

A variant row still stores a complete, materialized profile: its effective
values as of its last save. Raw readers see a whole agent. When the base
cannot be resolved (deleted, plugin pack disabled, cycle, chain too deep), the
variant falls back to that snapshot with a warning instead of losing its
prompt and tools.

### Editing decides ownership

Editing a variant applies the patch to its effective agent, and the variant then
owns exactly the profile fields that differ from its base. A field edited back
to the base's value follows the base again. `updateCharacter` routes every edit
of a variant row through this computation (it ignores a `variant` value in the
patch), so no caller can write a value the base would then shadow.

Explicit operations: `createCharacterVariant(baseId, name)` (starts owning
nothing), `detachCharacterVariant` (becomes an ordinary agent with its current
effective profile), `resetCharacterVariant` (drops every override).
`deleteCharacter` refuses a base that still has variants
(`CharacterHasVariantsError`), and duplicating a variant produces a detached copy.

The settings list shows variants resolved, badges them with their base and
how many fields they override, and offers create, reset and detach. The editor
says it is editing a variant.

### A teammate can run as a saved agent

A team member's resolved `characterPackIds` (agent ids: user agents, variants
or plugin-pack characters) name the agent it runs as. `dispatchTeammate`
resolves the first id through `resolveCharacterById`, so a variant arrives
with its overlay applied, and `teammateToCharacter` starts from that profile:
knowledge bases, memory policy, output style and the rest come from the agent.
The teammate's own prompt, model, provider and tools override it, and the
team's MCP servers and skills are added to the agent's. If an id no longer
resolves, dispatch fails. It does not substitute a generic teammate.

### A workspace names its default agent

`Project.defaultCharacterId` is the agent a person's new conversation in that
workspace starts as (`lib/workspace/project-default-agent.ts`, applied in
`startNewSession`). It never overrides an agent, team or squad the caller
named, and it does not apply to conversations nobody started
(`activate: false`). A default that no longer resolves is skipped with a
warning, and the workspace dialog shows it as missing. Pointing it at a variant
is how one repository gets its own configuration of a shared agent.

## Consequences

- Fixing a base reaches its variants. A variant's settings answer "what does
  this configuration change?" instead of "what did I copy?"
- Variants add one optional, non-indexed field, so there is no Dexie version bump.
- Consumers that read raw rows with `getCharacter` see the snapshot, not the
  live overlay. Runtime paths use `resolveCharacterById`.
- Teams reuse configured agents instead of restating them per member.
- Deleting a widely used base needs an explicit detach or delete of its
  variants first.
