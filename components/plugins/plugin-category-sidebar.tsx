"use client"

// The Library's capability facets. Driven by the usePlugins() view-model so
// the counts always match the live rows. Selecting a capability writes through
// to `usePluginsStore.setFilters`.
//
// Rendered in two places, one list each:
//   - the section nav rail, under Library (`plugin-nav-sidebar.tsx`), on a
//     desktop-width window;
//   - the "Categories" sheet (`dialogs/plugin-category-sheet.tsx`) wherever
//     the rail is not on screen (tablet, phone).
// It used to be a SECOND fixed 13rem rail beside the section nav, so a
// desktop window spent two columns of chrome before the list started, and
// most of the second one was capabilities nothing installed declared.
//
// The list is DATA-DRIVEN. Curated capabilities (`CAPABILITY_META`) come first
// in their declared order, then every other capability the library actually
// declares. A capability with no plugins is not listed (a row that can only
// filter to an empty list is noise) unless it is the active filter, which must
// stay visible so it can be seen and cleared. Every capability prints its
// name (`capabilityLabel`); only one the SDK catalog does not know prints its
// raw id.

import { useTranslations } from "next-intl"
import { LayersIcon, ShapesIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { usePlugins } from "@/hooks/plugins"
import { usePluginsStore } from "@/stores/plugins"
import { CAPABILITY_META, capabilityLabel, type PluginCapabilityMeta } from "./plugin-capabilities"

/**
 * Split the live capability counts into the curated rows (in their declared
 * order) and everything else the library actually declares.
 *
 * Exported for its own test: the split is the whole rule, and it is a lot
 * easier to pin here than through a rendered rail.
 */
export function splitCapabilityRows(countsByCapability: Record<string, number>): {
  curated: Array<{ id: string; i18nKey: string; icon: PluginCapabilityMeta["icon"]; count: number }>
  other: Array<{ id: string; count: number }>
} {
  const curatedIds = new Set(CAPABILITY_META.map((meta) => meta.id))
  return {
    curated: CAPABILITY_META.map((meta) => ({ ...meta, count: countsByCapability[meta.id] ?? 0 })),
    other: Object.entries(countsByCapability)
      .filter(([id, count]) => !curatedIds.has(id) && count > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, count]) => ({ id, count })),
  }
}

export interface PluginCategorySidebarProps {
  /**
   * `"rail"` (inside the nav rail): compact rows that align with the section
   * rows above them. `"sheet"`: the same list at sheet density.
   */
  variant?: "rail" | "sheet"
  /** Called after a facet is chosen (the sheet closes itself with it). */
  onSelect?: () => void
}

export function PluginCategorySidebar({ variant = "sheet", onSelect }: PluginCategorySidebarProps) {
  const t = useTranslations("plugins.categorySidebar")
  const { totals, countsByCapability } = usePlugins()
  const filters = usePluginsStore((s) => s.filters)
  const setFilters = usePluginsStore((s) => s.setFilters)
  const active = filters.capability
  const { curated, other } = splitCapabilityRows(countsByCapability)
  const visibleCurated = curated.filter((meta) => meta.count > 0 || meta.id === active)
  const otherIds = new Set(other.map((entry) => entry.id))
  // An active filter on a capability no plugin declares any more (it was
  // uninstalled under the filter) still gets a row, so it can be cleared.
  const orphanActive =
    active !== "all" && !visibleCurated.some((meta) => meta.id === active) && !otherIds.has(active)
      ? [{ id: active, count: 0 }]
      : []
  const visibleOther = [...other, ...orphanActive]

  const choose = (capability: string) => {
    setFilters({ capability })
    onSelect?.()
  }

  return (
    <div
      role="group"
      aria-label={t("heading")}
      className={cn("space-y-0.5", variant === "sheet" && "space-y-1")}
      data-testid="plugin-category-facets"
    >
      <FacetItem
        icon={LayersIcon}
        active={active === "all"}
        label={t("all")}
        count={totals.total}
        onClick={() => choose("all")}
        variant={variant}
      />
      {visibleCurated.map((meta) => (
        <FacetItem
          key={meta.id}
          icon={meta.icon}
          active={active === meta.id}
          label={t(`capability.${meta.i18nKey}` as never)}
          count={meta.count}
          onClick={() => choose(meta.id)}
          variant={variant}
        />
      ))}
      {visibleOther.length > 0 && (
        <>
          <div className="px-2 pt-2.5 pb-1 text-[11px] font-medium text-muted-foreground">
            {t("otherHeading")}
          </div>
          {visibleOther.map((entry) => {
            const { label, known } = capabilityLabel(t as never, entry.id)
            return (
              <FacetItem
                key={entry.id}
                icon={ShapesIcon}
                active={active === entry.id}
                label={label}
                title={entry.id}
                monospaceLabel={!known}
                count={entry.count}
                onClick={() => choose(entry.id)}
                variant={variant}
              />
            )
          })}
        </>
      )}
    </div>
  )
}

function FacetItem({
  icon: Icon,
  active,
  label,
  title,
  count,
  onClick,
  monospaceLabel,
  variant,
}: {
  icon: React.ComponentType<{ className?: string }>
  active: boolean
  label: string
  title?: string
  count: number
  onClick: () => void
  monospaceLabel?: boolean
  variant: "rail" | "sheet"
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      className={cn(
        "w-full justify-start gap-2 px-2 font-normal",
        variant === "rail" ? "h-7 text-[13px] pointer-coarse:h-10" : "h-9 pointer-coarse:h-11",
        active ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground"
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-left",
          monospaceLabel && "font-mono text-[11px]"
        )}
      >
        {label}
      </span>
      {/* A plain number, not an outlined badge per row: twenty boxed counts
          down a rail were most of its ink. */}
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{count}</span>
    </Button>
  )
}
