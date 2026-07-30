"use client"

/**
 * Mobile Appearance route — full-screen wrapper around the shared
 * `<AppearanceSection />` component used in the desktop Settings sidebar.
 *
 * Why reuse instead of rebuild
 * ----------------------------
 * `<AppearanceSection />` is already responsive:
 *   - its tab strip uses `overflow-x-auto` so it scrolls on narrow screens,
 *   - every tab reads/writes through `useSettingsStore`, whose persistence
 *     funnel mirrors host-writable keys up to the paired desktop
 *     (`lib/settings/mirror-to-host.ts`),
 *   - the custom theme editor, wallpaper uploader, VSCode import dialog,
 *     and contrast audit all render unchanged inside a `space-y-*` column.
 *
 * That mirroring is recent. This comment previously claimed the same thing
 * while it was not true: the section writes through the store, the store only
 * wrote locally, and the enqueue lived in a hook the section never called — so
 * every appearance edit made on the phone stayed on the phone.
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
