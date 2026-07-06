"use client"

import { useTranslations } from "next-intl"

import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { MemorySection } from "@/components/settings/sections/memory-section"

export default function MobileMemorySettingsPage() {
  const t = useTranslations("mobile.me")
  return (
    <SubPageShell
      title={t("memorySettingsRow")}
      backAria={t("appearanceBackAria")}
      width="wide"
      testid="mobile-memory-settings-page"
    >
      <MemorySection />
    </SubPageShell>
  )
}
