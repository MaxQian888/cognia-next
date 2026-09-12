import type { PluginDefinition, PluginManifest } from "@/types/plugin/plugin"

/** Preserve a plugin definition while giving TypeScript the complete author contract. */
export function definePlugin(definition: PluginDefinition): PluginDefinition {
  return definition
}

/**
 * The shape `import manifest from "./plugin.json"` has under
 * `resolveJsonModule`: every enum-typed field (`type`, `capabilities[]`,
 * `permissions[]`, `activationEvents[]`, `runtimeCompatibility.*.availability`)
 * is widened to `string`, so a JSON manifest is never assignable to
 * `PluginManifest` as-is. Without this type every plugin reached for a cast —
 * `as never` erases the manifest type entirely (a misspelled contribution field
 * vanishes silently), `as unknown as PluginManifest` says nothing about what the
 * file must at least contain.
 *
 * Identity fields are required; every other key must be a real `PluginManifest`
 * field but may hold any value, because the JSON side has already widened it
 * and the TypeScript side (a `define*` helper's return) is typed at its own
 * definition site. Excess-property checking still fires on an object literal,
 * so `definePluginManifest({ ...json, characterPack: [...] })` (singular) fails
 * to compile instead of contributing nothing.
 */
export type PluginManifestJson = Pick<PluginManifest, "id" | "name" | "version"> & {
  type: string
} & { [K in Exclude<keyof PluginManifest, "id" | "name" | "version" | "type">]?: unknown }

/**
 * Adopt a JSON-imported manifest — optionally merged with TypeScript-authored
 * contribution arrays — as the plugin's `PluginManifest`.
 *
 * Returns the same object: the host validates every value when the plugin is
 * discovered and enabled (`validatePluginManifest`), so this is a typing seam,
 * not a second validator. Spread `plugin.json` rather than hand-writing a
 * subset: a built-in's module manifest is merged OVER its JSON at discovery, so
 * a subset silently drops every field it omits.
 *
 * @example
 *   import manifestJson from "../plugin.json"
 *   const definition = definePlugin({
 *     manifest: definePluginManifest({ ...manifestJson, characterPacks: [MY_PACK] }),
 *     activate: async (ctx) => { … },
 *   })
 */
export function definePluginManifest(manifest: PluginManifestJson): PluginManifest {
  return manifest as unknown as PluginManifest
}
