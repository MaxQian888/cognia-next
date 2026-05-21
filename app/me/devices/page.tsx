"use client"

import { useTranslations } from "next-intl"

import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { PairedDevicesCard } from "@/components/settings/companion/paired-devices-card"

export default function MobileDevicesPage() {
  const t = useTranslations("mobile.me")
  return (
    <SubPageShell
      title={t("devicesRow")}
      backAria={t("appearanceBackAria")}
      testid="mobile-devices-page"
    >
      <PairedDevicesCard />
    </SubPageShell>
  )
}
