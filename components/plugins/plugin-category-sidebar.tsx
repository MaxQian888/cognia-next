"use client"

// Left-rail capability sidebar for the /plugins panel. Driven by the
// usePlugins() view-model so the badges always match the live row counts.
// Selecting a capability writes through to `usePluginsStore.setFilters`.
//
// The list is DATA-DRIVEN, not a fixed catalogue. `PluginCapability` has 69
// members and `CAPABILITY_META` names 18 of them, so a curated-only rail could
// not filter on 51 capabilities that installed plugins genuinely declare: the
// rail simply had no row for them and the axis was unreachable. The rail now
// walks the capabilities actually present in the library, uses the curated
// icon and label when there is one, and renders the rest under "Other" with
// the raw capability id as its own label. Curated entries keep their order at
// the top, so the familiar rail is unchanged for a familiar library.

import { useTranslations } from "next-intl"
import { LayersIcon, ShapesIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { usePlugins } from "@/hooks/plugins"
import { usePluginsStore } from "@/stores/plugins"
import { CAPABILITY_META, type PluginCapabilityMeta } from "./plugin-capabilities"

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

export function PluginCategorySidebar() {
  const t = useTranslations("plugins.categorySidebar")
  const { totals, countsByCapability } = usePlugins()
  const filters = usePluginsStore((s) => s.filters)
  const setFilters = usePluginsStore((s) => s.setFilters)
  const active = filters.capability
  const { curated, other } = splitCapabilityRows(countsByCapability)

  return (
    <aside className="space-y-1 pr-2">
      <SidebarItem
        icon={LayersIcon}
        active={active === "all"}
        label={t("all")}
        count={totals.total}
        onClick={() => setFilters({ capability: "all" })}
      />
      <div className="h-px bg-border my-2" />
      {curated.map((meta) => (
        <SidebarItem
          key={meta.id}
          icon={meta.icon}
          active={active === meta.id}
          label={t(`capability.${meta.i18nKey}` as never)}
          count={meta.count}
          onClick={() => setFilters({ capability: meta.id })}
          disabled={meta.count === 0}
        />
      ))}
      {other.length > 0 && (
        <>
          <div className="px-2 pt-3 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            {t("otherHeading")}
          </div>
          {other.map((entry) => (
            <SidebarItem
              key={entry.id}
              icon={ShapesIcon}
              active={active === entry.id}
              // No curated label exists for these. The capability id is the
              // only honest name for it, and it is a stable contract value
              // rather than prose, so it is rendered as one.
              label={entry.id}
              monospaceLabel
              count={entry.count}
              onClick={() => setFilters({ capability: entry.id })}
            />
          ))}
        </>
      )}
    </aside>
  )
}

function SidebarItem({
  icon: Icon,
  active,
  label,
  count,
  onClick,
  disabled,
  monospaceLabel,
}: {
  icon: React.ComponentType<{ className?: string }>
  active: boolean
  label: string
  count: number
  onClick: () => void
  disabled?: boolean
  monospaceLabel?: boolean
}) {
  return (
    <Button
      variant={active ? "secondary" : "ghost"}
      size="sm"
      onClick={onClick}
      disabled={disabled}
      className={cn("w-full justify-start gap-2 h-8", disabled && "opacity-50")}
    >
      <Icon className="size-3.5" />
      <span className={cn("flex-1 truncate text-left", monospaceLabel && "font-mono text-[11px]")}>
        {label}
      </span>
      <Badge variant="outline" className="text-xs">
        {count}
      </Badge>
    </Button>
  )
}
