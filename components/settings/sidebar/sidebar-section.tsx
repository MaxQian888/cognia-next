"use client"

/**
 * Settings → Sidebar section. Hosts the shared `<SidebarCustomizer/>` inline so
 * the left-rail layout can be edited from `/settings?section=sidebar` as well as
 * from the rail's own "Customize" dialog.
 */

import * as React from "react"
import { useTranslations } from "next-intl"

import { SidebarCustomizer } from "@/components/shell/sidebar-customizer"

export function SidebarSection(): React.ReactElement {
  const t = useTranslations("desktop.guildRail")
  return (
    <div className="space-y-4" data-testid="settings-sidebar-section">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t("customize.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("customize.description")}</p>
      </div>
      <SidebarCustomizer />
    </div>
  )
}
