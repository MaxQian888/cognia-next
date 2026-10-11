/**
 * The phone's glance layout (ADR-0225 §9, §10): presets, normalization, the
 * one-way read of the layout it replaces, and copying to and from the
 * desktop's layout.
 *
 * One layout feeds two surfaces. The Glance drawer renders every visible
 * entry; the home screen renders the visible entries pinned with `home`, in
 * the same order. The quick module's content on a phone is the layout's own
 * shortcut list (`shortcuts`), not the desktop tray's action catalogue.
 *
 * Before ADR-0225 the home screen had its own model, `mobileHomeLayout`
 * (a shortcut grid plus three section toggles), and the activity dashboard
 * had an on/off of its own (`welcomeStats.enabled`). Until the phone saves a
 * `mobileGlanceLayout`, that old state is read into the new model on every
 * read, so nothing changes on screen and nothing has to be written up front:
 * the first edit stores the new field, and from then on the old one is never
 * read again.
 */

import {
  resolveWelcomeStatsPrefs,
  type StoredWelcomeStatsPrefs,
} from "@/lib/chat/welcome-stats-prefs"
import {
  DEFAULT_MOBILE_HOME_LAYOUT,
  LEGACY_MOBILE_QUICK_ACTION_IDS,
  MOBILE_QUICK_ACTION_CATALOG,
  type MobileHomeLayout,
} from "@/types/shell/mobile-home"
import {
  DEFAULT_GLANCE_MODULE_OPTIONS,
  GLANCE_MODULE_IDS,
  GLANCE_MODULE_SIZES,
  GLANCE_PRESET_IDS,
  type GlanceLayoutEntry,
  type GlanceMobileEntry,
  type GlanceMobileSettings,
  type GlanceModuleId,
  type GlanceModuleSize,
  type GlancePresetId,
} from "@/types/glance/layout"

import { normalizeGlanceModuleOptions } from "./presets"
import { effectiveSize, glanceModule, GLANCE_MODULES } from "./registry"

/**
 * The visible entries of each preset on a phone, in order, with their home
 * pin. Everything else is hidden. `balanced` is the home screen as it was
 * before ADR-0225: the running-work line, the shortcut grid, the usage and
 * activity dashboard, recent conversations.
 */
export const GLANCE_MOBILE_PRESETS: Readonly<
  Record<
    GlancePresetId,
    ReadonlyArray<readonly [id: GlanceModuleId, size: GlanceModuleSize, home: boolean]>
  >
> = {
  balanced: [
    ["fleet", "compact", true],
    ["quick", "standard", true],
    ["usage", "standard", true],
    ["activity", "standard", true],
    ["recents", "standard", true],
    ["quota", "standard", false],
    ["agenda", "compact", false],
  ],
  "usage-first": [
    ["usage", "expanded", true],
    ["quota", "expanded", true],
    ["activity", "expanded", true],
    ["fleet", "compact", true],
    ["quick", "compact", false],
  ],
  "agent-ops": [
    ["fleet", "expanded", true],
    ["agenda", "standard", true],
    ["recents", "standard", true],
    ["quick", "standard", true],
    ["quota", "compact", false],
  ],
  minimal: [
    ["fleet", "compact", true],
    ["quick", "standard", true],
    ["usage", "compact", false],
  ],
}

/** A full mobile entry list for a preset: its visible entries, then the rest hidden. */
export function mobileLayoutFromPreset(preset: GlancePresetId): GlanceMobileEntry[] {
  const visible = GLANCE_MOBILE_PRESETS[preset].map(([id, size, home]) => ({
    id,
    size,
    hidden: false,
    home,
  }))
  const rest = GLANCE_MODULE_IDS.filter((id) => !visible.some((entry) => entry.id === id)).map(
    (id) => ({ id, size: GLANCE_MODULES[id].sizes[0], hidden: true, home: false })
  )
  return [...visible, ...rest]
}

/** The shortcut grid a fresh phone starts with. */
export const DEFAULT_GLANCE_MOBILE_SHORTCUTS: readonly string[] =
  DEFAULT_MOBILE_HOME_LAYOUT.quickActions

export const DEFAULT_GLANCE_MOBILE_SETTINGS: GlanceMobileSettings = {
  version: 1,
  preset: "balanced",
  entries: mobileLayoutFromPreset("balanced"),
  scope: "all",
  options: DEFAULT_GLANCE_MODULE_OPTIONS,
  shortcuts: [...DEFAULT_GLANCE_MOBILE_SHORTCUTS],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Repair a mobile entry list against the current catalogue. */
export function normalizeMobileEntries(raw: unknown): GlanceMobileEntry[] {
  if (!Array.isArray(raw)) return mobileLayoutFromPreset("balanced")
  const seen = new Set<GlanceModuleId>()
  const out: GlanceMobileEntry[] = []
  for (const item of raw) {
    if (!isRecord(item) || typeof item.id !== "string") continue
    const def = glanceModule(item.id)
    if (!def || seen.has(def.id)) continue
    seen.add(def.id)
    const size =
      typeof item.size === "string" &&
      (GLANCE_MODULE_SIZES as readonly string[]).includes(item.size)
        ? effectiveSize(def.id, item.size as GlanceModuleSize)
        : def.sizes[0]
    out.push({ id: def.id, size, hidden: item.hidden === true, home: item.home === true })
  }
  // A module a newer build added is opt-in: hidden, and off the home screen.
  for (const id of GLANCE_MODULE_IDS) {
    if (!seen.has(id))
      out.push({ id, size: GLANCE_MODULES[id].sizes[0], hidden: true, home: false })
  }
  return out
}

const SHORTCUT_IDS: ReadonlySet<string> = new Set(MOBILE_QUICK_ACTION_CATALOG.map((a) => a.id))

/**
 * Repair a shortcut list: renamed ids mapped, unknown ids dropped, duplicates
 * keep their first place. An explicitly empty list is honoured (the user
 * removed every shortcut); only a missing or malformed one gets the default.
 */
export function normalizeShortcuts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...DEFAULT_GLANCE_MOBILE_SHORTCUTS]
  const out: string[] = []
  for (const stored of raw) {
    if (typeof stored !== "string") continue
    const id = LEGACY_MOBILE_QUICK_ACTION_IDS[stored] ?? stored
    if (!SHORTCUT_IDS.has(id) || out.includes(id)) continue
    out.push(id)
  }
  return out
}

/** The pre-ADR-0225 home state a phone may still hold. */
export interface LegacyMobileHomeState {
  mobileHomeLayout?: Partial<MobileHomeLayout> | null
  welcomeStats?: StoredWelcomeStatsPrefs | null
}

/**
 * Read the old home model into the new one. Each old section becomes the home
 * pin of the module that replaced it: the active-runs card is the Fleet
 * module, the grid is the quick module, the dashboard is the usage and
 * activity modules, and recents stay recents. The modules stay visible in the
 * drawer either way, so turning a section off never loses the data. A home
 * that matches the old default reads as the `balanced` preset.
 */
export function migrateMobileHomeLayout(legacy: LegacyMobileHomeState): GlanceMobileSettings {
  const hidden = new Set(
    Array.isArray(legacy.mobileHomeLayout?.hiddenSections)
      ? legacy.mobileHomeLayout.hiddenSections
      : []
  )
  const dashboard = resolveWelcomeStatsPrefs(legacy.welcomeStats ?? undefined).enabled
  const pinned: Partial<Record<GlanceModuleId, boolean>> = {
    fleet: !hidden.has("activeRuns"),
    quick: !hidden.has("quickActions"),
    recents: !hidden.has("recents"),
    usage: dashboard,
    activity: dashboard,
  }
  const base = mobileLayoutFromPreset("balanced")
  const entries = base.map((entry) =>
    entry.id in pinned ? { ...entry, home: pinned[entry.id] === true } : entry
  )
  const unchanged = entries.every((entry, index) => entry.home === base[index].home)
  const shortcuts =
    legacy.mobileHomeLayout?.quickActions === undefined
      ? [...DEFAULT_GLANCE_MOBILE_SHORTCUTS]
      : normalizeShortcuts(legacy.mobileHomeLayout.quickActions)
  return {
    ...DEFAULT_GLANCE_MOBILE_SETTINGS,
    preset: unchanged ? "balanced" : "custom",
    entries,
    shortcuts,
  }
}

/**
 * Read whatever is stored into a valid mobile layout. Never throws. With no
 * stored layout, the old home state (if any) is read instead.
 */
export function normalizeGlanceMobileSettings(
  raw: unknown,
  legacy: LegacyMobileHomeState = {}
): GlanceMobileSettings {
  if (!isRecord(raw)) return migrateMobileHomeLayout(legacy)
  const preset =
    raw.preset === "custom" ||
    (typeof raw.preset === "string" &&
      (GLANCE_PRESET_IDS as readonly string[]).includes(raw.preset))
      ? (raw.preset as GlanceMobileSettings["preset"])
      : DEFAULT_GLANCE_MOBILE_SETTINGS.preset
  return {
    version: 1,
    preset,
    entries:
      raw.entries === undefined
        ? mobileLayoutFromPreset("balanced")
        : normalizeMobileEntries(raw.entries),
    scope: raw.scope === "workspace" ? "workspace" : "all",
    options: normalizeGlanceModuleOptions(raw.options),
    shortcuts: normalizeShortcuts(raw.shortcuts),
  }
}

/** The entries the home screen renders: visible and pinned, in layout order. */
export function homeEntries(entries: readonly GlanceMobileEntry[]): GlanceMobileEntry[] {
  return entries.filter((entry) => !entry.hidden && entry.home)
}

/**
 * Copy the desktop's order, sizes and visibility onto the phone. Home pins
 * stay the phone's own: the desktop has no home screen to say anything about
 * them, so a module keeps its pin, and one the copy newly shows starts
 * unpinned.
 */
export function mobileEntriesFromDesktop(
  desktop: readonly GlanceLayoutEntry[],
  current: readonly GlanceMobileEntry[]
): GlanceMobileEntry[] {
  const pin = new Map(current.map((entry) => [entry.id, entry.home]))
  return normalizeMobileEntries(
    desktop.map((entry) => ({ ...entry, home: !entry.hidden && pin.get(entry.id) === true }))
  )
}

/** Copy the phone's order, sizes and visibility onto the desktop. Pins are dropped. */
export function desktopEntriesFromMobile(
  mobile: readonly GlanceMobileEntry[]
): GlanceLayoutEntry[] {
  return mobile.map(({ id, size, hidden }) => ({ id, size, hidden }))
}
