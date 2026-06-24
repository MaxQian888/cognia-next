// Cross-source font registry — surfaces every CSS font family that callers
// (typography settings UI, plugin theme packs, custom themes) may reference.
// Three independent sources are merged on read:
//
//   1. **Web-safe** — generic + commonly-available system families. Always
//      visible, never removed. Curated so the picker has a stable baseline.
//   2. **System** — families enumerated by the host (Tauri exposes `os.list_fonts`
//      on a permitted command; web mode returns an empty list). Pushed in once
//      at boot via `setSystemFonts`.
//   3. **Plugin** — families registered by `lib/plugin/bridge/font-bridge.ts`
//      when a plugin is enabled. Cleared on disable.
//
// Storage is in-memory only. The list is cheap to recompute, and we don't
// want fonts surviving plugin unload. `useSyncExternalStore`-style subscribe
// keeps React components in sync without forcing a Zustand entry.

export type FontSource = "system" | "plugin" | "websafe"

export interface FontEntry {
  /** CSS family name as written in `font-family: ...`. */
  family: string
  source: FontSource
  /** Set when `source === "plugin"`. Plugin that contributed the family. */
  pluginId?: string
  /** Optional human label distinct from the CSS name (e.g. "Inter (Plugin)"). */
  label?: string
  /**
   * Fixed-pitch? Set for `source === "system"` families enumerated by the
   * host (`os_list_fonts`). Drives the picker's `monoOnly` filter so the
   * terminal font picker shows only monospace families. `undefined` when
   * unknown (web mode, plugin / web-safe entries).
   */
  monospaced?: boolean
}

/** System font as reported by the host enumeration command. */
export interface SystemFontInfo {
  family: string
  monospaced?: boolean
}

const WEBSAFE_ENTRIES: FontEntry[] = [
  { family: "system-ui", source: "websafe", label: "System UI" },
  { family: "ui-sans-serif", source: "websafe", label: "UI sans-serif" },
  { family: "ui-serif", source: "websafe", label: "UI serif" },
  { family: "ui-monospace", source: "websafe", label: "UI monospace" },
  { family: "Arial", source: "websafe" },
  { family: "Helvetica", source: "websafe" },
  { family: "Georgia", source: "websafe" },
  { family: "Times New Roman", source: "websafe" },
  { family: "Courier New", source: "websafe" },
  { family: "monospace", source: "websafe" },
  { family: "sans-serif", source: "websafe" },
  { family: "serif", source: "websafe" },
]

/** System families pushed in by Tauri command (or empty in web mode). */
let systemFamilies: SystemFontInfo[] = []

interface PluginFontKey {
  family: string
  pluginId: string
}

/** Plugin-contributed families. Keyed by `${pluginId}:${family}` for fast dedupe. */
const pluginFonts = new Map<string, PluginFontKey>()

const listeners = new Set<() => void>()

function emit(): void {
  for (const fn of listeners) {
    try {
      fn()
    } catch (err) {
      console.warn("Font registry listener threw:", err)
    }
  }
}

/**
 * Replace the system family list. Accepts plain family strings (legacy /
 * web-safe callers) or `{ family, monospaced }` records from the host
 * enumeration. Deduped by family (monospaced OR-reduced), sorted, and
 * idempotent — passing an equivalent list twice doesn't re-emit. Usually
 * called once at boot from the `os_list_fonts` command.
 */
export function setSystemFonts(families: ReadonlyArray<string | SystemFontInfo>): void {
  const merged = new Map<string, boolean>()
  for (const entry of families) {
    const family = (typeof entry === "string" ? entry : entry.family).trim()
    if (!family) continue
    const mono = typeof entry === "string" ? false : entry.monospaced === true
    merged.set(family, (merged.get(family) ?? false) || mono)
  }
  const next: SystemFontInfo[] = [...merged.entries()]
    .map(([family, monospaced]) => ({ family, monospaced }))
    .sort((a, b) => a.family.localeCompare(b.family))
  const unchanged =
    next.length === systemFamilies.length &&
    next.every(
      (f, i) =>
        f.family === systemFamilies[i].family && f.monospaced === systemFamilies[i].monospaced
    )
  if (unchanged) return
  systemFamilies = next
  emit()
}

/** Register a single plugin-contributed family. */
export function registerPluginFont(pluginId: string, family: string): void {
  const trimmed = family.trim()
  if (!trimmed) return
  const key = `${pluginId}:${trimmed}`
  if (pluginFonts.has(key)) return
  pluginFonts.set(key, { pluginId, family: trimmed })
  emit()
}

/** Remove every plugin-contributed family owned by `pluginId`. */
export function unregisterPluginFontsByPlugin(pluginId: string): number {
  let removed = 0
  for (const [key, value] of pluginFonts) {
    if (value.pluginId === pluginId) {
      pluginFonts.delete(key)
      removed += 1
    }
  }
  if (removed > 0) emit()
  return removed
}

/**
 * Snapshot of every font visible to the UI right now. Sorted: web-safe first,
 * then system, then plugin (alphabetical within each group). Stable identity
 * across calls when nothing has changed, which `useSyncExternalStore`
 * implementations can take advantage of.
 */
let cachedSnapshot: FontEntry[] | null = null
function invalidateCache(): void {
  cachedSnapshot = null
}
// Wire the invalidation in: every emit ALSO resets the cache.
listeners.add(invalidateCache)

export function listFonts(): FontEntry[] {
  if (cachedSnapshot) return cachedSnapshot
  const system: FontEntry[] = systemFamilies.map((f) => ({
    family: f.family,
    source: "system",
    monospaced: f.monospaced,
  }))
  const plugins: FontEntry[] = [...pluginFonts.values()]
    .map((value) => ({
      family: value.family,
      source: "plugin" as const,
      pluginId: value.pluginId,
    }))
    .sort((a, b) => a.family.localeCompare(b.family))
  cachedSnapshot = [...WEBSAFE_ENTRIES, ...system, ...plugins]
  return cachedSnapshot
}

/** Subscribe to changes. Returns an unsubscribe. */
export function subscribeFonts(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Hook-friendly snapshot for `useSyncExternalStore`. */
export function fontRegistrySnapshot(): readonly FontEntry[] {
  return listFonts()
}

/** Lookup a single entry by family name. First match wins. */
export function findFont(family: string): FontEntry | undefined {
  return listFonts().find((entry) => entry.family === family)
}

/** Exposed for tests. */
export function __resetFontRegistryForTesting(): void {
  systemFamilies = []
  pluginFonts.clear()
  invalidateCache()
  // Leave the cache invalidator listener in place; remove user listeners only.
  for (const fn of [...listeners]) {
    if (fn !== invalidateCache) listeners.delete(fn)
  }
}
