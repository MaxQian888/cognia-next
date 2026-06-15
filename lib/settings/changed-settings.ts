/**
 * Diff the current settings against the canonical `DEFAULTS`, scoped to the
 * tunable preference keys (see `preferenceKeys` — excludes secrets, identity,
 * and UI-local state). Powers the "changed settings" review panel: a user can
 * see everything that diverges from defaults, grouped by section, and reset any
 * row / group back.
 *
 * The diff is intentionally scoped to keys that have a `DEFAULTS` entry, which
 * is the same finite set `buildResetPatch` operates on — so every changed row
 * is also resettable.
 */

import type { AppSettings } from "@/lib/claude/types"
import type { SettingsSectionId } from "@/components/settings/settings-nav-config"
import { SETTINGS_NAV } from "@/components/settings/settings-nav-config"
import { DEFAULTS } from "@/lib/db/settings"
import { keyToSection, preferenceKeys } from "./section-keys"

export interface ChangedSetting {
  key: keyof AppSettings
  sectionId: SettingsSectionId | undefined
  current: unknown
  default: unknown
}

export interface ChangedSettingGroup {
  sectionId: SettingsSectionId | undefined
  items: ChangedSetting[]
}

/** Structural deep equality for JSON-serializable settings values. */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return a === b
  if (typeof a !== typeof b) return false
  if (typeof a !== "object") return false

  const aArr = Array.isArray(a)
  const bArr = Array.isArray(b)
  if (aArr !== bArr) return false
  if (aArr && bArr) {
    if (a.length !== b.length) return false
    return a.every((v, i) => valuesEqual(v, b[i]))
  }

  const aObj = a as Record<string, unknown>
  const bObj = b as Record<string, unknown>
  const aKeys = Object.keys(aObj)
  const bKeys = Object.keys(bObj)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((k) => Object.hasOwn(bObj, k) && valuesEqual(aObj[k], bObj[k]))
}

/**
 * List every preference key whose current value differs from its default.
 * `defaults` is injectable for tests; production passes the canonical DEFAULTS.
 */
export function diffFromDefaults(
  settings: AppSettings,
  defaults: AppSettings = DEFAULTS
): ChangedSetting[] {
  const out: ChangedSetting[] = []
  for (const key of preferenceKeys()) {
    const current = settings[key]
    const def = defaults[key]
    if (!valuesEqual(current, def)) {
      out.push({ key, sectionId: keyToSection(key), current, default: def })
    }
  }
  return out
}

const SECTION_ORDER: SettingsSectionId[] = SETTINGS_NAV.map((n) => n.id)

/** Group changed settings by owning section, ordered by the settings nav. */
export function groupChangedBySection(changed: ChangedSetting[]): ChangedSettingGroup[] {
  const bySection = new Map<SettingsSectionId | undefined, ChangedSetting[]>()
  for (const item of changed) {
    const list = bySection.get(item.sectionId) ?? []
    list.push(item)
    bySection.set(item.sectionId, list)
  }
  const groups: ChangedSettingGroup[] = []
  for (const sectionId of SECTION_ORDER) {
    const items = bySection.get(sectionId)
    if (items && items.length > 0) {
      groups.push({ sectionId, items })
      bySection.delete(sectionId)
    }
  }
  // Any leftover (unowned) keys land in a trailing group.
  for (const [sectionId, items] of bySection) {
    if (items.length > 0) groups.push({ sectionId, items })
  }
  return groups
}

/** camelCase / snake_case AppSettings key → a human-readable label fallback. */
export function humanizeSettingKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
  if (!spaced) return key
  return spaced
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}

/** A short, single-line preview of a setting value for the review list. */
export function previewValue(value: unknown): string {
  if (value === undefined) return "—"
  if (value === null) return "null"
  if (typeof value === "string") return value.length === 0 ? '""' : value
  if (typeof value === "boolean" || typeof value === "number") return String(value)
  if (Array.isArray(value)) return `[${value.length}]`
  try {
    const json = JSON.stringify(value)
    return json.length > 80 ? `${json.slice(0, 77)}…` : json
  } catch {
    return "{…}"
  }
}
