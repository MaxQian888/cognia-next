"use client"

// Active-filter chip strip — surfaces non-default `filters` from
// `usePluginsStore` so the user can see and dismiss filters without opening
// the FilterSheet. Renders nothing when only defaults are set, so it stays
// invisible on the unfiltered Library view.
//
// Filters that are owned by `librarySubFilter` (status / hasUpdate /
// configurable) are hidden while a sub-filter is active so we don't double
// up — clearing them happens via the sub-filter chip strip above.

import { XIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { usePluginsStore, DEFAULT_PLUGIN_FILTERS, type PluginFilters } from "@/stores/plugins"

interface ActiveChip {
  key: string
  labelKey: string
  vars?: Record<string, string | number>
  reset: Partial<PluginFilters>
}

function buildChips(filters: PluginFilters, subActive: boolean): ActiveChip[] {
  const chips: ActiveChip[] = []
  const q = filters.query.trim()
  if (q.length > 0) {
    chips.push({
      key: "query",
      labelKey: "chip.query",
      vars: { value: q },
      reset: { query: "" },
    })
  }
  if (filters.capability !== "all") {
    chips.push({
      key: "capability",
      labelKey: "chip.capability",
      vars: { value: filters.capability },
      reset: { capability: "all" },
    })
  }
  if (filters.permission !== "all") {
    chips.push({
      key: "permission",
      labelKey: "chip.permission",
      vars: { value: filters.permission },
      reset: { permission: "all" },
    })
  }
  if (filters.source !== "all") {
    chips.push({
      key: "source",
      labelKey: "chip.source",
      vars: { value: filters.source },
      reset: { source: "all" },
    })
  }
  // status / hasUpdate / configurable are driven by librarySubFilter when
  // it's not "all" — hide their chips so we don't double-up the surface.
  if (!subActive) {
    if (filters.status !== "all") {
      chips.push({
        key: "status",
        labelKey: "chip.status",
        vars: { value: filters.status },
        reset: { status: "all" },
      })
    }
    if (filters.hasUpdate) {
      chips.push({
        key: "hasUpdate",
        labelKey: "chip.hasUpdate",
        reset: { hasUpdate: false },
      })
    }
    if (filters.configurable) {
      chips.push({
        key: "configurable",
        labelKey: "chip.configurable",
        reset: { configurable: false },
      })
    }
  }
  if (filters.signedOnly) {
    chips.push({
      key: "signedOnly",
      labelKey: "chip.signedOnly",
      reset: { signedOnly: false },
    })
  }
  if (filters.sort !== DEFAULT_PLUGIN_FILTERS.sort) {
    chips.push({
      key: "sort",
      labelKey: "chip.sort",
      vars: { value: filters.sort },
      reset: { sort: DEFAULT_PLUGIN_FILTERS.sort },
    })
  }
  return chips
}

export function PluginActiveFilters() {
  const t = useTranslations("plugins.activeFilters")
  const filters = usePluginsStore((s) => s.filters)
  const setFilters = usePluginsStore((s) => s.setFilters)
  const resetFilters = usePluginsStore((s) => s.resetFilters)
  const subActive = usePluginsStore((s) => s.librarySubFilter !== "all")

  const chips = buildChips(filters, subActive)
  if (chips.length === 0) return null

  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      role="group"
      aria-label={t("ariaLabel")}
      data-testid="plugin-active-filters"
    >
      {chips.map((chip) => (
        <Badge
          key={chip.key}
          variant="secondary"
          className="gap-1 h-6 pr-1 text-xs"
          data-testid={`plugin-active-filter-${chip.key}`}
        >
          <span className="truncate max-w-[16ch]">{t(chip.labelKey, chip.vars)}</span>
          <button
            type="button"
            className="rounded hover:bg-background/60 p-0.5"
            onClick={() => setFilters(chip.reset)}
            aria-label={t("removeAria", { name: t(chip.labelKey, chip.vars) })}
          >
            <XIcon className="size-3" />
          </button>
        </Badge>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs"
        onClick={() => resetFilters()}
      >
        {t("clearAll")}
      </Button>
    </div>
  )
}
