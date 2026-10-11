"use client"

// Active-filter chip strip — surfaces non-default `filters` from
// `usePluginsStore` so the user can see and dismiss filters without opening
// the FilterSheet. Renders nothing when only defaults are set, so it stays
// invisible on the unfiltered Library view.
//
// The status / has-update / configurable dimensions double as the Library
// quick-filter segments. A dimension the HIGHLIGHTED segment already shows
// gets no chip (clearing it is that segment's "All"); every other dimension
// does. The highlighted segment is derived from `filters` exactly as the
// toolbar derives it (`deriveActiveSubFilter`), never from the stored
// `librarySubFilter`, so a status set in the filter sheet always surfaces as
// either a lit segment or a chip — never as neither.
//
// Every value is shown in the user's language: statuses with the status
// pill's words, sources with the source badge's, permissions with their
// permission description, sort modes with the sheet's sort labels.

import { XIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { usePermissionDescription } from "@/hooks/plugins/use-permission-description"
import { usePluginsStore, DEFAULT_PLUGIN_FILTERS, type PluginFilters } from "@/stores/plugins"
import { CAPABILITY_META } from "../plugin-capabilities"
import { parsePluginSource } from "../plugin-source-badge"
import { deriveActiveSubFilter } from "./plugin-library-sub-filter"

/** Status values with a localized label in `plugins.card.status`. */
const LABELLED_STATUSES = new Set(["enabled", "disabled", "error"])

const SORT_MODES = new Set(["name", "updated", "usage", "rating"])

type ChipKey =
  | "query"
  | "capability"
  | "permission"
  | "source"
  | "status"
  | "hasUpdate"
  | "configurable"
  | "tag"
  | "signedOnly"
  | "sort"

interface ActiveChip {
  key: ChipKey
  labelKey: string
  /** The raw filter value, localized at render time. */
  value?: string
  reset: Partial<PluginFilters>
}

/**
 * Which of the segment-owned dimensions the highlighted segment represents.
 * Pure, so the rule is pinned by tests independently of rendering.
 */
export function segmentOwnedDimensions(filters: PluginFilters): {
  status: boolean
  hasUpdate: boolean
  configurable: boolean
} {
  const segment = deriveActiveSubFilter(filters)
  return {
    status: segment === "enabled" || segment === "errored",
    hasUpdate: segment === "updates",
    configurable: segment === "configurable",
  }
}

function buildChips(filters: PluginFilters): ActiveChip[] {
  const chips: ActiveChip[] = []
  const owned = segmentOwnedDimensions(filters)
  const q = filters.query.trim()
  if (q.length > 0) {
    chips.push({ key: "query", labelKey: "chip.query", value: q, reset: { query: "" } })
  }
  if (filters.capability !== "all") {
    chips.push({
      key: "capability",
      labelKey: "chip.capability",
      value: filters.capability,
      reset: { capability: "all" },
    })
  }
  if (filters.permission !== "all") {
    chips.push({
      key: "permission",
      labelKey: "chip.permission",
      value: filters.permission,
      reset: { permission: "all" },
    })
  }
  if (filters.source !== "all") {
    chips.push({
      key: "source",
      labelKey: "chip.source",
      value: filters.source,
      reset: { source: "all" },
    })
  }
  if (filters.status !== "all" && !owned.status) {
    chips.push({
      key: "status",
      labelKey: "chip.status",
      value: filters.status,
      reset: { status: "all" },
    })
  }
  if (filters.hasUpdate && !owned.hasUpdate) {
    chips.push({ key: "hasUpdate", labelKey: "chip.hasUpdate", reset: { hasUpdate: false } })
  }
  if (filters.configurable && !owned.configurable) {
    chips.push({
      key: "configurable",
      labelKey: "chip.configurable",
      reset: { configurable: false },
    })
  }
  if (filters.tag) {
    // Set by the detail overview's keyword chips. Without a chip of its own
    // the only way out of it was Filters → Reset, which also dropped every
    // other filter.
    chips.push({ key: "tag", labelKey: "chip.tag", value: filters.tag, reset: { tag: null } })
  }
  if (filters.signedOnly) {
    chips.push({ key: "signedOnly", labelKey: "chip.signedOnly", reset: { signedOnly: false } })
  }
  if (filters.sort !== DEFAULT_PLUGIN_FILTERS.sort) {
    chips.push({
      key: "sort",
      labelKey: "chip.sort",
      value: filters.sort,
      reset: { sort: DEFAULT_PLUGIN_FILTERS.sort },
    })
  }
  return chips
}

function useActiveFilterChips(): ActiveChip[] {
  const filters = usePluginsStore((s) => s.filters)
  return buildChips(filters)
}

/**
 * Whether the strip renders any chip — i.e. whether any filter sits at a
 * non-default value that no lit segment already shows.
 * `PluginLibraryStatusBar` reads this to decide between mounting its band and
 * returning null, instead of relying on this component's own null return
 * showing through CSS `:empty`.
 */
export function useHasActivePluginFilters(): boolean {
  return useActiveFilterChips().length > 0
}

/** The user-facing words for one chip's value. */
function useChipValueLabel(): (chip: ActiveChip) => string | undefined {
  const tCategory = useTranslations("plugins.categorySidebar")
  const tStatus = useTranslations("plugins.card.status")
  const tSource = useTranslations("plugins.source")
  const tSort = useTranslations("plugins.filterSheet.sortMode")
  const describePermission = usePermissionDescription()
  return (chip) => {
    const value = chip.value
    if (value === undefined) return undefined
    switch (chip.key) {
      case "capability": {
        // Named the way the rail beside it names it ("Commands"); an
        // uncurated id has no label in the rail either, so it stays as is.
        const meta = CAPABILITY_META.find((entry) => entry.id === value)
        return meta ? tCategory(`capability.${meta.i18nKey}` as never) : value
      }
      case "permission":
        return describePermission(value)
      case "source": {
        const known = parsePluginSource(value)
        return known ? tSource(known as never) : value
      }
      case "status":
        return LABELLED_STATUSES.has(value) ? tStatus(value as never) : value
      case "sort":
        return SORT_MODES.has(value) ? tSort(value as never) : value
      default:
        return value
    }
  }
}

export function PluginActiveFilters() {
  const t = useTranslations("plugins.activeFilters")
  const setFilters = usePluginsStore((s) => s.setFilters)
  const resetFilters = usePluginsStore((s) => s.resetFilters)
  const valueLabel = useChipValueLabel()
  const chips = useActiveFilterChips()
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
      {chips.map((chip) => {
        const value = valueLabel(chip)
        const label = value === undefined ? t(chip.labelKey) : t(chip.labelKey, { value })
        return (
          <Badge
            key={chip.key}
            variant="secondary"
            // A coarse pointer gets a 40px chip so its remove control can be
            // a 40px target (the Badge clips overflow, so a padded-out hit
            // area inside a 24px chip would be cut off).
            className="h-6 gap-1 pr-1 text-xs pointer-coarse:h-10 pointer-coarse:pr-0"
            data-testid={`plugin-active-filter-${chip.key}`}
          >
            <span className="max-w-[24ch] truncate" title={label}>
              {label}
            </span>
            <button
              type="button"
              className="rounded p-0.5 hover:bg-background/60 pointer-coarse:flex pointer-coarse:size-10 pointer-coarse:items-center pointer-coarse:justify-center"
              onClick={() => setFilters(chip.reset)}
              aria-label={t("removeAria", { name: label })}
            >
              <XIcon className="size-3" />
            </button>
          </Badge>
        )
      })}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs pointer-coarse:h-10"
        onClick={() => resetFilters()}
      >
        {t("clearAll")}
      </Button>
    </div>
  )
}
