/**
 * Plugin SDK — `character-pack` capability surface (ADR-0030).
 *
 * Re-exports the `defineCharacterPack()` authoring helper and the
 * dynamic registry plugins use to contribute character packs at
 * activation time.
 *
 * Sources:
 *  - `packages/plugin-sdk/src/define/define-character-pack.ts`
 *  - `lib/plugin/registries/character-pack-registry.ts`
 *  - `types/plugin/plugin-character-pack.ts`
 *
 * Plugin authors call `defineCharacterPack()` in their manifest builder
 * for autocomplete + compile-time shape checks, then declare the pack
 * statically in the manifest's `characterPacks` array. Dynamic
 * registration from inside `activate(ctx)` is also supported via
 * `registerCharacterPack` — the plugin manager unregisters everything
 * the plugin contributed on disable via
 * `unregisterCharacterPacksByPlugin(pluginId)`.
 */

export {
  defineCharacterPack,
  PLUGIN_CHARACTER_PACK_SOFT_LIMIT,
} from "../define/define-character-pack"

export {
  registerCharacterPack,
  unregisterCharacterPackById,
  unregisterCharacterPacksByPlugin,
  getCharacterPack,
  getCharacterPackEntry,
  listCharacterPackIds,
  listCharacterPackEntries,
  listAllPackCharacters,
  getPackCharacterByRuntimeId,
  buildOverlayCharacterId,
  isOverlayCharacterId,
  getPackWarnings,
  getPackCharacterWarnings,
  refreshAllPackWarnings,
} from "@/lib/plugin/registries/character-pack-registry"

export type {
  PluginCharacterPackDef,
  PluginCharacterDef,
} from "@/types/plugin/plugin-character-pack"

export type { PluginCharacterPackWarning } from "@/lib/plugin/character-pack/validate-requires"
