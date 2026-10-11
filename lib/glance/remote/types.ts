/**
 * The payloads a paired phone and the desktop exchange for glance
 * (ADR-0225 §7, §9), and the strict readers for each.
 *
 * A phone renders its OWN layout, which the desktop never stores. What it
 * sends is a demand: the modules it wants slices for and the options those
 * slices depend on (usage scope, spend, activity range, workspace filter).
 * The desktop builds slices for that demand and nothing else. The phone's
 * layout order, sizes and home pins never cross the wire, because nothing on
 * the desktop needs them.
 *
 * Only subjects a phone cannot answer itself are asked for: Fleet (the
 * island's projection lives in desktop memory), usage and activity
 * (`sessionUsage`), quota (`providerLimits` and the unlocked vault), the
 * agenda (scheduled tasks, notifications) and the pet (its profile syncs, but
 * whether the pet is on is a desktop-only setting). Recents and the quick
 * module are built on the phone from synced rows and its own settings.
 *
 * Plugin modules (ADR-0225 §6) are the desktop's too: a paired phone renders
 * the desktop's plugins, read-only. The demand names their entries, and asks
 * for the desktop's plugin catalogue while the phone's editor is open.
 */

import {
  GLANCE_ACTIVITY_RANGES,
  GLANCE_MAX_PLUGIN_ENTRIES,
  isPluginEntryId,
  type GlanceActivityRange,
  type GlanceEntryId,
  type GlancePluginEntryId,
  type GlanceScope,
  type GlanceUsageScope,
} from "@/types/glance/layout"

/** The modules whose slices a phone takes from the desktop. */
export const GLANCE_HOST_MODULES = ["fleet", "usage", "quota", "agenda", "activity", "pet"] as const

export type GlanceHostModuleId = (typeof GLANCE_HOST_MODULES)[number]

export function isGlanceHostModule(id: string): id is GlanceHostModuleId {
  return (GLANCE_HOST_MODULES as readonly string[]).includes(id)
}

/** What a paired phone asks the desktop for: a host-sourced module or a plugin module. */
export type GlanceHostEntryId = GlanceHostModuleId | GlancePluginEntryId

/** True for an entry a paired phone takes from the desktop. */
export function isGlanceHostEntry(id: GlanceEntryId | string): id is GlanceHostEntryId {
  return isGlanceHostModule(id) || isPluginEntryId(id)
}

export interface GlanceRemoteDemand {
  /** Host-sourced modules and plugin entries the phone shows, deduplicated. */
  modules: GlanceHostEntryId[]
  /**
   * The phone's layout editor is open and needs the desktop's plugin
   * catalogue, even if nothing host-sourced is on screen.
   */
  catalog: boolean
  scope: GlanceScope
  /** The workspace the phone is filtering to, when `scope` is `workspace`. */
  workspaceId: string | null
  usage: { scope: GlanceUsageScope; showSpend: boolean }
  activity: { range: GlanceActivityRange }
}

/** Phone → desktop, `glance_subscribe`. */
export interface GlanceSubscribePayload {
  /** One id per phone app instance; a lease is keyed on it. */
  consumer: string
  /** False ends the lease. */
  visible: boolean
  demand: GlanceRemoteDemand
}

/**
 * Why the desktop refused a call:
 *
 * - `headless_host`: the call reached a headless brain, which builds no
 *   glance (it has no main window). The phone treats the host as not serving
 *   glance.
 * - `glance_unavailable`: the desktop's publisher is not running (no main
 *   window yet, or it is reloading). Retried on the next renewal.
 * - `glance_invalid_request`: the payload failed its reader.
 * - any `errors.*` key under the `glance` namespace: the request ran and
 *   failed, with the same message the desktop panel would show.
 */
export type GlanceRemoteRefused = { ok: false; code: string }

export function glanceRefused(code: string): GlanceRemoteRefused {
  return { ok: false, code }
}

/** Desktop → phone, `glance_subscribe`. */
export type GlanceSubscribeResponse =
  | {
      ok: true
      /** The newest snapshot for the merged demand, or null while the first is still building. */
      snapshot: unknown
      /** Renew well before this many ms pass. */
      ttlMs: number
    }
  | GlanceRemoteRefused

/** Phone → desktop, `glance_request`. */
export type GlanceRemoteRequestPayload =
  { consumer: string; kind: "refresh" } | { consumer: string; kind: "quota-refresh"; key: string }

/** Phone → desktop, `glance_quota_enable`. */
export interface GlanceQuotaEnablePayload {
  provider: string
  accountId: string
}

/** Desktop → phone for both requests. */
export type GlanceRemoteResult = { ok: true } | GlanceRemoteRefused

const ID_MAX = 128
const KEY_MAX = 300

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isId(value: unknown, max = ID_MAX): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
}

/** Read a demand strictly. Unknown modules fail the whole demand rather than being dropped silently. */
export function parseGlanceDemand(raw: unknown): GlanceRemoteDemand | null {
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.modules) ||
    raw.modules.length > (GLANCE_HOST_MODULES.length + GLANCE_MAX_PLUGIN_ENTRIES) * 2
  )
    return null
  const modules: GlanceHostEntryId[] = []
  let plugins = 0
  for (const id of raw.modules) {
    if (typeof id !== "string" || !isGlanceHostEntry(id)) return null
    if (modules.includes(id)) continue
    if (isPluginEntryId(id) && ++plugins > GLANCE_MAX_PLUGIN_ENTRIES) return null
    modules.push(id)
  }
  if (raw.catalog !== undefined && typeof raw.catalog !== "boolean") return null
  if (raw.scope !== "all" && raw.scope !== "workspace") return null
  if (raw.workspaceId !== null && !isId(raw.workspaceId)) return null
  if (!isRecord(raw.usage) || !isRecord(raw.activity)) return null
  const usageScope = raw.usage.scope
  if (usageScope !== "cognia" && usageScope !== "all-tools") return null
  if (typeof raw.usage.showSpend !== "boolean") return null
  const range = raw.activity.range
  if (typeof range !== "string" || !(GLANCE_ACTIVITY_RANGES as readonly string[]).includes(range))
    return null
  return {
    modules,
    catalog: raw.catalog === true,
    scope: raw.scope,
    workspaceId: raw.scope === "workspace" ? (raw.workspaceId as string | null) : null,
    usage: { scope: usageScope, showSpend: raw.usage.showSpend },
    activity: { range: range as GlanceActivityRange },
  }
}

export function parseGlanceSubscribePayload(raw: unknown): GlanceSubscribePayload | null {
  if (!isRecord(raw) || !isId(raw.consumer, 64) || typeof raw.visible !== "boolean") return null
  const demand = parseGlanceDemand(raw.demand)
  if (!demand) return null
  return { consumer: raw.consumer, visible: raw.visible, demand }
}

export function parseGlanceRemoteRequestPayload(raw: unknown): GlanceRemoteRequestPayload | null {
  if (!isRecord(raw) || !isId(raw.consumer, 64)) return null
  if (raw.kind === "refresh") return { consumer: raw.consumer, kind: "refresh" }
  if (raw.kind === "quota-refresh" && isId(raw.key, KEY_MAX)) {
    return { consumer: raw.consumer, kind: "quota-refresh", key: raw.key }
  }
  return null
}

export function parseGlanceQuotaEnablePayload(raw: unknown): GlanceQuotaEnablePayload | null {
  if (!isRecord(raw) || !isId(raw.provider, 64) || !isId(raw.accountId)) return null
  return { provider: raw.provider, accountId: raw.accountId }
}

export function isGlanceRemoteResult(value: unknown): value is GlanceRemoteResult {
  if (!isRecord(value)) return false
  return value.ok === true || (value.ok === false && typeof value.code === "string")
}

export function isGlanceSubscribeResponse(value: unknown): value is GlanceSubscribeResponse {
  if (!isRecord(value)) return false
  if (value.ok === false) return typeof value.code === "string"
  return value.ok === true && "snapshot" in value && typeof value.ttlMs === "number"
}

/**
 * One demand for several phones. Modules are the union, in first-seen order,
 * and the catalogue is asked for while any phone asks; options come from the
 * newest announcement, since a single build can serve
 * only one activity range or usage scope. Every slice says which options it
 * was built for (`usage.scope`, `activity.range`), so a phone whose own
 * choice lost shows what it received rather than mislabelling it.
 */
export function mergeGlanceDemands(
  demands: ReadonlyArray<{ demand: GlanceRemoteDemand; announcedAt: number }>
): GlanceRemoteDemand | null {
  if (demands.length === 0) return null
  const newest = demands.reduce((a, b) => (b.announcedAt > a.announcedAt ? b : a))
  const modules: GlanceHostEntryId[] = []
  for (const { demand } of demands) {
    for (const id of demand.modules) if (!modules.includes(id)) modules.push(id)
  }
  return { ...newest.demand, modules, catalog: demands.some(({ demand }) => demand.catalog) }
}
