"use client"

import { useTranslations } from "next-intl"

import { DeviceInfoCard } from "@/components/mobile/me/device-info-card"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"

export default function MobileDeviceInfoPage() {
  const t = useTranslations("mobile.me")
  return (
    <SubPageShell
      title={t("deviceInfoRow")}
      backAria={t("appearanceBackAria")}
      testid="mobile-device-info-page"
    >
      <DeviceInfoCard />
    </SubPageShell>
  )
}
