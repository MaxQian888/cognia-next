"use client"

/**
 * Pause, resume and revoke for a paired device, in the device masthead.
 *
 * They used to close the Access card, under every grant switch. They act on
 * the whole device rather than on any one grant, so they belong beside the
 * device's name, where they stay in reach from anywhere in the pane.
 *
 * Two things this adds over the block it replaces:
 *
 *  * **Revoke asks.** It cannot be undone from here: the device key is
 *    revoked and the device has to pair again. The biometric prompt was the
 *    only gate, and Settings → Security can switch that off for revocation, at
 *    which point one click (a mis-click beside "Pause") revoked the device.
 *    The confirmation is the gate that does not depend on that preference.
 *  * **A disabled control says why.** All three are `host-admin` writes, which
 *    a standalone browser and a non-owner companion cannot make. The buttons
 *    were disabled with nothing beside them, the shape working rule 7 exists
 *    to rule out, so the reason is now rendered under them.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { InfoIcon, PauseIcon, PlayIcon, TrashIcon } from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { useHostAdminReach } from "@/hooks/connectivity/use-host-admin-reach"
import type { DeviceGrantActions } from "@/hooks/devices/use-device-grant-actions"
import type { DeviceRow } from "@/lib/devices/types"

export interface PairedDeviceLifecycleProps {
  row: DeviceRow
  actions: DeviceGrantActions
}

/** The buttons. Rendered in the masthead's action slot. */
export function PairedDeviceLifecycle({ row, actions }: PairedDeviceLifecycleProps) {
  const t = useTranslations("devices")
  /**
   * Every Host mounts owner routes for these three (ADR-0170 batch 4), so a
   * paired companion that is the owner device reaches them over HTTP
   * (`lib/devices/lifecycle-http.ts`). Only a shell with no Host, or one that
   * is not the owner, has nowhere to send the change.
   */
  const reach = useHostAdminReach("host-admin")
  const [confirmRevoke, setConfirmRevoke] = useState(false)

  if (row.kind !== "paired-device") return null
  const deviceId = row.deviceId ?? ""
  const revoked = row.adminState === "revoked"
  const paused = row.adminState === "paused"
  const blocked = !reach.available

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="paired-device-lifecycle">
      {!revoked && !paused ? (
        <Button
          size="sm"
          variant="outline"
          disabled={blocked}
          onClick={() => void actions.pause(deviceId, row.label)}
          title={t("access.pauseHint")}
          data-testid={`paired-device-pause-${deviceId}`}
        >
          <PauseIcon className="size-3.5" />
          {t("access.pause")}
        </Button>
      ) : null}
      {!revoked && paused ? (
        <Button
          size="sm"
          disabled={blocked}
          onClick={() => void actions.resume(deviceId, row.label)}
          data-testid={`paired-device-resume-${deviceId}`}
        >
          <PlayIcon className="size-3.5" />
          {t("access.resume")}
        </Button>
      ) : null}
      {revoked ? null : (
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          disabled={blocked}
          onClick={() => setConfirmRevoke(true)}
          data-testid={`paired-device-revoke-${deviceId}`}
        >
          <TrashIcon className="size-3.5" />
          {t("access.revoke")}
        </Button>
      )}

      <AlertDialog open={confirmRevoke} onOpenChange={setConfirmRevoke}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("access.revokeConfirmTitle", { label: row.label })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("access.revokeConfirmBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("host.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmRevoke(false)
                void actions.revoke(deviceId, row.label)
              }}
              data-testid={`paired-device-revoke-confirm-${deviceId}`}
            >
              {t("access.revoke")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/**
 * Why the lifecycle buttons above are disabled, under the masthead.
 *
 * Separate from the buttons because the masthead lays them out in different
 * rows: the buttons sit beside the name, a sentence needs the full width.
 */
export function PairedDeviceLifecycleNotice({ row }: { row: DeviceRow }) {
  const t = useTranslations("devices.access")
  const reach = useHostAdminReach("host-admin")
  if (row.kind !== "paired-device" || row.adminState === "revoked") return null
  if (reach.available || !reach.block) return null
  // Own copy rather than Settings' `HostReachNotice`: that one explains why
  // the Host's *reachability* cannot be configured, which is the wrong
  // sentence beside a Pause button.
  return (
    <p
      role="status"
      className="mt-2.5 flex items-start gap-2 rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground"
      data-testid="paired-device-lifecycle-blocked"
      data-reach={reach.block}
    >
      <InfoIcon aria-hidden className="mt-px size-3.5 shrink-0" />
      <span>{t(`lifecycleBlocked.${reach.block}`)}</span>
    </p>
  )
}
