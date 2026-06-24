"use client"

// Library sub-filter chip row (All / Enabled / Updates / Configurable /
// Errored). Reuses the FilterChips primitive that the scheduler section
// already ships so the visual treatment matches. Counts come straight
// from `usePlugins()` so the chip badges reflect the live row totals
// (filtered/total split happens in the library list, not here).
//
// The active chip is DERIVED from `filters` (the single source of truth)
// rather than from a separate stored field, so it can never disagree with
// the filter sheet's status/has-update controls. A custom status set in the
// sheet (e.g. "disabled") matches no chip — nothing is falsely highlighted.

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { FilterChips } from "@/components/scheduler/filter-chips"
import { usePlugins } from "@/hooks/plugins"
import { usePluginsStore, type PluginLibrarySubFilter } from "@/stores/plugins"
import { PLUGIN_LIBRARY_SUBFILTERS } from "../plugin-nav-config"

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
  // Custom status from the filter sheet — no quick-filter chip represents it.
  return ""
}

export function PluginLibrarySubFilter() {
  const t = useTranslations("plugins.sections.librarySub")
  const filters = usePluginsStore((s) => s.filters)
  const setSub = usePluginsStore((s) => s.setLibrarySubFilter)
  const sub = deriveActiveSubFilter(filters)
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

  const chips = PLUGIN_LIBRARY_SUBFILTERS.map((item) => ({
    key: item.value,
    label: t(item.labelKey),
    count: counts[item.value],
  }))

  return (
    <FilterChips
      filters={chips}
      activeFilter={sub}
      onFilterChange={(k) => setSub(k as PluginLibrarySubFilter)}
    />
  )
}
