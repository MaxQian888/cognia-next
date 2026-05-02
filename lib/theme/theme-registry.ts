// Theme registry (§E new module).
//
// Plugins declaring the `themes` capability contribute UI theme variants.
// cognia-next stores user themes as Dexie rows in `customThemes`, but there
// is no programmatic registration API for ephemeral / plugin-contributed
// themes today. This module is the runtime registry.
//
// Persistence model: plugin themes live ONLY in this in-memory registry —
// disabling the plugin removes them. If a user wants to keep a theme they
// can clone it into the persistent `customThemes` table through the
// settings UI; that flow is beyond this module's scope.

export interface PluginTheme {
  /** Stable id (typically `${pluginId}.${themeName}`). */
  id: string
  /** User-facing name. */
  name: string
  /** Optional description shown in the theme picker. */
  description?: string
  /**
   * Theme variables. Each key is a CSS variable name (e.g., `--background`)
   * and each value is the CSS value (e.g., `oklch(0.98 0 0)`). Cognia
   * groups light/dark via separate themes; we mirror that pattern.
   */
  variables: Record<string, string>
  /** Light or dark variant — drives the picker icon. */
  variant?: "light" | "dark"
  /** Origin tag — set by the plugin manager. */
  source?: "builtin" | "plugin"
  pluginId?: string
}

const registry = new Map<string, PluginTheme>()

export function registerPluginTheme(theme: PluginTheme): { replaced: boolean } {
  if (!theme.id) throw new Error("registerPluginTheme: id is required")
  const replaced = registry.has(theme.id)
  registry.set(theme.id, theme)
  return { replaced }
}

export function unregisterPluginTheme(id: string): boolean {
  return registry.delete(id)
}

export function unregisterThemesByPlugin(pluginId: string): number {
  let removed = 0
  for (const [id, theme] of registry) {
    if (theme.pluginId === pluginId) {
      registry.delete(id)
      removed += 1
    }
  }
  return removed
}

export function getPluginTheme(id: string): PluginTheme | undefined {
  return registry.get(id)
}

export function listPluginThemes(): PluginTheme[] {
  return Array.from(registry.values())
}

/** Test-only escape hatch. */
export function __resetThemeRegistryForTesting(): void {
  registry.clear()
}
