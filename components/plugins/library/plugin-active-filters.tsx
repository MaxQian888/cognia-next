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
import { CAPABILITY_META } from "../plugin-capabilities"

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

function useActiveFilterChips(): ActiveChip[] {
  const filters = usePluginsStore((s) => s.filters)
  const subActive = usePluginsStore((s) => s.librarySubFilter !== "all")
  return buildChips(filters, subActive)
}

/**
 * Whether the strip renders any chip — i.e. whether any filter sits at a
 * non-default value. `PluginLibraryStatusBar` reads this to decide between
 * mounting its band and returning null, instead of relying on this
 * component's own null return showing through CSS `:empty`.
 */
export function useHasActivePluginFilters(): boolean {
  return useActiveFilterChips().length > 0
}

export function PluginActiveFilters() {
  const t = useTranslations("plugins.activeFilters")
  const tCategory = useTranslations("plugins.categorySidebar")
  const setFilters = usePluginsStore((s) => s.setFilters)
  const resetFilters = usePluginsStore((s) => s.resetFilters)

  // The capability chip names the capability the way the rail beside it does
  // ("Commands"), not by its manifest id ("commands"). An uncurated id has no
  // label in the rail either, so it stays as is.
  const chips = useActiveFilterChips().map((chip) => {
    if (chip.key !== "capability") return chip
    const meta = CAPABILITY_META.find((entry) => entry.id === chip.vars?.value)
    return meta
      ? { ...chip, vars: { value: tCategory(`capability.${meta.i18nKey}` as never) } }
      : chip
  })
  if (chips.length === 0) return null

  return (
    <div
      // `w-max`, not wrap: the strip's parent scrolls horizontally, so this
      // row must stay one line — wrapping would grow the band's height and
      // push the rows it describes, the same shift it exists to prevent.
      className="flex w-max items-center gap-1.5"
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
