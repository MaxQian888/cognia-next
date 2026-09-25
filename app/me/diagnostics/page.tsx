"use client"

import { useTranslations } from "next-intl"

import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { DiagnosticsSection } from "@/components/settings/sections/diagnostics-section"

export default function MobileDiagnosticsPage() {
  const t = useTranslations("mobile.me")
  // `DiagnosticsSection` fills its parent (`h-full min-h-0`) for the two-pane
  // crash-log layout, so the body gets a fixed viewport height and no vertical
  // padding. The side padding stays: the section relies on the desktop
  // settings shell for it, and with `p-0` every tab, field and badge ran flush
  // to the phone's edges.
  return (
    <SubPageShell
      settingsPanel
      title={t("diagnosticsRow")}
      backAria={t("appearanceBackAria")}
      width="wide"
      bodyClassName="flex min-h-0 flex-col px-4 py-0 h-[calc(100dvh-3.25rem)]"
      testid="mobile-diagnostics-page"
    >
      <DiagnosticsSection />
    </SubPageShell>
  )
}
