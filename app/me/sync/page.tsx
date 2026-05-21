"use client"

import { useTranslations } from "next-intl"

import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { SyncStatusPanel } from "@/components/mobile/me/sync-status-panel"

export default function MobileSyncPage() {
  const t = useTranslations("mobile.me")
  return (
    <SubPageShell title={t("syncRow")} backAria={t("appearanceBackAria")} testid="mobile-sync-page">
      <SyncStatusPanel />
    </SubPageShell>
  )
}
