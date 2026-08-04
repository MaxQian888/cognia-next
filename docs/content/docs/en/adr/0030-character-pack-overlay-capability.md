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

## Amendment — 2026-05-23 (v50)

### Reversed: D5 — built-in seeds now ride the overlay too

The original ADR (§D5, §Alternatives) chose to keep the six built-in
characters out of the overlay-registry path: they stayed in
`seedBuiltInCharacters()` as plain Dexie rows. Two reasons make that
choice no longer optimal:

1. The new **Apply Update** flow (selective overwrite of pack-managed
   fields while preserving user edits) is built on top of the
   overlay-plus-snapshot model. Keeping the built-ins outside that model
   meant they would never benefit from in-place updates as Cognia ships
   prompt-engineering improvements to its own personas.
2. Concept consistency: every other character source — third-party
   plugin, local `.cognia-pack.json` file — flows through the overlay
   registry. Treating the built-ins as a special case forced two
   parallel code paths in `listCharacters`, `duplicateCharacter`, and
   the settings UI.

**New layout:**

- The six personas now live in
  `plugins/cognia-builtin-characters/src/index.ts` as a real
  first-party plugin. `BUILTIN_PACK.id = "builtin"`, plugin id
  `cognia-builtin-characters`, version `1.0.0`. The pack is
  re-registered on every app start via the standard plugin manager
  activation path.
- Dexie schema **v50** adds an upgrade hook that tags the legacy
  `char_builtin_*` rows with the new `sourcePluginId`/`sourcePackId`/
  `clonedFromPackCharacterId`/`packVersionAtClone` attribution. User
  customisations are preserved verbatim — only attribution fields are
  added.
- `listCharacters` gains a **clone-hides-overlay** dedupe rule: when a
  Dexie row's `clonedFromPackCharacterId` matches an overlay synthetic
  id, the overlay copy is suppressed in the picker. Built-ins therefore
  appear once (the Dexie row), and their attribution + Apply Update
  badge now work just like third-party-pack clones.

### Added: v2 manifest fields + Apply Update flow

Three optional fields land on `PluginCharacterDef`, gated by
`CHARACTER_PACK_FILE_SCHEMA_VERSION = 2`:

- `avatarImage?: { tauriPath?, webDataUrl? }` — author picks per-shell
  source; UI falls back to `avatarEmoji + avatarColor`.
- `persona?: { tone, personality, openingMessage, exemplarPrompts }` —
  display-only this round (the build-options pipeline does not consume
  them yet).
- `voiceProfile?: { provider, voiceId, rate?, pitch?, volume? }` —
  consumed via the new
  `lib/plugin/character-pack/character-voice.ts:resolveCharacterVoice`
  helper, which projects to a `Partial<SpeechSettings>` overlay for
  `TTSOrchestrator.speak()`. No `AppSettings` mutation.

`SUPPORTED_SCHEMA_VERSIONS = {1, 2}` — v1 packs keep parsing; new writes
emit v2.

**Apply Update** (selective overwrite):

- `Character.pristineSnapshot?: PackPristineSnapshot` records the
  pack-managed field values at clone/last-apply time.
- `lib/plugin/character-pack/diff-pack-update.ts` is a pure diff: per
  field, if `row[f]` still equals `snapshot[f]` the user hasn't touched
  it → safe to overwrite from the new overlay. Otherwise preserve.
- Settings UI gets an **Apply update** button (single) and **Apply to
  all (N)** (when ≥2 clones from the same pack are pending). Dialog
  shows the two-column diff before the user confirms.
- Legacy clones without a snapshot (created on v48) fall back to a
  confirm-before-overwrite-all path — the dialog surfaces a warning so
  the user can duplicate-for-backup first.

### Out of scope (follow-up)

- Wiring `resolveCharacterVoice` into the actual TTS dispatch site.
- `useTauriAssetUrl` hook for `avatarImage.tauriPath` rendering.
- ~~Ed25519 signature verification for `.cognia-pack.json` files.~~
  Delivered 2026-08-03 — see the amendment below.
- ~~New `requires` dimension types (theme-pack / connector / provider).~~
  Delivered 2026-08-03 — see the amendment below.

---

## Amendment — 2026-08-03 (trust chain + three new `requires` dimensions)

Delivers the last two `Out of scope` bullets above.

### Added: the pack trust model has exactly two states

```ts
type CharacterPackTrust =
  | { state: "verified"; algo; publicKey; fingerprint; shortFingerprint; signature }
  | { state: "unsigned" }
```

There is deliberately **no `"invalid"` state**. A signed pack whose
signature does not verify is refused at the scan/import boundary and
never reaches the registry, so the type cannot represent a lie. UI code
gets no `invalid` branch to render because no such pack exists in the
registry to render it for.

`resolvePackTrust` fails closed: `reason: "host-unavailable"` is `ok:
false` as well. If we cannot check a signature that is present, we do
not get to assume it was fine.

### Ruling: the signed bytes exclude `schemaVersion`

The signature covers the RFC 8785 canonical JSON of the **`pack` object
alone**. `schemaVersion` and `signature` live on the file wrapper and
are stripped before canonicalization.

This is what lets `CHARACTER_PACK_FILE_SCHEMA_VERSION` stay at `2` with
no Dexie migration: importing a signed v1 file and rewriting it as v2
leaves the signature valid. Had the wrapper been signed, every schema
bump would have invalidated every signed pack in existence.

### Ruling: plugin-contributed packs carry no trust chip at all

Their authenticity is already anchored by the plugin install receipt
(`PluginVerificationReceipt`). Rendering "Unsigned" beside them would
claim a gap that does not exist — actively misleading, not merely noisy.
Only local `.cognia-pack.json` files, which arrive from anywhere, show
the unsigned state.

### Ruling: trust lives in a sidecar map, not the registry `meta` bag

Widening the overlay registry's `meta` bag is the obvious storage and a
trust-spoofing hole: `registerCharacterPack` is re-exported from
`@cognia/plugin-sdk`, so any plugin could write `meta.trust =
"verified"` and mint itself a badge. Trust is written only by a
host-only `registerCharacterPackWithTrust` that the SDK does not
re-export. The SDK-visible `registerCharacterPack` is now a wrapper that
forces `{ state: "unsigned" }`, so a plugin re-registering over a
previously-verified pack id cannot inherit the badge.

### Added: three `requires` dimensions, warnings only

`themePacks` (canonical `"<pluginId>.<packId>"` keys), `connectors`
(platform kinds), and `providers` (canonical provider ids). Codes
`missing-theme-pack` / `missing-connector` / `missing-provider` join the
union. All are warnings — the pack still registers, still appears in the
picker, and its characters still resolve, per §B.6.

Connector availability is computed from
`CONNECTOR_METADATA.filter(m => m.status !== "planned")`, **not** the
raw `ALL_PLATFORM_KINDS` union: `email` / `kook` / `line` / `mattermost`
are in the union but have no branch in `buildAdapterFromRow`, so
treating them as available would swallow a real missing dependency.

`refreshAllPackWarnings()` is a push model, so each new source pushes
its own invalidation. Theme packs push from a dedicated
`warning-refresh-wiring.ts` installed by the local-pack initializer —
**not** from inside `theme-pack-registry.ts`, which would make
`lib/theme` depend on `lib/plugin`.

Two pre-existing defects were fixed while here: the declared
`missing-a2ui-catalog` code had no branch that could emit it, and the
per-character `providerId` was never checked. The latter can light up
warnings on packs that were previously clean.

### Fixed: `exportPack` silently dropped the signature

It called `serializeLocalPackFile(pack)` with no second argument, so
every exported pack came out unsigned regardless of what was imported.
Exporting a verified pack now round-trips the original signature block
verbatim and the exported file still verifies.

### Added: `cognia pack sign` / `cognia pack verify`

Verification without a way to produce a signature is a dead feature, so
the CLI ships the signer. The signature is written **in-band** into the
file's own `signature` object rather than as a detached `.sig` — a pack
is a single self-contained file that can be mailed or committed without
a companion file going missing.

`pack sign` self-verifies before writing anything. The host verifies
bytes produced by JavaScript while the CLI produces them from a
hand-ported RFC 8785 implementation; without the self-check, a
formatter bug would be silent at authoring time and surface as a random
verification failure on a user's machine.

`pack verify` reports three outcomes where the host has two: `verified`,
`unsigned` (exit 0 — a supported, labelled state; `--require-signature`
makes it an error in CI), and `invalid` (always non-zero).

### Note: the canonicalizers disagreed, and the shared fixture caught it

Both sides are driven by one golden-vector file,
`lib/plugin/character-pack/__fixtures__/jcs-vectors.json`, consumed by
Jest via `import` and by Rust via `include_str!`. On first run it failed.

The TypeScript side sorted keys and then handed the result to
`JSON.stringify` via an intermediate object. That silently undoes the
sort: a JS object's own property order hoists integer-like keys to the
front in ascending **numeric** order regardless of insertion order, so
`{"1","10","2"}` came back out as `1, 2, 10`. RFC 8785 §3.2.3 wants
UTF-16 code-unit order — `"1" < "10" < "2"`. Rust's `BTreeMap` has no
such rule, which is precisely how the two diverged.

The serializer now builds the output string directly and hands only
*leaves* to `JSON.stringify`, keeping ES-conformant number formatting
and string escaping while owning key order. A checked-in pack signed by
the real `cognia pack sign` binary is verified in Jest by Node's own
Ed25519, so the suite proves interop on a real artifact rather than only
on vectors somebody remembered to write down.
