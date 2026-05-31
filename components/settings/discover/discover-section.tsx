"use client"

/**
 * Settings → Discover section. Hosts the shared `<DiscoverCustomizer/>` inline
 * so the discover category layout can be edited from
 * `/settings?section=discover` as well as from the discover sidebar's own
 * "Customize" dialog. Mirrors `components/settings/sidebar/sidebar-section.tsx`.
 */

import * as React from "react"
import { useTranslations } from "next-intl"

import { DiscoverCustomizer } from "@/components/discover/discover-customizer"

export function DiscoverSection(): React.ReactElement {
  const t = useTranslations("discover")
  return (
    <div className="space-y-4" data-testid="settings-discover-section">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t("customize.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("customize.description")}</p>
      </div>
      <DiscoverCustomizer />
    </div>
  )
}
