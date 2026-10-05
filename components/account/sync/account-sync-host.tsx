"use client"

/**
 * The app-wide half of account sync (ADR-0215 phases 2 and 3a): the
 * foreground poller, the data engine, the notification action that opens an
 * approval, the approval dialog and the merge-or-replace dialog. Mounted once
 * at the app root.
 *
 * With the build flag off this renders null before any hook runs: no poller,
 * no engine, no session read, no request to the sync host
 * (`account-sync-host.test.tsx`).
 */

import { useCallback, useEffect } from "react"
import { useTranslations } from "next-intl"

import { useAccountSyncEngine } from "@/hooks/account-sync/use-account-sync-engine"
import { useAccountSyncPoller } from "@/hooks/account-sync/use-account-sync-poller"
import { OPEN_APPROVAL_COMMAND } from "@/lib/account-sync/approval-notifications"
import type { IncomingRequest } from "@/lib/account-sync/enrollment/approve"
import { accountSyncEnabled } from "@/lib/account-sync/feature-flag"
import { registerNotificationCommand } from "@/lib/notifications/action-registry"
import { useAccountSyncStore } from "@/stores/account-sync/account-sync-store"

import { ApproveDeviceDialog } from "./approve-device-dialog"
import { JoinChoiceDialog } from "./join-choice-dialog"

export function AccountSyncHost() {
  if (!accountSyncEnabled()) return null
  return <AccountSyncRuntime />
}

function AccountSyncRuntime() {
  const t = useTranslations("accountSync")
  const notificationText = useCallback(
    (request: IncomingRequest) => ({
      title: t("notification.title"),
      body: t("notification.body", {
        name: request.displayName || t("approve.unknownName"),
        platform: t(`devices.platform.${request.platform}`),
      }),
      open: t("notification.open"),
    }),
    [t]
  )
  useAccountSyncPoller({ enabled: true, notificationText })
  useAccountSyncEngine({ enabled: true })

  useEffect(
    () =>
      registerNotificationCommand(OPEN_APPROVAL_COMMAND, ({ args }) => {
        const requestId = args?.requestId
        if (typeof requestId === "string") useAccountSyncStore.getState().openApproval(requestId)
      }),
    []
  )

  return (
    <>
      <ApproveDeviceDialog />
      <JoinChoiceDialog />
    </>
  )
}
