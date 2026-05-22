---
title: ADR-0030 — Character Pack overlay capability
description: Plugin-contributed character bundles (`character-pack`) as the 5th entry in `OVERLAY_REGISTRY_CAPABILITIES` — overlay-only registration, namespaced runtime ids, Dexie-first union, user-clone attribution, and standalone `.cognia-pack.json` import via a local-pack store that sidesteps the marketplace install pipeline.
---

# ADR-0030 — Character Pack overlay capability

**Status**: Proposed (2026-05-22)
**Authors**: Max Qian + Claude Opus 4.7
**Affects**: `lib/plugin/registries/`, `lib/db/characters.ts`, `lib/claude/build-options.ts`, `components/settings/characters-section.tsx`, `components/chat/character-picker.tsx`, `components/chat/chat-view.tsx`, `components/mobile/discover/character-card.tsx`, `lib/plugin/character-pack/` (new)

## Context

cognia-next has a mature `Character` subsystem (`lib/claude/types.ts:Character`, Dexie `characters` table, CRUD + Settings UI + Mobile Discover + Twin soft-binding + `build-options.ts:resolveSendOptions` send-time merge), but no concept of a portable "character pack" or a plugin capability for contributing characters.

Audit-confirmed gaps before this work:

- `PLUGIN_CAPABILITY_CONTRACTS` (`lib/plugin/contracts/plugin-capabilities.ts:61`) had no `character` / `persona` / `character-pack` entry.
- `OVERLAY_REGISTRY_CAPABILITIES` (`lib/plugin/contracts/capability-bridge-map.ts:85`) covered only 4 capabilities: `skills`, `mcp-server-preset`, `native-anthropic-tool`, `external-agent-preset`.
- `PluginManifest` had no `characterPacks` field.
- Plugins could not contribute characters; users could not import a portable pack file; built-in seeds and plugin contributions had no merge / precedence story.

The user requested character packs that:

1. ride the existing overlay-registry pattern (no new dispatch machinery in `PluginManager`),
2. survive plugin disable cleanly without orphaning user edits,
3. carry their own bundled dependencies (skills / mcp-presets / native-tools / a2ui catalog),
4. import / export as standalone JSON files,
5. integrate with Settings + mobile + chat picker UIs without inventing new visual primitives.

A first design draft missed several existing patterns (i18n `{ns,key}` not used in any manifest; marketplace install rejects synthetic manifests; many "new" components could reuse existing `<Badge>` / `<Accordion>` / `<Alert>` / `usePluginStore`). This ADR records the corrected design.

## Decision

Introduce `character-pack` as the 5th entry in `OVERLAY_REGISTRY_CAPABILITIES`. Plugin manifests declare `characterPacks: PluginCharacterPackDef[]`; the manager's existing `for (const cap of OVERLAY_REGISTRY_CAPABILITY_KEYS) descriptor.registerEntry(...)` loop picks it up with zero surgery. Standalone `.cognia-pack.json` files use a separate `local-pack-store` that registers into the same overlay with `pluginId = "local:imported"`.

### Eight load-bearing decisions

**(D1) Overlay-only registration.** Plugin-contributed characters live in the in-memory `character-pack-registry` (a `createOverlayRegistry<PluginCharacterPackDef>()` closure) and never persist to Dexie. Disable / uninstall is atomic: one `unregisterByPlugin(pluginId)` Map scan drops every pack the plugin contributed.

**(D2) Namespaced runtime ids.** The host derives a synthetic Character id at projection time: `cognia-pack:<pluginId>:<packId>:<localId>`. This namespace is physically disjoint from Dexie's `char_builtin_*` and `char_<ts>_<rand>` ids, so collisions are impossible — the union path (D3) has a belt-and-braces de-dup map, but it never fires in practice.

**(D3) Dexie wins on the union.** `listCharacters()` unions Dexie rows with `listAllPackCharacters()`, with Dexie always taking precedence on id collision. `resolveCharacterById(id)` is the lookup function used by `build-options.ts:resolveSendOptions`: Dexie first, then `getPackCharacterByRuntimeId(id)` for synthetic ids, then undefined.

**(D4) User clones survive plugin disable.** Duplicating an overlay character writes a brand-new Dexie row carrying `sourcePluginId` / `sourcePackId` / `clonedFromPackCharacterId` / `packVersionAtClone`. Disabling the contributing plugin removes the overlay; the clone stays editable. Re-enabling the plugin with a newer `pack.version` surfaces an "Update available" badge on the clone — never auto-overwrites.

**(D5) Built-in seeds are not migrated.** `seedBuiltInCharacters()` (`lib/db/characters.ts:113`) stays exactly as-is — six Dexie rows seeded at first-launch. Plugin packs add on top. Migrating the seeds to a first-party plugin (`plugins/cognia-character-seeds/`) was considered and rejected — it introduces a load-order dependency (the plugin must register before chat boot can resolve a built-in id) that the current synchronous seed avoids.

**(D6) `requires` is warn-not-block.** Pack-level `requires: { skills, pluginSkillIds, mcpServerPresets, nativeAnthropicTools, a2uiCatalogId }` is validated at register time and surfaces a `PluginCapabilityDiagnostic { code: "plugin.capability.partial" }` when a referenced id is missing. The pack still registers — characters that reference missing dependencies degrade gracefully through the existing `resolveSendOptions` paths (unknown skill ids are silently dropped today). Hard `blocked` is reserved for capability-contract level decisions.

**(D7) i18n by plugin bundle, not by manifest shape.** `PluginCharacterPackDef.name` and `PluginCharacterDef.name` are plain `string` (matching every other capability's manifest field). Plugins wanting localised labels register their own translation bundle via the existing `lib/i18n/plugin-i18n-registry.ts:registerPluginI18n` and the host renders `plugin.<pluginId>.<key>`. An earlier draft proposed `name: string | { ns, key }` — rejected because no other manifest field carries that shape, and the plugin-i18n bundle channel already exists.

**(D8) Standalone `.cognia-pack.json` bypasses marketplace install.** The marketplace install pipeline expects a Tauri-extracted tarball — it does not accept synthetic manifests. So standalone packs use a separate `lib/plugin/character-pack/local-pack-store.ts` that reads / writes `<appDataDir()>/cognia/local-character-packs/<id>.cognia-pack.json` and registers into the overlay with `pluginId = "local:imported"`. App boot runs `scanAndRegisterLocalPacks()` via the new `LocalCharacterPackInitializer`. Web mode is a graceful no-op.

## Schema

### `Character` extension (`lib/claude/types.ts:1479`)

```ts
sourcePluginId?: string           // set only on user-cloned rows
sourcePackId?: string
clonedFromPackCharacterId?: string
packVersionAtClone?: string
```

All four optional, all non-indexed, all undefined on legacy rows → treated as "user-created" by the badge logic.

### Dexie migration

**v47 → v48**. Pure shape bump (`this.version(48).stores({})`), no index changes, no upgrade hook. The four new fields are JSON columns populated only by `duplicateCharacter()` when the source is an overlay synthetic id.

### `PluginCharacterPackDef`

See `types/plugin/plugin-character-pack.ts`. Pack identity is `{ id, version }`; characters identify by pack-local `localId`. Soft cap 50 characters per pack (enforced by `defineCharacterPack()`).

### File format (`lib/plugin/character-pack/schema.ts`)

```ts
{ schemaVersion: 1, pack: PluginCharacterPackDef, signature?: { algo, pubKey, sig } }
```

Future format versions bump `schemaVersion`; today's reader rejects future versions with an actionable error message ("Upgrade Cognia"). The signature field is reserved for forward compatibility with the existing Ed25519 verifier (`lib/plugin/wasm/signature-verifier.ts`); V1 accepts unsigned files.

## Lifecycle table

| Event                                  | Behaviour                                                                                                                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Plugin enable                          | `PluginManager` walks `OVERLAY_REGISTRY_CAPABILITY_KEYS` → `descriptor.registerEntry(pack, { pluginId })` → `registerCharacterPack`. Settings + picker UIs re-render via Zustand subscription.                                       |
| Plugin disable                         | `unregisterCharacterPacksByPlugin(pluginId)` — single Map scan. Dexie clones untouched. In-flight sessions with overlay `characterId` get a destructive `<CharacterMissingBanner>` and fall through to app defaults.                 |
| Plugin re-enable, newer `pack.version` | Settings rows with matching `sourcePluginId+sourcePackId` show "Update available" badge. User chooses Re-clone (new row) or Dismiss.                                                                                                 |
| User clones overlay                    | `duplicateCharacter(syntheticId)` resolves the overlay, writes a Dexie row with the four `source*` fields filled in.                                                                                                                 |
| Local-pack import                      | `importLocalPack()` validates schema → writes file → `registerCharacterPack(..., { pluginId: "local:imported" })`. Re-importing same id overwrites. Conflict with a real-plugin pack id rejects the import with an actionable error. |
| Local-pack delete                      | `deleteLocalPack(id)` unregisters + removes file. Dexie clones survive.                                                                                                                                                              |

## Alternatives considered

- **Store plugin characters in Dexie with cleanup-on-disable** — rejected. Creates a race on in-flight sessions (the row vanishes mid-stream); makes clone semantics harder to reason about; the overlay model is what every other capability uses.
- **Merge built-in seeds into a first-party plugin** — rejected. Adds a load-order dependency to chat boot for zero user-visible benefit. The seeds are stable enough to live in `lib/db/characters.ts`.
- **`name: string | { ns, key }` in manifest** — rejected. No other manifest field uses this shape; the plugin-i18n bundle channel already exists and is the canonical way to localise plugin-provided strings.
- **Synthesise a tarball for `.cognia-pack.json` files and run through marketplace install** — rejected. Heavyweight; the local-pack store needs ~120 lines for the full workflow vs. ~500 lines to fake a plugin. Local packs also have different lifecycle (no enable/disable, no plugin permissions) — modelling them as plugins would obscure the difference.
- **New `<PluginSourceBadge>` component** — rejected. The existing `<Badge variant="outline">` already covers the visual; one row of conditional JSX in `characters-section.tsx` and `character-card.tsx` is clearer than a new component file.

## Verification

- `pnpm test -- lib/plugin/registries/character-pack-registry.test.ts lib/db/characters.test.ts lib/plugin/character-pack lib/claude/build-options.test.ts lib/plugin/contracts components/chat/character-picker.test.tsx components/chat/character-missing-banner.test.tsx hooks/plugins/use-plugin-metadata.test.ts` — 214 tests green.
- `pnpm lint:i18n` — key parity OK, baseline rewritten to 528 findings.
- `pnpm audit:slots` — unaffected (no new UI slots introduced).
- Manual Tauri verification scenarios documented in `~/.claude/plans/serene-launching-scroll.md` §X.

## Risks

1. **Cross-plugin skill reference.** A pack character references `skillIds: ["foo"]` where `foo` is contributed by a different plugin that's not installed. `resolveSendOptions` already silently drops unknown skill ids; the register-time validator (`PluginCapabilityDiagnostic`) surfaces a warning chip in the Settings row.
2. **Stale clone after pack rename.** If a maintainer renames a `localId` between versions, `clonedFromPackCharacterId` no longer resolves. Documented as a pack-author guideline: never change `localId` after publication.
3. **Dangling session.characterId.** Covered by `<CharacterMissingBanner>`. Re-enable hides the banner automatically.
4. **Manifest size.** 50 characters × 10 KB systemPrompt = 500 KB per plugin; `createOverlayRegistry` stores entries by reference so memory cost is bounded. SDK helper enforces the soft cap.
5. **Plugin-owned Dexie tables not auto-dropped on uninstall** (pre-existing gap, not introduced by this work). A clone whose `sourcePluginId` points to an uninstalled plugin becomes a Dexie "orphan" — still usable, just without an overlay parent.
