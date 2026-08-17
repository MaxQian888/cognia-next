"use client"

// Library's status axis (All / Enabled / Updates / Configurable / Errored),
// shaped as data for the shared `PluginSectionToolbar`'s segments slot.
//
// This used to render its own `FilterChips` row in the header's status line
// while the left nav rail rendered the same five values as nested sub-items
// — one axis, two controls, two places, and no guarantee they agreed. The
// values now feed the same segmented control Governance's view picker uses,
// so the header's second tier speaks one control vocabulary and the rail is
// left carrying only "which section am I in".
//
// The active segment is DERIVED from `filters` (the single source of truth)
// rather than from a separate stored field, so it can never disagree with
// the filter sheet's status / has-update controls. A custom status set in
// the sheet (e.g. "disabled") matches no segment — nothing is falsely
// highlighted, and because no active value is there to protect them,
// `visibleSegments` then drops whichever segments sit at 0.

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { usePlugins } from "@/hooks/plugins"
import { usePluginsStore, type PluginLibrarySubFilter } from "@/stores/plugins"
import { PLUGIN_LIBRARY_SUBFILTERS } from "../plugin-nav-config"
import type { PluginSectionToolbarProps } from "../plugin-section-toolbar"

export function deriveActiveSubFilter(filters: {
  configurable: boolean
  hasUpdate: boolean
  status: string
}): string {
  if (filters.configurable) return "configurable"
  if (filters.hasUpdate) return "updates"
  if (filters.status === "enabled") return "enabled"
  if (filters.status === "error") return "errored"
  if (filters.status === "all") return "all"
  // Custom status from the filter sheet — no quick-filter segment represents it.
  return ""
}

/**
 * Builds the Library section's `segments` payload. A hook rather than a
 * component because the segmented control itself belongs to
 * `PluginSectionToolbar` — only the values, labels and live counts are
 * Library's to supply.
 */
export function useLibrarySubFilterSegments(): NonNullable<PluginSectionToolbarProps["segments"]> {
  const t = useTranslations("plugins.sections.librarySub")
  const tSections = useTranslations("plugins.sections")
  const filters = usePluginsStore((s) => s.filters)
  const setSub = usePluginsStore((s) => s.setLibrarySubFilter)
  const { all } = usePlugins()

  const counts = useMemo(() => {
    let enabled = 0
    let updates = 0
    let configurable = 0
    let errored = 0
    for (const row of all) {
      if (row.status === "enabled") enabled++
      if (row.status === "error") errored++
      if ((row.manifest as { updateAvailable?: boolean })?.updateAvailable) updates++
      if ((row.manifest as { configSchema?: unknown })?.configSchema) configurable++
    }
    return { all: all.length, enabled, updates, configurable, errored }
  }, [all])

  return {
    ariaLabel: tSections("library"),
    items: PLUGIN_LIBRARY_SUBFILTERS.map((item) => ({
      value: item.value,
      label: t(item.labelKey),
      count: counts[item.value],
    })),
    value: deriveActiveSubFilter(filters),
    onSelect: (value) => setSub(value as PluginLibrarySubFilter),
    testId: "plugin-library-sub",
  }
}
