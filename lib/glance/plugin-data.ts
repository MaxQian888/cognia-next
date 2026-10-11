/**
 * Plugin glance modules as data (ADR-0225 §6).
 *
 * A plugin contributes a module by declaring it (`manifest.glanceModules[]` or
 * `ctx.glance.register`) and publishing data for it (`ctx.glance.update`). It
 * never ships React into a glance surface: the tray panel is a separate
 * webview, a phone may be rendering the desktop's snapshot, and the style
 * must not fork. The host renders the data with the same primitives as its
 * own modules.
 *
 * Everything a plugin hands over passes through here first. The shapes are
 * closed, strings are capped and counts are bounded, because the data rides
 * in `GlanceSnapshotV1` to other windows and to paired phones: a plugin must
 * not be able to grow the snapshot without bound or smuggle anything but
 * short labels into it.
 */

import {
  GLANCE_MODULE_SIZES,
  type GlanceModuleSize,
  type GlancePluginEntryId,
} from "@/types/glance/layout"

import type { GlancePlatform } from "./registry"

/** Text colours a plugin may use, the host modules' own vocabulary. */
export type GlancePluginTone = "default" | "ok" | "warn" | "crit" | "muted"
export const GLANCE_PLUGIN_TONES: readonly GlancePluginTone[] = [
  "default",
  "ok",
  "warn",
  "crit",
  "muted",
]

/** One number + caption of the stats strip. */
export interface GlancePluginStat {
  label: string
  value: string
  tone?: GlancePluginTone
}

/** One row. `action` names one of the module's actions, run on click. */
export interface GlancePluginRow {
  id: string
  label: string
  value?: string
  hint?: string
  tone?: GlancePluginTone
  action?: string
}

/** One button, bound to one of the plugin's own commands. */
export interface GlancePluginAction {
  id: string
  label: string
  /** lucide icon name (`ExternalLink`, or legacy `external-link`). */
  icon?: string
  /** The plugin's command id, without its plugin prefix. */
  command: string
}

/** What `ctx.glance.update` publishes for one module. */
export interface GlancePluginModuleData {
  stats?: GlancePluginStat[]
  rows?: GlancePluginRow[]
  actions?: GlancePluginAction[]
  /** One line for the compact size; defaults to the first stat. */
  summary?: string
  /** Shown when there are no stats and no rows. */
  empty?: string
}

/** A module declaration, from the manifest or `ctx.glance.register`. */
export interface GlancePluginModuleDef {
  /** Unique within the plugin. */
  id: string
  /** Literal title, the fallback for `titleKey`. */
  title: string
  /** Plugin i18n key, resolved against the plugin's own bundle. */
  titleKey?: string
  /** lucide icon name (`GitBranch`, or legacy `git-branch`). */
  icon?: string
  /** Sizes it renders, smallest first. Defaults to compact + standard. */
  sizes?: GlanceModuleSize[]
  /** Surfaces it renders on. Defaults to both. */
  platforms?: GlancePlatform[]
}

/* ── Limits ──────────────────────────────────────────────────────────── */

export const GLANCE_PLUGIN_LIMITS = {
  /** Modules one plugin may declare. */
  modulesPerPlugin: 8,
  stats: 4,
  rows: 8,
  actions: 3,
  title: 48,
  label: 48,
  value: 24,
  hint: 80,
  summary: 80,
  empty: 120,
  id: 64,
  icon: 48,
} as const

/** Local ids: what a module, row, action or command id may look like. */
const LOCAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function isGlancePluginLocalId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= GLANCE_PLUGIN_LIMITS.id && LOCAL_ID.test(value)
  )
}

/** Trim, collapse whitespace and cap; null when nothing is left. */
function cap(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null
  const text = value.replace(/\s+/g, " ").trim()
  if (!text) return null
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function tone(value: unknown): GlancePluginTone | undefined {
  return GLANCE_PLUGIN_TONES.includes(value as GlancePluginTone)
    ? (value as GlancePluginTone)
    : undefined
}

/**
 * A lucide icon name: the exported PascalCase name the plugin manifest
 * contract asks for (`Activity`), or the legacy kebab-case one (`activity`).
 * Renderers resolve both through `resolveIcon`.
 */
function icon(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9-]{0,47}$/.test(value) ? value : undefined
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * Clean a declaration. Null when it cannot be one (no valid id, no title):
 * a module that cannot be named cannot be offered.
 */
export function sanitizeGlancePluginModuleDef(raw: unknown): GlancePluginModuleDef | null {
  if (typeof raw !== "object" || raw === null) return null
  const v = raw as Record<string, unknown>
  if (!isGlancePluginLocalId(v.id)) return null
  const title = cap(v.title, GLANCE_PLUGIN_LIMITS.title)
  if (!title) return null
  const sizes = GLANCE_MODULE_SIZES.filter((size) => list(v.sizes).includes(size))
  const platforms = (["desktop", "mobile"] as const).filter((p) => list(v.platforms).includes(p))
  const out: GlancePluginModuleDef = {
    id: v.id,
    title,
    sizes: sizes.length > 0 ? sizes : ["compact", "standard"],
    platforms: platforms.length > 0 ? platforms : ["desktop", "mobile"],
  }
  if (typeof v.titleKey === "string" && v.titleKey.length > 0 && v.titleKey.length <= 128) {
    out.titleKey = v.titleKey
  }
  const ic = icon(v.icon)
  if (ic) out.icon = ic
  return out
}

/**
 * Clean published data: unknown fields dropped, strings capped, lists
 * bounded, rows pointing at an action that does not exist lose the pointer.
 */
export function sanitizeGlancePluginData(raw: unknown): GlancePluginModuleData {
  if (typeof raw !== "object" || raw === null) return {}
  const v = raw as Record<string, unknown>
  const out: GlancePluginModuleData = {}

  const actions: GlancePluginAction[] = []
  const actionIds = new Set<string>()
  for (const item of list(v.actions)) {
    if (actions.length >= GLANCE_PLUGIN_LIMITS.actions) break
    if (typeof item !== "object" || item === null) continue
    const a = item as Record<string, unknown>
    const label = cap(a.label, GLANCE_PLUGIN_LIMITS.label)
    if (!isGlancePluginLocalId(a.id) || !label || !isGlancePluginLocalId(a.command)) continue
    if (actionIds.has(a.id)) continue
    actionIds.add(a.id)
    const action: GlancePluginAction = { id: a.id, label, command: a.command }
    const ic = icon(a.icon)
    if (ic) action.icon = ic
    actions.push(action)
  }

  const stats: GlancePluginStat[] = []
  for (const item of list(v.stats)) {
    if (stats.length >= GLANCE_PLUGIN_LIMITS.stats) break
    if (typeof item !== "object" || item === null) continue
    const s = item as Record<string, unknown>
    const label = cap(s.label, GLANCE_PLUGIN_LIMITS.label)
    const value = cap(s.value, GLANCE_PLUGIN_LIMITS.value)
    if (!label || !value) continue
    const stat: GlancePluginStat = { label, value }
    const t = tone(s.tone)
    if (t) stat.tone = t
    stats.push(stat)
  }

  const rows: GlancePluginRow[] = []
  const rowIds = new Set<string>()
  for (const item of list(v.rows)) {
    if (rows.length >= GLANCE_PLUGIN_LIMITS.rows) break
    if (typeof item !== "object" || item === null) continue
    const r = item as Record<string, unknown>
    const label = cap(r.label, GLANCE_PLUGIN_LIMITS.label)
    if (!isGlancePluginLocalId(r.id) || !label || rowIds.has(r.id)) continue
    rowIds.add(r.id)
    const row: GlancePluginRow = { id: r.id, label }
    const value = cap(r.value, GLANCE_PLUGIN_LIMITS.value)
    if (value) row.value = value
    const hint = cap(r.hint, GLANCE_PLUGIN_LIMITS.hint)
    if (hint) row.hint = hint
    const t = tone(r.tone)
    if (t) row.tone = t
    if (typeof r.action === "string" && actionIds.has(r.action)) row.action = r.action
    rows.push(row)
  }

  if (stats.length > 0) out.stats = stats
  if (rows.length > 0) out.rows = rows
  if (actions.length > 0) out.actions = actions
  const summary = cap(v.summary, GLANCE_PLUGIN_LIMITS.summary)
  if (summary) out.summary = summary
  const empty = cap(v.empty, GLANCE_PLUGIN_LIMITS.empty)
  if (empty) out.empty = empty
  return out
}

/** The command an action names, as the host registers it: `<pluginId>.<command>`. */
export function glancePluginCommandId(pluginId: string, command: string): string {
  return `${pluginId}.${command}`
}

/** A plugin module as glance surfaces see it: its declaration, resolved. */
export interface GlancePluginModuleEntry {
  entryId: GlancePluginEntryId
  pluginId: string
  def: GlancePluginModuleDef
}
