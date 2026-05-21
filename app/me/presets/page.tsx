"use client"

import { useTranslations } from "next-intl"

import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { PromptPresetsSection } from "@/components/settings/prompt-presets-section"

export default function MobilePresetsPage() {
  const t = useTranslations("mobile.me")
  return (
    <SubPageShell
      title={t("presetsRow")}
      backAria={t("presetsBackAria")}
      testid="mobile-presets-page"
    >
      <PromptPresetsSection mobile />
    </SubPageShell>
  )
}
