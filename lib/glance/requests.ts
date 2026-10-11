/**
 * What a glance consumer may ask the main window to do (ADR-0225 §7).
 *
 * The consumer renders and asks; the main window validates and decides. Every
 * request kind here is either a route to an owner surface or a light action
 * that ADR-0225 §1 allows on a glance surface (refresh, retry, enable a quota
 * source, change a panel option or the layout, a pet care command). None approves, stops or
 * answers anything: those stay in Agent Fleet. Delegating and running the
 * user's quick actions keep their existing path (`tray-panel://run`).
 */

import {
  GLANCE_ACTIVITY_RANGES,
  GLANCE_MAX_HEIGHT_MAX,
  GLANCE_MAX_HEIGHT_MIN,
  GLANCE_MODULE_IDS,
  GLANCE_MODULE_SIZES,
  GLANCE_PRESET_IDS,
  GLANCE_WIDTH_STEPS,
  type GlanceActivityRange,
  type GlanceLayoutEntry,
  type GlanceModuleId,
  type GlanceModuleSize,
  type GlancePresetId,
  type GlanceScope,
  type GlanceUsageScope,
  type GlanceWidthStep,
} from "@/types/glance/layout"

import type { GlanceOwnerSurface } from "./registry"

/** Pet care commands a glance may run. Exactly the tray menu's pet submenu. */
export const GLANCE_PET_COMMANDS = [
  "pet.feed",
  "pet.play",
  "pet.pet",
  "pet.sleep",
  "pet.clean",
] as const
export type GlancePetCommand = (typeof GLANCE_PET_COMMANDS)[number]

export type GlanceFleetFilter = "working" | "awaiting" | "failed"

export type GlanceRequestBody =
  /** Re-read everything now: quota (forced, still throttled) and the external usage index. */
  | { kind: "refresh" }
  /** Open Agent Fleet, focused on one row when given. */
  | { kind: "open-fleet"; rowId?: string; filter?: GlanceFleetFilter }
  /** Open the owner surface of a module, optionally at one item. */
  | { kind: "open-owner"; owner: GlanceOwnerSurface; itemId?: string }
  /** Resume one conversation. */
  | { kind: "open-session"; sessionId: string }
  /** Retry one quota source. */
  | { kind: "quota-refresh"; key: string }
  /** Turn quota queries on for a vault account (`disabled` row). */
  | { kind: "quota-enable"; provider: string; accountId: string }
  | { kind: "set-scope"; scope: GlanceScope }
  | { kind: "set-usage-scope"; scope: GlanceUsageScope }
  | { kind: "set-show-spend"; showSpend: boolean }
  | { kind: "set-activity-range"; range: GlanceActivityRange }
  | { kind: "set-max-height"; maxHeight: number }
  | { kind: "set-width"; width: GlanceWidthStep }
  | { kind: "pet-care"; command: GlancePetCommand }
  /** The in-place editor's new entry list (makes the layout `custom`). */
  | { kind: "set-layout"; entries: GlanceLayoutEntry[] }
  /** Reset the layout to a built-in preset. */
  | { kind: "apply-preset"; preset: GlancePresetId }
  | { kind: "set-delegate-visible"; visible: boolean }

export type GlanceRequest = GlanceRequestBody & {
  requestId: string
  /** Which consumer asked, so the result goes back to it alone. */
  consumer: string
}

export interface GlanceRequestResult {
  requestId: string
  ok: boolean
  /** `glance.errors.*` key when not ok. */
  errorKey?: string
}

const OWNERS: readonly GlanceOwnerSurface[] = [
  "workflows",
  "fleet",
  "usage",
  "subscription",
  "scheduler",
  "notifications",
  "connectivity",
  "conversations",
  "pet",
  "tray-actions",
]

const FLEET_FILTERS: readonly GlanceFleetFilter[] = ["working", "awaiting", "failed"]

const ID_MAX = 512

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= ID_MAX
}

function isOptionalId(value: unknown): boolean {
  return value === undefined || isId(value)
}

/**
 * An entry list exactly as the editor produces it: every known module at most
 * once, each with a known size and a boolean `hidden`. Repairs (missing
 * modules, unsupported sizes) are the normalizer's job on write; anything
 * beyond that is not an editor's output and is refused.
 */
function parseEntries(value: unknown): GlanceLayoutEntry[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > GLANCE_MODULE_IDS.length) {
    return null
  }
  const seen = new Set<string>()
  const out: GlanceLayoutEntry[] = []
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null
    const e = item as Record<string, unknown>
    if (!GLANCE_MODULE_IDS.includes(e.id as GlanceModuleId) || seen.has(e.id as string)) return null
    if (!GLANCE_MODULE_SIZES.includes(e.size as GlanceModuleSize)) return null
    if (typeof e.hidden !== "boolean") return null
    seen.add(e.id as string)
    out.push({ id: e.id as GlanceModuleId, size: e.size as GlanceModuleSize, hidden: e.hidden })
  }
  return out
}

/**
 * Validate a request that arrived over IPC. Anything malformed is rejected
 * whole: a request the main window half-understands is worse than none.
 */
export function parseGlanceRequest(value: unknown): GlanceRequest | null {
  if (typeof value !== "object" || value === null) return null
  const v = value as Record<string, unknown>
  if (!isId(v.requestId) || !isId(v.consumer) || typeof v.kind !== "string") return null
  const base = { requestId: v.requestId, consumer: v.consumer }
  switch (v.kind) {
    case "refresh":
      return { ...base, kind: "refresh" }
    case "open-fleet":
      if (!isOptionalId(v.rowId)) return null
      if (v.filter !== undefined && !FLEET_FILTERS.includes(v.filter as GlanceFleetFilter))
        return null
      return {
        ...base,
        kind: "open-fleet",
        ...(v.rowId !== undefined ? { rowId: v.rowId as string } : {}),
        ...(v.filter !== undefined ? { filter: v.filter as GlanceFleetFilter } : {}),
      }
    case "open-owner":
      if (!OWNERS.includes(v.owner as GlanceOwnerSurface) || !isOptionalId(v.itemId)) return null
      return {
        ...base,
        kind: "open-owner",
        owner: v.owner as GlanceOwnerSurface,
        ...(v.itemId !== undefined ? { itemId: v.itemId as string } : {}),
      }
    case "open-session":
      return isId(v.sessionId) ? { ...base, kind: "open-session", sessionId: v.sessionId } : null
    case "quota-refresh":
      return isId(v.key) ? { ...base, kind: "quota-refresh", key: v.key } : null
    case "quota-enable":
      return isId(v.provider) && isId(v.accountId)
        ? { ...base, kind: "quota-enable", provider: v.provider, accountId: v.accountId }
        : null
    case "set-scope":
      return v.scope === "all" || v.scope === "workspace"
        ? { ...base, kind: "set-scope", scope: v.scope }
        : null
    case "set-usage-scope":
      return v.scope === "cognia" || v.scope === "all-tools"
        ? { ...base, kind: "set-usage-scope", scope: v.scope }
        : null
    case "set-show-spend":
      return typeof v.showSpend === "boolean"
        ? { ...base, kind: "set-show-spend", showSpend: v.showSpend }
        : null
    case "set-activity-range":
      return GLANCE_ACTIVITY_RANGES.includes(v.range as GlanceActivityRange)
        ? { ...base, kind: "set-activity-range", range: v.range as GlanceActivityRange }
        : null
    case "set-max-height":
      return typeof v.maxHeight === "number" &&
        Number.isFinite(v.maxHeight) &&
        v.maxHeight >= GLANCE_MAX_HEIGHT_MIN &&
        v.maxHeight <= GLANCE_MAX_HEIGHT_MAX
        ? { ...base, kind: "set-max-height", maxHeight: Math.round(v.maxHeight) }
        : null
    case "set-width":
      return GLANCE_WIDTH_STEPS.includes(v.width as GlanceWidthStep)
        ? { ...base, kind: "set-width", width: v.width as GlanceWidthStep }
        : null
    case "pet-care":
      return (GLANCE_PET_COMMANDS as readonly string[]).includes(v.command as string)
        ? { ...base, kind: "pet-care", command: v.command as GlancePetCommand }
        : null
    case "set-layout": {
      const entries = parseEntries(v.entries)
      return entries ? { ...base, kind: "set-layout", entries } : null
    }
    case "apply-preset":
      return GLANCE_PRESET_IDS.includes(v.preset as GlancePresetId)
        ? { ...base, kind: "apply-preset", preset: v.preset as GlancePresetId }
        : null
    case "set-delegate-visible":
      return typeof v.visible === "boolean"
        ? { ...base, kind: "set-delegate-visible", visible: v.visible }
        : null
    default:
      return null
  }
}
