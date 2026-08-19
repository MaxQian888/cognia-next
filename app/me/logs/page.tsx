"use client"

import { useTranslations } from "next-intl"

import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { LogsSection } from "@/components/settings/logs/logs-section"

export default function MobileLogsPage() {
  const t = useTranslations("mobile.me")
  // `onClose` is only used to dismiss a host dialog on desktop; there is no
  // enclosing dialog in the `/me` flow, so it is intentionally omitted.
  return (
    <SubPageShell
      title={t("logsRow")}
      backAria={t("appearanceBackAria")}
      width="wide"
      testid="mobile-logs-page"
    >
      <LogsSection />
    </SubPageShell>
  )
}
