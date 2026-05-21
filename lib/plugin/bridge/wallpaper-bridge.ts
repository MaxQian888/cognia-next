/**
 * Plugin wallpaper bridge — ADR-0029.
 *
 * Registers `PluginWallpaperContribution` entries in an in-memory registry
 * so the wallpaper picker can surface them alongside user-uploaded and
 * built-in wallpapers without touching the Dexie `settings` row. Unlike the
 * themes-bridge, this never writes user data — disabling a plugin must not
 * lose user-uploaded wallpapers, and re-enabling must not duplicate the
 * plugin's contributions.
 *
 * The bridge only handles bundled sources (image with `relPath`, gradient,
 * or color). The path resolver supplied by the caller turns the relative
 * `relPath` into a URL the browser can load. For Tauri this is
 * `convertFileSrc(absolutePath)`; in web mode plugins typically ship
 * gradients/colors only, so the resolver is rarely invoked.
 *
 * Idempotent: re-applying a plugin's contributions clears the previous set
 * first. `revertPluginWallpapers` is safe to call without a prior apply.
 */

import type { PluginWallpaperContribution } from "@/types/plugin/plugin"
import type { Wallpaper } from "@/types/appearance"

/** Function signature matching the font-bridge's resolver. */
export type WallpaperAssetResolver = (pluginRoot: string, relPath: string) => string

/**
 * One registered plugin wallpaper. Mirrors `Wallpaper` so consumers can
 * concat the registry with `useSettingsStore.wallpapers` and treat the
 * combined list uniformly.
 */
export interface RegisteredPluginWallpaper extends Wallpaper {
  pluginId: string
  /** Plugin contribution id (without the plugin namespace). */
  contributionId: string
}

const registry = new Map<string, RegisteredPluginWallpaper>()
const listeners = new Set<() => void>()
let snapshot: RegisteredPluginWallpaper[] | null = null

function key(pluginId: string, contributionId: string): string {
  return `${pluginId}:${contributionId}`
}

function notify(): void {
  snapshot = null
  for (const fn of listeners) {
    try {
      fn()
    } catch (err) {
      console.warn("Wallpaper bridge listener threw:", err)
    }
  }
}

/**
 * Convert a manifest contribution into the standard `Wallpaper` shape.
 * Pure — exported for tests. Throws on inputs that violate the contract
 * (missing id/name, unrecognised source kind).
 */
export function contributionToWallpaper(input: {
  pluginId: string
  contribution: PluginWallpaperContribution
  resolveAsset: WallpaperAssetResolver
  pluginRoot: string
}): RegisteredPluginWallpaper {
  const { contribution, pluginId, resolveAsset, pluginRoot } = input
  if (!contribution.id || !contribution.name) {
    throw new Error("Wallpaper contribution missing id or name")
  }
  const id = `plugin-${pluginId}-${contribution.id}`
  if (contribution.source.kind === "gradient") {
    return {
      id,
      name: contribution.name,
      kind: "gradient",
      source: { kind: "gradient", css: contribution.source.css },
      builtin: true,
      createdAt: 0,
      pluginId,
      contributionId: contribution.id,
    }
  }
  if (contribution.source.kind === "color") {
    return {
      id,
      name: contribution.name,
      kind: "color",
      source: { kind: "color", value: contribution.source.value },
      builtin: true,
      createdAt: 0,
      pluginId,
      contributionId: contribution.id,
    }
  }
  // Image source — resolve the relPath via the supplied resolver.
  const resolvedUrl = resolveAsset(pluginRoot, contribution.source.relPath)
  return {
    id,
    name: contribution.name,
    kind: "image",
    source: {
      kind: "image",
      // We use the `data-url` variant as a transport for "any browser-loadable
      // URL"; `resolveSourceToCss` reads the field as-is. Strictly the
      // discriminated union expects a `data:` prefix, but in practice the
      // appearance pipeline accepts anything CSS `url()` accepts.
      storage: "data-url",
      dataUrl: resolvedUrl,
      mime: contribution.source.mime,
      width: contribution.source.width,
      height: contribution.source.height,
    },
    builtin: true,
    createdAt: 0,
    pluginId,
    contributionId: contribution.id,
  }
}

export interface ApplyPluginWallpapersArgs {
  pluginId: string
  pluginRoot: string
  wallpapers: PluginWallpaperContribution[]
  resolveAsset: WallpaperAssetResolver
}

export interface ApplyPluginWallpapersResult {
  registered: string[]
  rejected: Array<{ contributionId: string; reason: string }>
}

/**
 * Apply (register) every wallpaper contribution from a plugin. Replaces the
 * existing set for this plugin atomically — there is no half-applied state
 * because the registry mutations are synchronous.
 */
export function applyPluginWallpapers(
  args: ApplyPluginWallpapersArgs
): ApplyPluginWallpapersResult {
  // Clear the previous set first to keep apply idempotent.
  revertPluginWallpapers(args.pluginId, { silent: true })

  const registered: string[] = []
  const rejected: Array<{ contributionId: string; reason: string }> = []
  for (const contribution of args.wallpapers) {
    try {
      const wp = contributionToWallpaper({
        pluginId: args.pluginId,
        contribution,
        resolveAsset: args.resolveAsset,
        pluginRoot: args.pluginRoot,
      })
      registry.set(key(args.pluginId, wp.contributionId), wp)
      registered.push(wp.id)
    } catch (err) {
      rejected.push({
        contributionId: (contribution as { id?: string }).id ?? "<unknown>",
        reason: (err as Error).message ?? String(err),
      })
    }
  }
  if (registered.length > 0 || rejected.length === 0) notify()
  return { registered, rejected }
}

/**
 * Remove every wallpaper contribution from `pluginId`. Returns the number
 * removed. `silent: true` skips the listener notification — used internally
 * by `applyPluginWallpapers` to avoid double-firing on re-apply.
 */
export function revertPluginWallpapers(
  pluginId: string,
  options: { silent?: boolean } = {}
): number {
  let removed = 0
  for (const [k, wp] of registry) {
    if (wp.pluginId === pluginId) {
      registry.delete(k)
      removed += 1
    }
  }
  if (removed > 0 && !options.silent) notify()
  return removed
}

/** Snapshot of every plugin-contributed wallpaper. Stable identity. */
export function listPluginWallpapers(): RegisteredPluginWallpaper[] {
  if (!snapshot) snapshot = [...registry.values()]
  return snapshot
}

export function subscribePluginWallpapers(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test-only reset. */
export function __resetPluginWallpapersForTesting(): void {
  registry.clear()
  listeners.clear()
  snapshot = null
}
