"use client"

// "Typography & density" panel. `layout-tab` was only 58 lines (density +
// corner radius) — too thin to earn its own nav entry, and it is what you tune
// alongside type anyway. Both children are unchanged; this file only composes
// them.

import { useTranslations } from "next-intl"
import { SettingsDivider } from "../../common/settings-section"
import { LayoutTab } from "../tabs/layout-tab"
import { TypographyTab } from "../tabs/typography-tab"

export function AppearanceTypographyPanel() {
  const t = useTranslations("settings.appearance.typographyPanel")
  return (
    <div className="space-y-4" data-testid="appearance-typography-panel">
      <section className="space-y-3">
        <h3 className="text-sm font-medium">{t("fontsTitle")}</h3>
        <TypographyTab />
      </section>
      <SettingsDivider />
      <section className="space-y-3">
        <h3 className="text-sm font-medium">{t("layoutTitle")}</h3>
        <LayoutTab />
      </section>
    </div>
  )
}
