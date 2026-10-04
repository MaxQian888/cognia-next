"use client"

/**
 * Step two of adding an external agent on the phone: review and add it to the
 * Host. The preset arrives as `?preset=` because the app is a static export;
 * a dynamic segment would need every preset id known at build time, and
 * plugins register presets at runtime.
 */

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"

import { PairedOnly } from "@/components/mobile/me/paired-only"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { AddExternalAgentForm } from "@/components/mobile/external-agents/add-external-agent-form"
import { ADD_EXTERNAL_AGENT_ROUTE } from "@/components/mobile/external-agents/routes"
import { presetName } from "@/components/agent/external-agent/add-agent/preset-copy"
import { getPresetConfig } from "@/lib/ai/agent/external/config/presets"

function ConfigureScreen() {
  const t = useTranslations("mobile.externalAgents")
  const tSettings = useTranslations("externalAgent.settings")
  const presetId = useSearchParams().get("preset") || "custom"
  const preset = presetId === "custom" ? null : getPresetConfig(presetId)
  const title = preset
    ? t("configureTitle", { name: presetName(tSettings, presetId, preset) })
    : t("configureCustomTitle")
  return (
    <SubPageShell
      title={title}
      backAria={t("backToPickerAria")}
      backHref={ADD_EXTERNAL_AGENT_ROUTE}
      testid="mobile-configure-external-agent-page"
    >
      <PairedOnly>
        <AddExternalAgentForm presetId={presetId} />
      </PairedOnly>
    </SubPageShell>
  )
}

export default function MobileConfigureExternalAgentPage() {
  // `useSearchParams` needs a Suspense boundary above it in a static export,
  // and the title depends on it too, so the whole screen sits inside one.
  return (
    <Suspense fallback={null}>
      <ConfigureScreen />
    </Suspense>
  )
}
