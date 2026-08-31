"use client"

/**
 * Mobile Plugins page (ADR-0056), reached from the Me tab.
 *
 * Renders the SAME body as `/plugins` on a phone. It used to render a separate
 * 94-line panel (`components/mobile/discover/plugins-panel.tsx`) whose only
 * affordance was an enable switch: no install, no permissions, no
 * configuration, no uninstall, and no code shared with the workspace. Two
 * mobile plugin surfaces meant every improvement had to be made twice, and one
 * of them was always behind.
 *
 * `SubPageShell` keeps the Me sub-page chrome (back arrow, safe-area top,
 * wallpaper target), so the body is asked to drop its own header rather than
 * stacking a second one.
 *
 * Available in BOTH runtime modes. The `plugins` Dexie table is warmed by
 * `sync_pull("plugins")` on a paired phone and is also meaningful for the
 * standalone shell's local plugin set, so there is no `<PairedOnly>` gate.
 * Which of the two a toggle means is decided by
 * `lib/plugin/core/set-plugin-enabled-for-host.ts` and stated in the body's
 * own banner.
 */

import { useTranslations } from "next-intl"

import { PluginsMobileBody } from "@/components/mobile/plugins/plugins-mobile-body"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"

export default function MobilePluginsPage() {
  const t = useTranslations("mobile.plugins")
  return (
    <SubPageShell
      title={t("title")}
      backAria={t("backAria")}
      testid="mobile-plugins-page"
      bodyClassName="flex min-h-0 flex-1 flex-col p-0"
    >
      <PluginsMobileBody showHeader={false} />
    </SubPageShell>
  )
}
