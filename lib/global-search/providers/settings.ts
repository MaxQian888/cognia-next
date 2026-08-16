/**
 * Settings sections + controls (ADR-0129), replacing the settings shell's own
 * ⌘K finder. Sections come from `SETTINGS_NAV` (with the bilingual keyword
 * index), controls from the curated `SETTING_CONTROLS` registry. Both are
 * cut to what the host can reach — the same rule the settings sidebar applies —
 * so the palette is never a back door into an unreachable section.
 */

import { SlidersHorizontalIcon } from "lucide-react"

import {
  SETTING_CONTROLS,
  type SettingControl,
} from "@/components/settings/finder/control-registry"
import {
  SETTINGS_NAV,
  SETTINGS_SEARCH_KEYWORDS,
  type NavItem,
  type SettingsSectionId,
} from "@/components/settings/settings-nav-config"
import { matchTitles } from "./helpers"
import type { GlobalSearchContext, GlobalSearchItem, GlobalSearchProvider } from "../types"

export const SETTINGS_PROVIDER_ID = "builtin.settings"

interface SettingsCandidate {
  id: string
  title: string
  secondary?: string
  keywords: string[]
  /** Section label shown on the right for controls; the description for sections. */
  meta?: string
  icon: GlobalSearchItem["icon"]
  action: GlobalSearchItem["action"]
  /** Controls rank a touch below sections on equal matches. */
  isControl: boolean
}

/** The registries the provider reads — injectable for tests. */
export interface SettingsSources {
  nav: readonly NavItem[]
  controls: readonly SettingControl[]
  keywords: Readonly<Partial<Record<string, readonly string[]>>>
}

const DEFAULT_SOURCES: SettingsSources = {
  nav: SETTINGS_NAV,
  controls: SETTING_CONTROLS,
  keywords: SETTINGS_SEARCH_KEYWORDS,
}

function sectionLabel(
  ctx: GlobalSearchContext,
  nav: readonly NavItem[],
  id: SettingsSectionId
): string {
  // A control may point at a merged / redirected section id that is no longer
  // a nav entry; fall back to the id so the row still names something.
  const labelKey = nav.find((n) => n.id === id)?.labelKey ?? id
  return ctx.t(`settings.tabs.${labelKey}`)
}

function reachable(ctx: GlobalSearchContext, id: SettingsSectionId): boolean {
  return ctx.host.reachableSettingsSections.has(id)
}

export function settingsCandidates(
  ctx: GlobalSearchContext,
  sources: SettingsSources = DEFAULT_SOURCES
): SettingsCandidate[] {
  const sections = sources.nav
    .filter((item: NavItem) => reachable(ctx, item.id))
    .map((item): SettingsCandidate => ({
      id: `section:${item.id}`,
      title: sectionLabel(ctx, sources.nav, item.id),
      secondary: ctx.t(`settings.descriptions.${item.descriptionKey}`),
      keywords: [item.id, ...(sources.keywords[item.id] ?? [])],
      icon: { lucide: item.icon as never },
      action: { type: "open-settings", tab: item.id },
      isControl: false,
    }))
  const controls = sources.controls
    .filter((c) => reachable(ctx, c.sectionId))
    .map((c): SettingsCandidate => ({
      id: `control:${c.id}`,
      title: ctx.t(`settings.finder.controls.${c.labelKey}`),
      keywords: [c.id, ...(c.keywords ?? [])],
      meta: sectionLabel(ctx, sources.nav, c.sectionId),
      icon: { lucide: SlidersHorizontalIcon },
      action: { type: "open-settings", tab: c.sectionId, focus: c.id },
      isControl: true,
    }))
  return [...sections, ...controls]
}

function toItem(
  c: SettingsCandidate,
  score: number,
  positions: readonly number[] = []
): GlobalSearchItem {
  return {
    id: `settings:${c.id}`,
    kind: "settings",
    title: c.title,
    titlePositions: positions,
    subtitle: c.isControl ? undefined : c.secondary,
    meta: c.meta,
    icon: c.icon,
    keywords: c.keywords,
    // Controls sit just below sections when both match equally well.
    score: c.isControl ? Math.max(0, score - 0.02) : score,
    action: c.action,
  }
}

export const settingsProvider: GlobalSearchProvider = {
  id: SETTINGS_PROVIDER_ID,
  kind: "settings",
  search({ query, ctx, limit }) {
    const { hits, total, truncated } = matchTitles(settingsCandidates(ctx), query.needle, {
      getTitle: (c) => c.title,
      getSecondary: (c) => c.secondary,
      getKeywords: (c) => c.keywords,
      now: ctx.now,
      limit,
    })
    return {
      items: hits.map(({ row, match }) => toItem(row, match.score, match.positions)),
      total,
      truncated,
    }
  },
}
