import type { PluginManifest } from "@/types/plugin"
import prebootSnapshot from "./builtin-preboot-manifests.generated.json"

/**
 * The manifest fields of a built-in plugin that the host reads before the
 * plugin manager boots.
 *
 * Database boot applies plugin Dexie tables and first-launch seeding writes the
 * built-in characters while no plugin has been discovered yet. Both used to
 * import `plugins/<id>` source directly, which tied the host build to plugin
 * source. The plugin artifact producer copies exactly these fields out of the
 * evaluated built-in manifests (`PREBOOT_MANIFEST_FIELDS` in
 * `scripts/plugin/artifacts/builtin-chunks.mjs`), and `pnpm plugin:builtin:build`
 * stages them as a small committed snapshot, separate from the full asset index
 * so the eager boot path does not load the index the manager keeps behind a
 * dynamic import.
 */
export type BuiltinPrebootManifest = Pick<PluginManifest, "version" | "dexie" | "characterPacks">

const plugins = (prebootSnapshot as { plugins: Record<string, BuiltinPrebootManifest> }).plugins

/** The pre-boot fields of one built-in, or `undefined` when it declares none or is not shipped. */
export function getBuiltinPrebootManifest(pluginId: string): BuiltinPrebootManifest | undefined {
  return Object.hasOwn(plugins, pluginId) ? plugins[pluginId] : undefined
}

/** Every built-in that declares at least one pre-boot field, keyed by plugin id. */
export function listBuiltinPrebootManifests(): ReadonlyMap<string, BuiltinPrebootManifest> {
  return new Map(Object.entries(plugins))
}
