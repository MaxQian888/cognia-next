/**
 * Settings sections + controls (ADR-0129), replacing the settings shell's own
 * ⌘K finder. Sections come from `SETTINGS_NAV` (with the bilingual keyword
 * index), controls from the curated `SETTING_CONTROLS` registry. Both are
 * cut to what the host can reach — the same rule the settings sidebar applies —
 * so the palette is never a back door into an unreachable section.
 */

import { SettingsIcon, SlidersHorizontalIcon } from "lucide-react"

import { SETTING_CONTROLS } from "@/components/settings/finder/control-registry"
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

const SECTION_LABEL_KEY: Record<string, string> = Object.fromEntries(
  SETTINGS_NAV.map((n) => [n.id, n.labelKey])
)

function sectionLabel(ctx: GlobalSearchContext, id: SettingsSectionId): string {
  return ctx.t(`settings.tabs.${SECTION_LABEL_KEY[id] ?? id}`)
}

function reachable(ctx: GlobalSearchContext, id: SettingsSectionId): boolean {
  return ctx.host.reachableSettingsSections.has(id)
}

export function settingsCandidates(ctx: GlobalSearchContext): SettingsCandidate[] {
  const sections = SETTINGS_NAV.filter((item: NavItem) => reachable(ctx, item.id)).map(
    (item): SettingsCandidate => ({
      id: `section:${item.id}`,
      title: sectionLabel(ctx, item.id),
      secondary: ctx.t(`settings.descriptions.${item.descriptionKey}`),
      keywords: [item.id, ...(SETTINGS_SEARCH_KEYWORDS[item.id] ?? [])],
      icon: { lucide: item.icon as never },
      action: { type: "open-settings", tab: item.id },
      isControl: false,
    })
  )
  const controls = SETTING_CONTROLS.filter((c) => reachable(ctx, c.sectionId)).map(
    (c): SettingsCandidate => ({
      id: `control:${c.id}`,
      title: ctx.t(`settings.finder.controls.${c.labelKey}`),
      keywords: [c.id, ...(c.keywords ?? [])],
      meta: sectionLabel(ctx, c.sectionId),
      icon: { lucide: SlidersHorizontalIcon },
      action: { type: "open-settings", tab: c.sectionId, focus: c.id },
      isControl: true,
    })
  )
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
    icon: c.icon ?? { lucide: SettingsIcon },
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
