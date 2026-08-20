"use client"

import type { ComponentType } from "react"
import { useTranslations } from "next-intl"
import { ActivityIcon, PlugZapIcon, ServerIcon, ShoppingBagIcon } from "lucide-react"

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { useMcpPanelStore, type McpPanelTab } from "@/stores/mcp/mcp-panel-store"

const TAB_DEFS: {
  id: McpPanelTab
  labelKey: string
  icon: ComponentType<{ className?: string }>
}[] = [
  { id: "my-servers", labelKey: "myServers", icon: ServerIcon },
  { id: "presets", labelKey: "presets", icon: ShoppingBagIcon },
  { id: "agents", labelKey: "agents", icon: PlugZapIcon },
  { id: "health", labelKey: "health", icon: ActivityIcon },
]

/**
 * Panel tab bar.
 *
 * No `overflow-x-auto`: an unbounded width makes the `w-fit` list render at
 * max-content and overflow a narrow pane, which is what produced the
 * scroll-into-view jitter when a half-hidden tab was clicked. Triggers shrink
 * and truncate instead — compact when there is room, narrow when there isn't,
 * never scrolling.
 */
export function McpPanelTabs({ className }: { className?: string }) {
  const t = useTranslations("mcp.tabs")
  const activeTab = useMcpPanelStore((s) => s.activeTab)
  const setActiveTab = useMcpPanelStore((s) => s.setActiveTab)

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => setActiveTab(value as McpPanelTab)}
      className={cn(className)}
    >
      <TabsList className="max-w-full">
        {TAB_DEFS.map((tab) => {
          const Icon = tab.icon
          return (
            <TabsTrigger key={tab.id} value={tab.id} className="min-w-0 flex-initial text-xs">
              <Icon className="size-3.5 shrink-0" />
              <span className="truncate">{t(tab.labelKey)}</span>
            </TabsTrigger>
          )
        })}
      </TabsList>
    </Tabs>
  )
}
