"use client"

/** This device was removed by another one (protocol §5.5); its keys are gone, its data is not. */

import { useTranslations } from "next-intl"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import type { RemovalRecord } from "@/lib/account-sync/vault-store"

export function RemovedFromSyncNotice({
  removal,
  onRejoin,
}: {
  removal: RemovalRecord
  onRejoin: () => void
}) {
  const t = useTranslations("accountSync.removed")
  return (
    <Alert data-testid="account-sync-removed">
      <AlertTitle>{t("title")}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <span>{t("body", { date: new Date(removal.at).toLocaleString() })}</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="self-start"
          onClick={onRejoin}
          data-testid="account-sync-rejoin"
        >
          {t("rejoin")}
        </Button>
      </AlertDescription>
    </Alert>
  )
}
