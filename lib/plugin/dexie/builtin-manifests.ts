import type { PluginManifestDexieBlock } from "@/types/plugin"
import { listBuiltinPrebootManifests } from "@/lib/plugin/core/builtin-preboot-manifests"

/**
 * Built-ins whose manifest declares `dexie.tables` but whose tables boot must
 * NOT apply. Each entry is a reviewed decision with its reason; the plugin side
 * documents the same dormancy and `builtin-manifests.test.ts` pins both.
 */
export const DORMANT_BUILTIN_DEXIE_DECLARATIONS: Readonly<Record<string, string>> = Object.freeze({
  "github-delivery":
    "Its four tables are the v2 plugin's storage, kept only so a rollback to the " +
    "signed v2 bundle finds its rows. v3 never calls ctx.dexie, so applying the " +
    "schema at boot would create four empty stores nothing reads or writes.",
})

/**
 * Every bundled plugin that declares `dexie.tables`, minus the dormant ones.
 *
 * Derived from the generated pre-boot snapshot rather than a hand-kept list of
 * `plugins/<id>/plugin.json` imports: database boot runs before the plugin
 * manager, and the snapshot is the one place the host reads built-in manifest
 * data without depending on plugin source. Imports no plugin code.
 */
export function getBuiltinPluginDexieManifests(): Map<string, PluginManifestDexieBlock> {
  const manifests = new Map<string, PluginManifestDexieBlock>()
  for (const [id, manifest] of listBuiltinPrebootManifests()) {
    if (!manifest.dexie?.tables?.length) continue
    if (Object.hasOwn(DORMANT_BUILTIN_DEXIE_DECLARATIONS, id)) continue
    manifests.set(id, manifest.dexie)
  }
  return manifests
}
