/**
 * The host's registry of plugin glance modules (ADR-0225 §6).
 *
 * One per renderer that runs plugins: the desktop main window (which builds
 * every glance snapshot, so the tray panel and paired phones read plugin
 * modules through it) and a standalone phone. Fed from two sides:
 *
 * - the plugin platform: declarations from `manifest.glanceModules[]` (the
 *   overlay bridge, applied on enable, dropped on disable) and from
 *   `ctx.glance.register`, data from `ctx.glance.update`;
 * - glance builds: which plugin entries are on screen right now, per build,
 *   so a plugin learns through `ctx.glance.onVisibilityChange` when it may
 *   stop computing (the same rule the host's own slices follow, §7).
 *
 * Everything a plugin hands over is sanitized on the way in
 * (`plugin-data.ts`), so what the snapshot carries is bounded by
 * construction.
 */

import { pluginEntryId, type GlancePluginEntryId } from "@/types/glance/layout"

import {
  GLANCE_PLUGIN_LIMITS,
  sanitizeGlancePluginData,
  sanitizeGlancePluginModuleDef,
  type GlancePluginModuleData,
  type GlancePluginModuleEntry,
} from "./plugin-data"

/** Why a declaration or an update was refused, for the plugin author. */
export class GlancePluginModuleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GlancePluginModuleError"
  }
}

export interface GlancePluginDataRecord {
  data: GlancePluginModuleData
  updatedAt: number
}

/** The plugin ids an entry id can carry (`parsePluginEntryId`). */
const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

type Listener = () => void
type VisibilityHandler = (visible: boolean) => void

export class GlancePluginModuleRegistry {
  private readonly modules = new Map<GlancePluginEntryId, GlancePluginModuleEntry>()
  private readonly data = new Map<GlancePluginEntryId, GlancePluginDataRecord>()
  /** On-screen entries per glance build; a module is visible in any of them. */
  private readonly onScreen = new Map<string, ReadonlySet<GlancePluginEntryId>>()
  private readonly visible = new Set<GlancePluginEntryId>()
  private readonly visibilityHandlers = new Map<GlancePluginEntryId, Set<VisibilityHandler>>()
  private readonly listeners = new Set<Listener>()
  private readonly visibilityListeners = new Set<Listener>()
  private version = 0
  private catalogCache: GlancePluginModuleEntry[] | null = null

  /**
   * Declare (or re-declare) a module. Re-declaring keeps its data. Throws a
   * `GlancePluginModuleError` for a declaration that cannot be one, or past
   * the per-plugin limit.
   */
  register(pluginId: string, raw: unknown): GlancePluginEntryId {
    if (!PLUGIN_ID.test(pluginId)) {
      throw new GlancePluginModuleError(`invalid plugin id "${pluginId}"`)
    }
    const def = sanitizeGlancePluginModuleDef(raw)
    if (!def) {
      throw new GlancePluginModuleError(
        "a glance module needs an id (letters, digits, . _ -) and a title"
      )
    }
    const entryId = pluginEntryId(pluginId, def.id)
    if (!this.modules.has(entryId)) {
      const count = this.countFor(pluginId)
      if (count >= GLANCE_PLUGIN_LIMITS.modulesPerPlugin) {
        throw new GlancePluginModuleError(
          `a plugin can declare at most ${GLANCE_PLUGIN_LIMITS.modulesPerPlugin} glance modules`
        )
      }
    }
    this.modules.set(entryId, { entryId, pluginId, def })
    this.changed()
    return entryId
  }

  /** Drop one module, its data and its visibility handlers. */
  unregister(entryId: GlancePluginEntryId): boolean {
    if (!this.modules.delete(entryId)) return false
    this.data.delete(entryId)
    this.visibilityHandlers.delete(entryId)
    this.changed()
    return true
  }

  /** Drop every module of a plugin (it was disabled or uninstalled). */
  unregisterAllByPlugin(pluginId: string): void {
    let dropped = false
    for (const [entryId, entry] of this.modules) {
      if (entry.pluginId !== pluginId) continue
      this.modules.delete(entryId)
      this.data.delete(entryId)
      this.visibilityHandlers.delete(entryId)
      dropped = true
    }
    if (dropped) this.changed()
  }

  /**
   * Publish data for a declared module, or clear it with null. Throws for a
   * module the plugin has not declared.
   */
  update(pluginId: string, moduleId: string, raw: unknown, now: number = Date.now()): void {
    const entryId = pluginEntryId(pluginId, moduleId)
    if (!this.modules.has(entryId)) {
      throw new GlancePluginModuleError(
        `glance module "${moduleId}" is not declared; declare it in glanceModules or with ctx.glance.register first`
      )
    }
    if (raw === null || raw === undefined) {
      if (this.data.delete(entryId)) this.changed()
      return
    }
    this.data.set(entryId, { data: sanitizeGlancePluginData(raw), updatedAt: now })
    this.changed()
  }

  /** Every declared module, in declaration order. Stable between changes. */
  catalog(): GlancePluginModuleEntry[] {
    this.catalogCache ??= [...this.modules.values()]
    return this.catalogCache
  }

  get(entryId: GlancePluginEntryId): GlancePluginModuleEntry | null {
    return this.modules.get(entryId) ?? null
  }

  dataOf(entryId: GlancePluginEntryId): GlancePluginDataRecord | null {
    return this.data.get(entryId) ?? null
  }

  /**
   * Report the plugin entries one glance build shows right now. An empty set
   * (or null) withdraws that build. Plugins whose modules came into or went
   * out of view across all builds are told.
   */
  setOnScreen(build: string, entries: Iterable<GlancePluginEntryId> | null): void {
    const next = entries ? new Set(entries) : null
    if (next && next.size > 0) this.onScreen.set(build, next)
    else this.onScreen.delete(build)
    const union = new Set<GlancePluginEntryId>()
    for (const set of this.onScreen.values()) for (const id of set) union.add(id)
    const flips: Array<[GlancePluginEntryId, boolean]> = []
    for (const id of this.visible) if (!union.has(id)) flips.push([id, false])
    for (const id of union) if (!this.visible.has(id)) flips.push([id, true])
    if (flips.length === 0) return
    this.visible.clear()
    for (const id of union) this.visible.add(id)
    for (const [id, on] of flips) {
      for (const handler of this.visibilityHandlers.get(id) ?? []) {
        try {
          handler(on)
        } catch {
          // A plugin's handler throwing must not stop the others hearing.
        }
      }
    }
    for (const listener of this.visibilityListeners) listener()
  }

  isVisible(entryId: GlancePluginEntryId): boolean {
    return this.visible.has(entryId)
  }

  /**
   * Hear when a module comes into or goes out of view. The handler is called
   * at once with the current state, so a plugin needs no second read.
   */
  onVisibilityChange(entryId: GlancePluginEntryId, handler: VisibilityHandler): () => void {
    let set = this.visibilityHandlers.get(entryId)
    if (!set) {
      set = new Set()
      this.visibilityHandlers.set(entryId, set)
    }
    set.add(handler)
    handler(this.visible.has(entryId))
    return () => {
      this.visibilityHandlers.get(entryId)?.delete(handler)
    }
  }

  /** Catalog or data changed. For `useSyncExternalStore`. */
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getVersion = (): number => this.version

  /**
   * Hear that some module's visibility flipped (read the new state with
   * `isVisible`). Visibility is not a catalog or data change, so `subscribe`
   * does not report it; the `onGlanceVisibilityChange` hook source needs both.
   */
  subscribeVisibility = (listener: Listener): (() => void) => {
    this.visibilityListeners.add(listener)
    return () => {
      this.visibilityListeners.delete(listener)
    }
  }

  private countFor(pluginId: string): number {
    let count = 0
    for (const entry of this.modules.values()) if (entry.pluginId === pluginId) count += 1
    return count
  }

  private changed(): void {
    this.version += 1
    this.catalogCache = null
    for (const listener of this.listeners) listener()
  }
}

/** The renderer's registry. */
export const glancePluginModules = new GlancePluginModuleRegistry()
