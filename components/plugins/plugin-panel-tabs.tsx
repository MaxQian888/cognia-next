"use client"

// Tab list for the /plugins panel. Decomposed out of `plugin-panel.tsx` so
// future overrides (custom icons / hidden tabs / extra contributions from
// plugins) can swap this component without rewriting the whole panel.
//
// The list is wrapped in a horizontally scrollable container so all 7 tabs
// stay on a single row at every viewport — narrow widths get a scrolling
// shell instead of an awkward flex-wrap second row. Edge fade affordances
// are rendered only when the scroller actually overflows so desktop users
// can tell there are tabs out of view.

import { useRef } from "react"
import { useTranslations } from "next-intl"
import {
  BoxesIcon,
  ShoppingBagIcon,
  SettingsIcon,
  ShieldCheckIcon,
  ClockIcon,
  BarChart3Icon,
  BugIcon,
} from "lucide-react"
import { TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { useOverflowState } from "@/hooks/use-overflow-state"
import type { PluginPanelTab } from "@/stores/plugins"

const TABS: Array<{
  id: PluginPanelTab
  icon: React.ComponentType<{ className?: string }>
}> = [
  { id: "installed", icon: BoxesIcon },
  { id: "browse", icon: ShoppingBagIcon },
  { id: "configure", icon: SettingsIcon },
  { id: "permissions", icon: ShieldCheckIcon },
  { id: "scheduled", icon: ClockIcon },
  { id: "analytics", icon: BarChart3Icon },
  { id: "devtools", icon: BugIcon },
]

interface Props {
  className?: string
}

export function PluginPanelTabs({ className }: Props) {
  const t = useTranslations("plugins.tabs")
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const { hasOverflowLeft, hasOverflowRight } = useOverflowState(scrollerRef)

  return (
    <div className={cn("relative", className)}>
      <div
        ref={scrollerRef}
        className="overflow-x-auto -mx-4 lg:-mx-6 px-4 lg:px-6"
        data-testid="plugin-panel-tabs-scroller"
      >
        <TabsList className="inline-flex h-9 w-max whitespace-nowrap">
          {TABS.map(({ id, icon: Icon }) => (
            <TabsTrigger key={id} value={id} className="gap-1.5">
              <Icon className="size-3.5" />
              {t(id as never)}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {hasOverflowLeft && (
        <span
          aria-hidden
          data-testid="plugin-panel-tabs-fade-left"
          className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-background to-transparent"
        />
      )}
      {hasOverflowRight && (
        <span
          aria-hidden
          data-testid="plugin-panel-tabs-fade-right"
          className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-background to-transparent"
        />
      )}
    </div>
  )
}
