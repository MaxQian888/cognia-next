"use client"

import { useTranslations } from "next-intl"

import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { DiagnosticsSection } from "@/components/settings/sections/diagnostics-section"

export default function MobileDiagnosticsPage() {
  const t = useTranslations("mobile.me")
  // `DiagnosticsSection` fills its parent (`h-full min-h-0`) for the two-pane
  // crash-log layout. Give the body a fixed viewport height and no padding so
  // it has a height to fill under `SubPageShell` (which is not a flex parent).
  return (
    <SubPageShell
      title={t("diagnosticsRow")}
      backAria={t("appearanceBackAria")}
      width="wide"
      bodyClassName="flex min-h-0 flex-col p-0 h-[calc(100dvh-3.25rem)]"
      testid="mobile-diagnostics-page"
    >
      <DiagnosticsSection />
    </SubPageShell>
  )
}
