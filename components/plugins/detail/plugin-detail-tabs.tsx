"use client"

// Tab strip for the right-pane detail surface — 5 flat sub-tabs replace
// the old 3-outer + 8-inner nesting. Backed by `detailSubTab` in the
// plugins store so deep links (`?subtab=permissions`) and the legacy
// `openConfigure` shortcut both stay in sync.

import { useTranslations } from "next-intl"
import {
  InfoIcon,
  BlocksIcon,
  SettingsIcon,
  ShieldCheckIcon,
  DatabaseIcon,
  ScrollTextIcon,
} from "lucide-react"
import type { ComponentType } from "react"
import { ScrollShadowRow } from "../scroll-shadow-row"
import { usePluginsStore } from "@/stores/plugins"
import type { PluginDetailSubTab } from "@/stores/plugins"
import { cn } from "@/lib/utils"

interface TabConfig {
  value: PluginDetailSubTab
  labelKey: string
  icon: ComponentType<{ className?: string }>
}

const TABS: ReadonlyArray<TabConfig> = [
  { value: "overview", labelKey: "subtab.overview", icon: InfoIcon },
  { value: "capabilities", labelKey: "subtab.capabilities", icon: BlocksIcon },
  { value: "configure", labelKey: "subtab.configure", icon: SettingsIcon },
  { value: "permissions", labelKey: "subtab.permissions", icon: ShieldCheckIcon },
  { value: "data", labelKey: "subtab.data", icon: DatabaseIcon },
  // Logs is python/hybrid-only (the host subprocess is the log source).
  { value: "logs", labelKey: "subtab.logs", icon: ScrollTextIcon },
]

export function PluginDetailTabs({ pluginType }: { pluginType?: string }) {
  const t = useTranslations("plugins.detail")
  const subTab = usePluginsStore((s) => s.detailSubTab)
  const setSubTab = usePluginsStore((s) => s.setDetailSubTab)
  const hasPythonHost = pluginType === "python" || pluginType === "hybrid"
  const tabs = hasPythonHost ? TABS : TABS.filter(({ value }) => value !== "logs")
  return (
    <ScrollShadowRow className="shrink-0 border-b">
      <div role="tablist" aria-label={t("subtabAria")} className="flex items-center gap-1 px-2">
        {tabs.map(({ value, labelKey, icon: Icon }) => {
          const active = subTab === value
          return (
            <button
              key={value}
              role="tab"
              aria-selected={active}
              type="button"
              onClick={() => setSubTab(value)}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2",
                "transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                active
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
              data-testid={`plugin-detail-subtab-${value}`}
            >
              <Icon className="size-3.5" />
              {t(labelKey)}
            </button>
          )
        })}
      </div>
    </ScrollShadowRow>
  )
}
