"use client"

/**
 * Mobile Appearance route — full-screen wrapper around the shared
 * `<AppearanceSection />` component used in the desktop Settings sidebar.
 *
 * Why reuse instead of rebuild
 * ----------------------------
 * `<AppearanceSection />` is already responsive:
 *   - its tab strip uses `overflow-x-auto` so it scrolls on narrow screens,
 *   - every tab reads/writes through `useSettingsStore`, which the mobile
 *     client wires to the same Dexie row + companion `app_settings_update`
 *     RPC the desktop uses,
 *   - the custom theme editor, wallpaper uploader, VSCode import dialog,
 *     and contrast audit all render unchanged inside a `space-y-*` column.
 *
 * Embedding the section directly into a mobile-shell page (instead of
 * routing through `/settings?section=appearance` and its desktop sidebar
 * chrome) gives phone users a focused, back-button-driven flow while
 * still inheriting every theme feature the desktop ships.
 */

import { useTranslations } from "next-intl"

import { AppearanceSection } from "@/components/settings/appearance"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"

export default function MobileAppearancePage() {
  const t = useTranslations("mobile.me")

  return (
    <SubPageShell
      title={t("sectionAppearance")}
      backAria={t("appearanceBackAria")}
      width="wide"
      testid="mobile-appearance-page"
    >
      <AppearanceSection />
    </SubPageShell>
  )
}
