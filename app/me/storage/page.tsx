"use client"

import { useTranslations } from "next-intl"

import { StorageOverview } from "@/components/mobile/me/storage-overview"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"

export default function MobileStoragePage() {
  const t = useTranslations("mobile.me")
  return (
    <SubPageShell
      title={t("storageRow")}
      backAria={t("appearanceBackAria")}
      testid="mobile-storage-page"
      width="wide"
    >
      <StorageOverview />
    </SubPageShell>
  )
}
