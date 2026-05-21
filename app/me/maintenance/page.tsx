"use client"

import { useTranslations } from "next-intl"

import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { MaintenanceTab } from "@/components/settings/data/tabs/maintenance-tab"

export default function MobileMaintenancePage() {
  const t = useTranslations("mobile.me")
  return (
    <SubPageShell
      title={t("dexieMaintenance")}
      backAria={t("appearanceBackAria")}
      testid="mobile-maintenance-page"
    >
      <MaintenanceTab />
    </SubPageShell>
  )
}
