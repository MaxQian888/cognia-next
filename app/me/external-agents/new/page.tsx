"use client"

/** Step one of adding an external agent on the phone: pick one. */

import { useTranslations } from "next-intl"

import { PairedOnly } from "@/components/mobile/me/paired-only"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { AgentPresetPicker } from "@/components/mobile/external-agents/agent-preset-picker"
import { EXTERNAL_AGENTS_ROUTE } from "@/components/mobile/external-agents/routes"

export default function MobileAddExternalAgentPage() {
  const t = useTranslations("mobile.externalAgents")
  return (
    <SubPageShell
      title={t("pickTitle")}
      backAria={t("backToListAria")}
      backHref={EXTERNAL_AGENTS_ROUTE}
      testid="mobile-add-external-agent-page"
    >
      <PairedOnly>
        <AgentPresetPicker />
      </PairedOnly>
    </SubPageShell>
  )
}
