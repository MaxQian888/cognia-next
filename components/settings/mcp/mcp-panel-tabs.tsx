"use client"

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { ActivityIcon, PlugZapIcon, ServerIcon, ShoppingBagIcon } from "lucide-react"

import { PanelTabStrip, type PanelTab } from "@/components/common/panel-tab-strip"
import { useMcpPanelStore, type McpPanelTab } from "@/stores/mcp/mcp-panel-store"

const TAB_DEFS: { id: McpPanelTab; labelKey: string; icon: PanelTab<McpPanelTab>["icon"] }[] = [
  { id: "my-servers", labelKey: "myServers", icon: ServerIcon },
  { id: "presets", labelKey: "presets", icon: ShoppingBagIcon },
  { id: "agents", labelKey: "agents", icon: PlugZapIcon },
  { id: "health", labelKey: "health", icon: ActivityIcon },
]

/**
 * Panel tab bar. The narrowing contract lives in `PanelTabStrip`, which this
 * file used to carry its own copy of.
 */
export function McpPanelTabs({ className }: { className?: string }) {
  const t = useTranslations("mcp.tabs")
  const activeTab = useMcpPanelStore((s) => s.activeTab)
  const setActiveTab = useMcpPanelStore((s) => s.setActiveTab)

  const tabs = useMemo<PanelTab<McpPanelTab>[]>(
    () => TAB_DEFS.map((tab) => ({ id: tab.id, label: t(tab.labelKey), icon: tab.icon })),
    [t]
  )

  return (
    <PanelTabStrip
      tabs={tabs}
      value={activeTab}
      onValueChange={setActiveTab}
      className={className}
    />
  )
}
