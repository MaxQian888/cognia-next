"use client"

/**
 * Settings → Interface → Shell layout. Hosts `<ShellLayoutCustomizer/>` inline
 * so the nav rail, the top bar and the bottom bar can all be edited from
 * `/settings?section=sidebar` as well as from each surface's own "Customize"
 * dialog.
 *
 * The section id stays `sidebar` so existing deep links keep working; only its
 * scope grew.
 */

import * as React from "react"
import { useTranslations } from "next-intl"

import { ShellLayoutCustomizer } from "@/components/shell/shell-layout-customizer"

export function ShellLayoutSection(): React.ReactElement {
  const t = useTranslations("desktop.shellLayout")
  return (
    <div className="space-y-4" data-testid="settings-shell-layout-section">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("description.section")}</p>
      </div>
      <ShellLayoutCustomizer />
    </div>
  )
}
