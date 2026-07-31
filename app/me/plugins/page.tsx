"use client"

/**
 * Mobile Plugins page (ADR-0056). Lists installed plugins and toggles each
 * one's `enabled` flag. Available in BOTH runtime modes — the `plugins` Dexie
 * table is warmed by `sync_pull("plugins")` on a paired phone and is also
 * meaningful for the standalone shell's local plugin set, so there is no
 * `<PairedOnly>` gate here.
 *
 * The actual list + toggle UI is the existing `PluginsPanel` (Wave 2.6,
 * reused from the Discover surface). Each toggle writes through the
 * `plugin_set_enabled` outbound RPC — NOT `app_settings_update` — so no
 * mobile-settings allowlist key is required.
 */

import { useTranslations } from "next-intl"

import { PluginsPanel } from "@/components/mobile/discover/plugins-panel"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"

export default function MobilePluginsPage() {
  const t = useTranslations("mobile.plugins")
  return (
    <SubPageShell title={t("title")} backAria={t("backAria")} testid="mobile-plugins-page">
      <div className="flex flex-col gap-3">
        <p className="px-1 text-xs text-muted-foreground">{t("intro")}</p>
        <PluginsPanel />
      </div>
    </SubPageShell>
  )
}
