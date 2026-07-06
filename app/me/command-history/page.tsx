"use client"

/**
 * Mobile command-history page (ADR-0039 phase 2). Read-only browse/search over
 * the durable terminal command history mirrored from the paired desktop by the
 * `terminalHistory` sync handler. The phone never writes history back — the
 * only affordance is tap-to-copy (see `MobileCommandHistory`).
 */

import { useTranslations } from "next-intl"

import { MobileCommandHistory } from "@/components/mobile/mobile-command-history"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"

export default function MobileCommandHistoryPage() {
  const t = useTranslations("mobile.commandHistory")
  return (
    <SubPageShell title={t("title")} backAria={t("backAria")} testid="mobile-command-history-page">
      <MobileCommandHistory />
    </SubPageShell>
  )
}
