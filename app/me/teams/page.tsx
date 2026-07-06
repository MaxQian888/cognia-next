"use client"

import { useTranslations } from "next-intl"

import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { TeamsSection } from "@/components/settings/teams-section"

export default function MobileTeamsPage() {
  const t = useTranslations("mobile.me")
  return (
    <SubPageShell
      title={t("teamsRow")}
      backAria={t("appearanceBackAria")}
      width="wide"
      testid="mobile-teams-page"
    >
      <TeamsSection />
    </SubPageShell>
  )
}
