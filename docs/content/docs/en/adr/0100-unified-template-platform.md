---
title: "0100 — Unified Template Platform"
description: "One portable, content-addressed template envelope, one source-partitioned catalog and one lifecycle service behind twelve pre-existing notions of 'template', with a hash-pinned preflight plan as the plugin-facing seam."
---

# ADR 0100 — Unified Template Platform

**Status:** Accepted
**Date:** 2026-07-30

## Trust amendment (2026-08-13)

Marketplace channel provenance never elevates publisher trust. A correctly signed package is `signed-unknown` unless the exact embedded public key is trusted by the existing trusted-publisher ledger. Hydration rechecks that ledger and atomically downgrades revoked or legacy channel-derived `verified-publisher` package and release provenance without deleting template content or changing its content hash.

## Context

"Template" meant twelve unrelated things, each with its own storage, its own notion of built-in, and its own import path or none at all. Six were backed by a store or a Dexie table with an `isBuiltIn` flag — Agent Team templates (`BUILT_IN_TEAM_TEMPLATES`), subagent templates (`BUILT_IN_SUBAGENT_TEMPLATES`), custom modes (`MODE_TEMPLATES`), workflow templates, characters and skills. Six more existed only as a hard-coded list or a bespoke table: A2UI apps, goal templates, scheduler task templates, prompt presets, subscription presets and documents.

Nothing was shared between them, and the absences were the same in every case:

- **No identity and no version.** A template was whatever row happened to be there. "Update this team to the newer version of the template it came from" was not expressible, because no resource recorded what it was instantiated from.
- **No portable artifact.** There was no way to hand a template to someone else, and therefore nothing to sign, check, or bound the size of.
- **No pre-application answer to "what will this touch".** Instantiating meant calling the domain's create path and finding out.
- **A plugin could contribute exactly two of the twelve.** `PluginAgentTeamTemplateDef` and `PluginWorkflowTemplateDef` were two unrelated bespoke contribution shapes with no validation, no provenance and no permission of their own; the other ten domains had no contribution surface at all.

## Decision

One envelope, one catalog, one service. `lib/templates/` owns the contract; the domains keep their writers.

- **`TemplateDefinitionEnvelope` is the single portable identity**, versioned as `cognia.ai/templates/v1` and content-addressed. `contracts.ts` owns the shape, the canonical stringify, and hash creation plus verification. Releases are identified by `id@version`, drafts by `id` with a status and revision. Content addressing is what lets an imported definition be judged on what it *is* rather than on where it arrived from.

- **Two domain tiers, deliberately unequal.** `TEMPLATE_FULL_DOMAINS` (agentTeam, workflow, subagent, customMode, character, skill) get the whole lifecycle: project an existing resource into a payload, preflight, instantiate, diff, update, detach. `TEMPLATE_CATALOG_ONLY_DOMAINS` (a2ui, goal, scheduler, prompt, subscription, document) are searchable in the same catalog but keep their own creation flows. The six full domains already had a writer that could be driven through a port; the other six each have a bespoke creation path, and reimplementing those would have bought discoverability at the price of a second, divergent writer per domain.

- **The catalog projects; it never owns.** `runtime.ts` wires the real stores and Dexie writers in as ports, so instantiation still goes through `createTeam` / `createWorkflow` / `createCharacter` / … . A legacy table stays the authority for its own rows and the catalog entry is derived, which is what keeps the transition from creating two writers for one resource.

- **Preflight returns a plan, and the plan is hash-pinned.** `preflight` yields bindings, operations, issues and the definition's `definitionHash`; `instantiate` refuses a plan whose hash no longer matches. This is the seam that makes the plugin surface safe: `lib/plugin/api/templates-api.ts` retains the unredacted plan in-process, hands the plugin a copy whose sensitive binding ids are replaced by `${kind}:bound`, and requires the plugin to return the plan id. A plugin therefore can neither read the resource ids it is binding to nor present a plan it did not preflight.

- **Four permissions, and instantiation additionally costs the domain's own.** `templates:read` / `:contribute` / `:instantiate` / `:library:write` are in the permission catalog. On top of `templates:instantiate`, a definition's declared capabilities map to the domain permission they imply (`execution` and `tool` → `agent:control`, `filesystem` → `filesystem:read`, …) and a missing one blocks the plan rather than failing at apply time. Without that mapping, `templates:instantiate` would be a laundering path into capabilities the plugin never declared.

- **Instances record provenance; bindings stay on the device.** `templateInstances` keeps the full definition snapshot, its content hash, the binding fingerprint and a `baseline` payload — the merge base that makes `diff(baseline, local, next)` and `planUpdate` / `applyUpdate` expressible at all. `templateDeviceBindings` and `templateMigrationJournal` are local-only and deliberately never registered in `lib/sync`: a binding names a resource on *this* machine, and a journal row is a claim about what *this* device already converted.

- **Migration is journaled and idempotent, not a one-shot.** `bootTemplatePlatform` runs per unlocked account, converting legacy rows through `LegacyTemplateSource` adapters under an id derived deterministically from the domain plus an NFKC-normalized source key. The journal is what makes a re-run safe and `rollbackMigration` possible; without it, a partial first boot would duplicate on the second.

- **Built-ins are a per-boot overlay, not migrated rows.** `refreshBuiltInTemplateOverlays` re-projects the shipped constants and the `isBuiltIn` Dexie rows into the catalog on every boot instead of copying them into `templateDefinitions`. A shipped built-in has to move with the app version; a migrated copy would pin whichever version the user first booted.

- **The catalog is partitioned by source.** `TemplateCatalog` holds one map per source id (`plugin:<id>`, the built-in overlay, Dexie), so `removeSource` / `replaceSource` retract exactly one contributor's set when a plugin unloads. A flat map would make unloading one plugin either leave its definitions behind or require a full rebuild.

- **Packages are a hardened zip with a verified signature.** `package.ts` bounds compressed and expanded size, file count, path depth and compression ratio, fixes the zip date so exports are reproducible, and checks every definition and asset against the manifest's sha256 before anything reaches the catalog. The Ed25519 signature covers the canonically-serialized manifest minus its own `signature` field — and since the manifest carries each definition's and asset's digest, signing it transitively covers the content.

Gated by `NEXT_PUBLIC_UNIFIED_TEMPLATE_PLATFORM`, default on. Surfaced at `/templates` (Template Studio), plus the Agent Teams page, the workflow settings templates tab, and Discover.

## Consequences

**Trust is verified cryptographically but no key is pinned.** `signed-unknown` means the bytes match the public key *enclosed in the package* — not that the key belongs to anyone in particular. `verified-publisher` is granted on the strength of the channel (a signed package that arrived via `source: "marketplace"`), not a pinned publisher key. There is no publisher registry, so a self-signed package from a stranger and one from a known author are indistinguishable below the marketplace tier. Anything stronger needs a key-pinning story that does not exist yet.

**Six domains carry two representations during the transition** — their original store or table, which remains the writer, and a derived catalog projection. This is the cost of not rewriting six creation paths at once, and it means a domain that gains a new write path outside its port silently stops being projected.

**The two legacy plugin contribution types survive, frozen.** `registerLegacyPluginTemplateCompatibility` projects `PluginAgentTeamTemplateDef` and `PluginWorkflowTemplateDef` into `0.0.0-compat` unsigned releases so existing plugins keep working. They are not extended; new contributions go through `templates:contribute` or a template package.

**Dexie v132 adds five tables.** Three carry the portable projections and are registered in `lib/sync` with their own handlers (`templateDefinitions`, `templatePackages`, `templateInstances`); the two device-scoped ones are not, by the reasoning above. v133 is deliberately skipped — v132 was written while a concurrent session held uncommitted work on the same tree, and the note in `schema.ts` records why.

**A payload type must be a `type` alias, never an `interface`.** A payload has to satisfy `TemplateJson`, whose object arm is an index signature, and TypeScript derives an implicit index signature only for object-literal type aliases. Declaring one as an `interface` breaks assignability across `adapters.ts`, `legacy-sources.ts` and `template-studio.tsx` at once, which is the trap the comment in `adapters.ts` exists to prevent recurring.
