"use client"

import { useTranslations } from "next-intl"

import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { ArtifactsSection } from "@/components/settings/artifacts-section"

export default function MobileArtifactsPage() {
  const t = useTranslations("mobile.me")
  return (
    <SubPageShell
      title={t("artifactsRow")}
      backAria={t("appearanceBackAria")}
      width="wide"
      testid="mobile-artifacts-page"
    >
      <ArtifactsSection />
    </SubPageShell>
  )
}
