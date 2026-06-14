// Pure helpers for the global "Plugin configuration" Settings section. Kept
// React-free so the bulk of branch coverage lives in a fast unit test.

import type { PluginRow } from "@/lib/db/plugin-types"

interface ConfigManifestShape {
  configSchema?: { properties?: Record<string, unknown> }
  // Current manifest shape is `{ entry, export }`; a bare string is the legacy
  // shape some manifests still use. Both count as a config surface.
  configComponent?: unknown
}

function hasConfigComponent(configComponent: unknown): boolean {
  if (typeof configComponent === "string") return configComponent.trim().length > 0
  if (configComponent && typeof configComponent === "object") {
    const entry = (configComponent as { entry?: unknown }).entry
    return typeof entry === "string" && entry.trim().length > 0
  }
  return false
}

/**
 * True when a plugin exposes a configuration surface worth showing in the
 * global Settings section: a `configSchema` with at least one property, or a
 * custom `configComponent` entry. A schema with no properties renders nothing
 * useful, so it does not count.
 */
export function pluginExposesConfig(plugin: PluginRow): boolean {
  const manifest = (plugin.manifest ?? {}) as ConfigManifestShape
  const props = manifest.configSchema?.properties
  const hasSchema = !!props && typeof props === "object" && Object.keys(props).length > 0
  return hasSchema || hasConfigComponent(manifest.configComponent)
}

/** Filter a list of plugins down to those exposing a config surface, by name. */
export function filterConfigurablePlugins(plugins: PluginRow[]): PluginRow[] {
  return plugins
    .filter(pluginExposesConfig)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
}
