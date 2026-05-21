"use client"

import { useTranslations } from "next-intl"

import { StorageUsageCard } from "@/components/mobile/me/storage-usage-card"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"

export default function MobileStoragePage() {
  const t = useTranslations("mobile.me")
  return (
    <SubPageShell
      title={t("storageRow")}
      backAria={t("appearanceBackAria")}
      testid="mobile-storage-page"
    >
      <StorageUsageCard />
    </SubPageShell>
  )
}
