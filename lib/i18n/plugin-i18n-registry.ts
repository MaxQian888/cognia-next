// Plugin i18n overlay registry.
//
// next-intl loads message bundles statically from `i18n/messages/*.json`.
// Plugins ship their own translation strings without rebuilding the app,
// so this registry overlays plugin-contributed messages on top of the
// statically-loaded bundle. The chat UI / settings UI consumes through the
// regular `useTranslations()` hook; the overlay merges in via the
// `<LocaleGate>` provider (`components/providers/locale-gate.tsx`) which
// subscribes to this registry through `useSyncExternalStore`.
//
// Key convention: plugins ship flat dot-notation keys under their own
// namespace (e.g. `panel.title`). The plugin manager prefixes them with
// `plugin.<pluginId>.` before calling `registerPluginI18n`, so the merged
// host bundle exposes them as `plugin.<pluginId>.panel.title` — plugins
// cannot collide with each other or the host namespace.

export type LocaleCode = string

/**
 * One plugin's message contribution: a per-locale flat string map. Nested
 * paths use dot notation (e.g., `"plugin.git.tools.status.label"`).
 */
export interface PluginI18nBundle {
  /** Plugin id contributing the messages. */
  pluginId: string
  /** Map of locale code → flat string map. */
  messages: Partial<Record<LocaleCode, Record<string, string>>>
}

const bundles = new Map<string, PluginI18nBundle>()
const listeners = new Set<() => void>()
let version = 0

function emit(): void {
  version += 1
  for (const fn of listeners) {
    try {
      fn()
    } catch {
      // Listener errors must not break notification for the rest of the
      // subscriber set.
    }
  }
}

export function registerPluginI18n(bundle: PluginI18nBundle): { replaced: boolean } {
  if (!bundle.pluginId) throw new Error("registerPluginI18n: pluginId is required")
  const replaced = bundles.has(bundle.pluginId)
  bundles.set(bundle.pluginId, bundle)
  emit()
  return { replaced }
}

export function unregisterPluginI18n(pluginId: string): boolean {
  const removed = bundles.delete(pluginId)
  if (removed) emit()
  return removed
}

export function getPluginI18nBundle(pluginId: string): PluginI18nBundle | undefined {
  return bundles.get(pluginId)
}

/**
 * Flatten every registered plugin bundle into a single locale → key → value
 * record. Used by the next-intl provider overlay (LocaleGate) to merge
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

/**
 * Subscribe to register/unregister events. Returns an unsubscribe function.
 * Drives `useSyncExternalStore` in `LocaleGate` so the provider re-renders
 * with the merged messages whenever a plugin enables or disables.
 */
export function subscribeToPluginI18n(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/**
 * Monotonically increasing version counter — bumped on every register /
 * unregister. Use as the `getSnapshot` for `useSyncExternalStore` so React
 * sees a new primitive value whenever the registry changes.
 */
export function getPluginI18nSnapshot(): number {
  return version
}

/**
 * Build the nested-object shape `next-intl` expects from the flat
 * dot-notation strings the registry stores. `next-intl`'s
 * `NextIntlClientProvider` merges nested objects naturally; flat keys with
 * dots in them get treated as a single key (which doesn't resolve).
 *
 * Example: `{ "panel.title": "Hi" }` → `{ panel: { title: "Hi" } }`.
 *
 * Exported so the LocaleGate provider can apply it once per render alongside
 * the host bundle.
 */
export function inflateFlatKeys(flat: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(flat)) {
    const segments = key.split(".")
    let cursor: Record<string, unknown> = out
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]
      const existing = cursor[seg]
      if (existing && typeof existing === "object" && !Array.isArray(existing)) {
        cursor = existing as Record<string, unknown>
      } else {
        const next: Record<string, unknown> = {}
        cursor[seg] = next
        cursor = next
      }
    }
    cursor[segments[segments.length - 1]] = value
  }
  return out
}

/** Test-only escape hatch. */
export function __resetPluginI18nForTesting(): void {
  bundles.clear()
  listeners.clear()
  version = 0
}
