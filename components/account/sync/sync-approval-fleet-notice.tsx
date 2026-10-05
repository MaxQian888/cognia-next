"use client"

/** The devices console's notice that new devices wait for a sync approval (ADR-0215 phase 2). */

import { useTranslations } from "next-intl"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { accountSyncEnabled } from "@/lib/account-sync/feature-flag"
import { useAccountSyncStore } from "@/stores/account-sync/account-sync-store"

export function SyncApprovalFleetNotice() {
  const t = useTranslations("accountSync.fleet")
  const incoming = useAccountSyncStore((state) => state.incoming)
  const openApproval = useAccountSyncStore((state) => state.openApproval)
  if (!accountSyncEnabled() || incoming.length === 0) return null
  return (
    <Alert className="px-3 py-2" data-testid="sync-approval-fleet-notice">
      <AlertTitle className="text-xs">{t("waitingTitle")}</AlertTitle>
      <AlertDescription className="flex items-center justify-between gap-2 text-[11px] leading-snug">
        <span>{t("waitingBody", { count: incoming.length })}</span>
        <Button size="sm" variant="outline" onClick={() => openApproval(incoming[0]!.requestId)}>
          {t("review")}
        </Button>
      </AlertDescription>
    </Alert>
  )
}
