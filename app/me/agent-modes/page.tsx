"use client"

import { useTranslations } from "next-intl"

import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { CustomModeSettings } from "@/components/settings/agent/custom-mode-settings"

export default function MobileAgentModesPage() {
  const t = useTranslations("mobile.me")
  return (
    <SubPageShell
      title={t("agentModesRow")}
      backAria={t("appearanceBackAria")}
      width="wide"
      testid="mobile-agent-modes-page"
    >
      <CustomModeSettings />
    </SubPageShell>
  )
}
