"use client"

import { useTranslations } from "next-intl"

import { AboutSection } from "@/components/settings/about-section"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"

export default function MobileAboutPage() {
  const t = useTranslations("mobile.me")
  return (
    <SubPageShell
      title={t("aboutRow")}
      backAria={t("appearanceBackAria")}
      testid="mobile-about-page"
    >
      <AboutSection />
    </SubPageShell>
  )
}
