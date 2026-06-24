"use client"

// Left-rail category sidebar for the /plugins panel. Driven by the
// usePlugins() view-model so the badges always match the live row counts.
// Selecting a category writes through to `usePluginsStore.setFilters`.

import { useTranslations } from "next-intl"
import { LayersIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { usePlugins } from "@/hooks/plugins"
import { usePluginsStore } from "@/stores/plugins"
import { CAPABILITY_META } from "./plugin-capabilities"

export function PluginCategorySidebar() {
  const t = useTranslations("plugins.categorySidebar")
  const { totals, countsByCapability } = usePlugins()
  const filters = usePluginsStore((s) => s.filters)
  const setFilters = usePluginsStore((s) => s.setFilters)
  const active = filters.capability

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
      {CAPABILITY_META.map((meta) => {
        const count = countsByCapability[meta.id] ?? 0
        return (
          <SidebarItem
            key={meta.id}
            icon={meta.icon}
            active={active === meta.id}
            label={t(`capability.${meta.i18nKey}` as never)}
            count={count}
            onClick={() => setFilters({ capability: meta.id })}
            disabled={count === 0}
          />
        )
      })}
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
}: {
  icon: React.ComponentType<{ className?: string }>
  active: boolean
  label: string
  count: number
  onClick: () => void
  disabled?: boolean
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
      <span className="flex-1 text-left truncate">{label}</span>
      <Badge variant="outline" className="text-xs">
        {count}
      </Badge>
    </Button>
  )
}
