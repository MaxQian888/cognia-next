"use client"

/**
 * Settings → Account → Sync devices (ADR-0215 phase 2), shown to a profile
 * signed in to the official account when this build has the feature.
 *
 * It reads the poller's view of the space and offers what this device can do
 * from where it stands: set up the first device, join by approval or with the
 * sync recovery key, or manage the device list. A "nothing syncs yet" badge
 * says what phase 2 is: keys and devices, no data.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { accountSyncEnabled } from "@/lib/account-sync/feature-flag"
import { useAccountSyncStore } from "@/stores/account-sync/account-sync-store"

import { FirstDeviceSetup } from "./first-device-setup"
import { JoinRequestPanel } from "./join-request-panel"
import { RecoveryKeyForm } from "./recovery-key-form"
import { RemovedFromSyncNotice } from "./removed-from-sync-notice"
import { SyncDeviceList } from "./sync-device-list"

export interface AccountSyncSectionProps {
  /** How the person knows their account (email or name), printed in the recovery kit. */
  account: string
}

type JoinMode = "choose" | "approval" | "recovery-key"

export function AccountSyncSection({ account }: AccountSyncSectionProps) {
  const t = useTranslations("accountSync")
  const view = useAccountSyncStore((state) => state.view)
  const context = useAccountSyncStore((state) => state.context)
  const incoming = useAccountSyncStore((state) => state.incoming)
  const error = useAccountSyncStore((state) => state.error)
  const requestRefresh = useAccountSyncStore((state) => state.requestRefresh)
  const openApproval = useAccountSyncStore((state) => state.openApproval)
  const [joinMode, setJoinMode] = useState<JoinMode>("choose")
  const [rejoining, setRejoining] = useState(false)

  const refresh = useCallback(() => {
    setJoinMode("choose")
    setRejoining(false)
    requestRefresh()
  }, [requestRefresh])

  if (!accountSyncEnabled()) return null

  const joinChooser = context ? (
    joinMode === "approval" ? (
      <JoinRequestPanel context={context} onDone={refresh} />
    ) : joinMode === "recovery-key" ? (
      <RecoveryKeyForm
        context={context}
        account={account}
        onDone={refresh}
        onBack={() => setJoinMode("choose")}
      />
    ) : (
      <div className="flex flex-col gap-2" data-testid="account-sync-join-choose">
        <h5 className="text-sm font-medium">{t("join.title")}</h5>
        <p className="text-xs text-muted-foreground">{t("join.description")}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() => setJoinMode("approval")}
            data-testid="account-sync-choose-approval"
          >
            {t("join.askApproval")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setJoinMode("recovery-key")}
            data-testid="account-sync-choose-recovery"
          >
            {t("join.useRecoveryKey")}
          </Button>
        </div>
      </div>
    )
  ) : null

  let body: React.ReactNode
  switch (view.kind) {
    case "idle":
      body = (
        <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
          <Spinner className="size-3" />
          {t("section.loading")}
        </p>
      )
      break
    case "signed-out":
      body = <p className="text-xs text-muted-foreground">{t("section.signedOut")}</p>
      break
    case "locked":
      body = <p className="text-xs text-muted-foreground">{t("section.locked")}</p>
      break
    case "integrity":
      body = (
        <Alert variant="destructive" data-testid="account-sync-integrity">
          <AlertTitle>{t("section.integrityTitle")}</AlertTitle>
          <AlertDescription>{t("section.integrity")}</AlertDescription>
        </Alert>
      )
      break
    case "removed":
      body = rejoining ? (
        joinChooser
      ) : (
        <RemovedFromSyncNotice removal={view.removal} onRejoin={() => setRejoining(true)} />
      )
      break
    case "not-enrolled":
      body =
        view.space === "empty" && context ? (
          <FirstDeviceSetup
            context={context}
            account={account}
            onDone={refresh}
            onSpaceExists={refresh}
          />
        ) : (
          joinChooser
        )
      break
    case "enrolled":
      body = context ? (
        <div className="flex flex-col gap-3">
          {incoming.length > 0 ? (
            <Alert data-testid="account-sync-waiting">
              <AlertDescription className="flex items-center justify-between gap-2">
                <span>{t("devices.waiting", { count: incoming.length })}</span>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => openApproval(incoming[0]!.requestId)}
                  data-testid="account-sync-review"
                >
                  {t("devices.review")}
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          <SyncDeviceList
            context={context}
            device={view.device}
            registry={view.registry}
            account={account}
            onChanged={requestRefresh}
          />
        </div>
      ) : null
      break
  }

  return (
    <section
      className="flex flex-col gap-3 border-t pt-4"
      data-testid="account-sync-section"
      data-view={view.kind}
    >
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h4 className="text-xs font-medium text-muted-foreground">{t("section.title")}</h4>
          <Badge variant="outline" data-testid="account-sync-preview-badge">
            {t("section.preview")}
          </Badge>
        </div>
        <p className="text-[11px] text-muted-foreground">{t("section.previewHint")}</p>
      </div>
      {body}
      {error ? (
        <div className="flex items-center gap-2">
          <p role="alert" className="text-xs text-destructive">
            {t("section.pollError", { message: error.message })}
          </p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={requestRefresh}
            data-testid="account-sync-retry"
          >
            {t("section.retry")}
          </Button>
        </div>
      ) : null}
    </section>
  )
}
