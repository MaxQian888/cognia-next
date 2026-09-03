// Theme-pack registry (v47 — ADR-0029).
//
// A theme pack is a single applyable bundle declared by a plugin under
// `manifest.themePacks`. Each pack references *other* contributions from
// the same plugin (theme id, font family, wallpaper id) — the registry
// here just stores the metadata + applies map; resolution into actual
// settings writes happens in `components/settings/appearance/components/theme-pack-applier.tsx`
// (P6).
//
// Mirrors `theme-registry.ts`'s shape so React consumers can drive the UI
// via `useSyncExternalStore` without bespoke wiring.

import type { PluginThemePackContribution } from "@/types/plugin/plugin"

export interface RegisteredThemePack extends PluginThemePackContribution {
  /** Owning plugin id; the registry namespaces packs by it. */
  pluginId: string
  /** Display label for "where did this pack come from?". */
  pluginName?: string
}

/**
 * The preview a pack's card may load, or `undefined` for one it must not.
 *
 * `preview` is plugin-authored text, and a card that hands it straight to an
 * `<img src>` will fetch whatever it says. An `https://` value there turns
 * opening the Appearance tab into an outbound request nobody agreed to: the
 * user's address, their user agent and the fact that this pack is installed,
 * once per render. Every other plugin-owned binary in this app is read through
 * the containment boundary (`readContainedPluginAsset`), and a preview image is
 * the same kind of thing.
 *
 * So exactly two forms load. A `data:image/…` URL is bytes the manifest already
 * carries. A path under `/plugins/<pluginId>/` is the plugin's own public
 * mirror, which is the shape `publicBuiltinAssetUrl` builds. Everything else is
 * dropped and the card simply draws without an image: a remote host, a `blob:`,
 * a peer plugin's mirror, or a traversal back out of one.
 */
export function themePackPreviewSrc(
  pluginId: string,
  candidate: string | undefined
): string | undefined {
  const value = candidate?.trim()
  if (!value) return undefined
  if (/^data:image\/[a-z0-9.+-]+[;,]/i.test(value)) return value
  const mirror = `/plugins/${encodeURIComponent(pluginId)}/`
  if (!value.startsWith(mirror)) return undefined
  // A `..` anywhere past the prefix walks back out of the plugin's own folder,
  // which is the one thing the prefix check alone would let through.
  const rest = value.slice(mirror.length)
  if (rest.length === 0) return undefined
  if (rest.split(/[/\\]/).includes("..")) return undefined
  return value
}

const registry = new Map<string, RegisteredThemePack>()
const listeners = new Set<() => void>()
let snapshot: RegisteredThemePack[] | null = null

function key(pluginId: string, packId: string): string {
  return `${pluginId}.${packId}`
}

function notify(): void {
  snapshot = null
  for (const fn of listeners) {
    try {
      fn()
    } catch (err) {
      console.warn("Theme-pack listener threw:", err)
    }
  }
}

export function registerThemePack(input: {
  pluginId: string
  pluginName?: string
  pack: PluginThemePackContribution
}): { replaced: boolean } {
  if (!input.pack.id) throw new Error("registerThemePack: id is required")
  const id = key(input.pluginId, input.pack.id)
  const replaced = registry.has(id)
  registry.set(id, {
    ...input.pack,
    pluginId: input.pluginId,
    pluginName: input.pluginName,
  })
  notify()
  return { replaced }
}

export function unregisterThemePack(pluginId: string, packId: string): boolean {
  const removed = registry.delete(key(pluginId, packId))
  if (removed) notify()
  return removed
}

export function unregisterThemePacksByPlugin(pluginId: string): number {
  let removed = 0
  for (const [k, pack] of registry) {
    if (pack.pluginId === pluginId) {
      registry.delete(k)
      removed += 1
    }
  }
  if (removed > 0) notify()
  return removed
}

export function listThemePacks(): RegisteredThemePack[] {
  if (!snapshot) snapshot = [...registry.values()]
  return snapshot
}

export function getThemePack(pluginId: string, packId: string): RegisteredThemePack | undefined {
  return registry.get(key(pluginId, packId))
}

/**
 * Every registered pack's canonical `"<pluginId>.<packId>"` key.
 *
 * This is exactly the format a Character Pack's `requires.themePacks` uses —
 * the registry's internal Map key already had the right shape, so no new state
 * is needed to answer "is theme pack X available".
 */
export function listThemePackKeys(): string[] {
  return [...registry.keys()]
}

/** True when `"<pluginId>.<packId>"` names a registered theme pack. */
export function hasThemePackKey(packKey: string): boolean {
  return registry.has(packKey)
}

export function subscribeThemePackRegistry(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test-only: drop everything. */
export function __resetThemePackRegistryForTesting(): void {
  registry.clear()
  listeners.clear()
  snapshot = null
}
