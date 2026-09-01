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
import { compareByScore } from "../scoring"
import { matchTitles } from "./helpers"
import type { GlobalSearchContext, GlobalSearchItem, GlobalSearchProvider } from "../types"

export const SETTINGS_PROVIDER_ID = "builtin.settings"

/**
 * How far a control sits below a section that matched exactly as well.
 *
 * Small on purpose: this is a tie-break, not a demotion. A control whose label
 * genuinely matches the needle better than any section still wins.
 */
const CONTROL_PENALTY = 0.02

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
    // Controls sit just below sections when both match equally well. Applied
    // here, which is AFTER `matchTitles` has sorted, so the caller has to
    // re-sort. See the note in `search`.
    score: c.isControl ? Math.max(0, score - CONTROL_PENALTY) : score,
    action: c.action,
  }
}

export const settingsProvider: GlobalSearchProvider = {
  id: SETTINGS_PROVIDER_ID,
  kind: "settings",
  search({ query, ctx, limit }) {
    // Deliberately unlimited here, then sorted and sliced below.
    //
    // `matchTitles` orders and cuts by the RAW match score, while the control
    // penalty is applied afterwards in `toItem`. Letting it cut first meant the
    // penalty could not do either half of its job. It could not order: on an
    // exact tie `compareByScore` falls through to `title.localeCompare`, so
    // `settings.finder.controls.theme` beat `settings.tabs.externalServices` on
    // the letter "f" against "t", and the array came back with a 0.924 row
    // BELOW a 0.904 one. And it could not select: at the cut line a tied
    // control would take the last slot from the section it was supposed to
    // yield to. Scoring every candidate is what `matchTitles` does regardless,
    // so nothing is spent by asking for all of them.
    const { hits, total } = matchTitles(settingsCandidates(ctx), query.needle, {
      getTitle: (c) => c.title,
      getSecondary: (c) => c.secondary,
      getKeywords: (c) => c.keywords,
      now: ctx.now,
      limit: Number.MAX_SAFE_INTEGER,
    })
    const ranked = hits
      .map(({ row, match }) => toItem(row, match.score, match.positions))
      .sort(compareByScore)
    const items = ranked.slice(0, limit)
    return { items, total, truncated: ranked.length > items.length }
  },
}
