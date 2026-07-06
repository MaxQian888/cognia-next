"use client"

import { useTranslations } from "next-intl"

import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { CharactersSection } from "@/components/settings/characters-section"

export default function MobileCharactersPage() {
  const t = useTranslations("mobile.me")
  return (
    <SubPageShell
      title={t("charactersRow")}
      backAria={t("appearanceBackAria")}
      width="wide"
      testid="mobile-characters-page"
    >
      <CharactersSection />
    </SubPageShell>
  )
}
