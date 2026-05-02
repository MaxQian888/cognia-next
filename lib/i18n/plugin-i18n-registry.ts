// Plugin i18n overlay registry (§E new module).
//
// next-intl loads message bundles statically from `i18n/messages/*.json`.
// Plugins want to ship their own translation strings without rebuilding the
// app, so this registry overlays plugin-contributed messages on top of the
// statically-loaded bundle. The chat UI / settings UI consumes through the
// regular `useTranslations()` hook; the overlay merges in via a custom
// message provider (separate concern, wired in Phase 5 settings).
//
// Until the next-intl provider integration lands, this registry is a pure
// in-memory map plus accessors so plugin code compiles. Nothing that
// renders today consults it, so registering plugin messages is a no-op
// effect on the user-visible UI — that's intentional for Phase 2.

export type LocaleCode = string

/**
 * One plugin's message contribution: a per-locale flat string map. Nested
 * paths use dot notation (e.g., `"plugins.git.tools.status.label"`).
 */
export interface PluginI18nBundle {
  /** Plugin id contributing the messages. */
  pluginId: string
  /** Map of locale code → flat string map. */
  messages: Partial<Record<LocaleCode, Record<string, string>>>
}

const bundles = new Map<string, PluginI18nBundle>()

export function registerPluginI18n(bundle: PluginI18nBundle): { replaced: boolean } {
  if (!bundle.pluginId) throw new Error("registerPluginI18n: pluginId is required")
  const replaced = bundles.has(bundle.pluginId)
  bundles.set(bundle.pluginId, bundle)
  return { replaced }
}

export function unregisterPluginI18n(pluginId: string): boolean {
  return bundles.delete(pluginId)
}

export function getPluginI18nBundle(pluginId: string): PluginI18nBundle | undefined {
  return bundles.get(pluginId)
}

/**
 * Flatten every registered plugin bundle into a single locale → key → value
 * record. Used by the next-intl provider overlay (when wired) to merge
 * plugin messages into the host bundle.
 */
export function getMergedPluginMessages(): Record<LocaleCode, Record<string, string>> {
  const merged: Record<LocaleCode, Record<string, string>> = {}
  for (const bundle of bundles.values()) {
    for (const [locale, dict] of Object.entries(bundle.messages)) {
      if (!dict) continue
      merged[locale] = { ...(merged[locale] ?? {}), ...dict }
    }
  }
  return merged
}

/** Look up a single key for a locale. Returns undefined when no plugin
 * provides the key — let the next-intl host handle fallback. */
export function lookupPluginMessage(locale: LocaleCode, key: string): string | undefined {
  for (const bundle of bundles.values()) {
    const dict = bundle.messages[locale]
    if (dict && key in dict) return dict[key]
  }
  return undefined
}

/** Test-only escape hatch. */
export function __resetPluginI18nForTesting(): void {
  bundles.clear()
}
