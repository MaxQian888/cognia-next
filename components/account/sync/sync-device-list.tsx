"use client"

/**
 * The verified device list of an enrolled device (protocol §4, §5.5): names
 * opened with this device's epoch keys, the list fingerprint to compare
 * across devices, and the changes an enrolled device can make: remove
 * another device, rotate the keys, replace the sync recovery key.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { KeyRoundIcon, MonitorIcon, RefreshCwIcon, SmartphoneIcon, GlobeIcon } from "lucide-react"
import { toast } from "sonner"

import { listActiveDevices, type FoldedRegistry, type RegistryDevice } from "@cognia/sync-protocol"

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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { DeviceKeys } from "@/lib/account-sync/crypto"
import { deviceNames } from "@/lib/account-sync/device-names"
import type { AccountSyncContext } from "@/lib/account-sync/enrollment/context"
import { registryFingerprint } from "@/lib/account-sync/enrollment/fingerprint"
import {
  commitRecoveryKey,
  prepareRecoveryKey,
  revokeDevice,
  rotateKeys,
  type PreparedRecoveryKey,
} from "@/lib/account-sync/enrollment/manage"
import { currentKeyChain } from "@/lib/account-sync/registry-sync"

import { explainSyncError } from "./explain-sync-error"
import { RecoveryKeySetup } from "./recovery-key-setup"

export interface SyncDeviceListProps {
  context: AccountSyncContext
  device: DeviceKeys
  registry: FoldedRegistry
  account: string
  /** An action changed the list; look again. */
  onChanged: () => void
}

const PLATFORM_ICONS = { desktop: MonitorIcon, mobile: SmartphoneIcon, web: GlobeIcon } as const

export function SyncDeviceList({
  context,
  device,
  registry,
  account,
  onChanged,
}: SyncDeviceListProps) {
  const t = useTranslations("accountSync")
  const [names, setNames] = useState<Map<string, string | null> | null>(null)
  const [keysError, setKeysError] = useState(false)
  const [removing, setRemoving] = useState<RegistryDevice | null>(null)
  const [replacement, setReplacement] = useState<PreparedRecoveryKey | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const chain = await currentKeyChain(context.api, context.vault, registry.state, device)
        const opened = await deviceNames(registry.state, chain)
        if (!cancelled) {
          setNames(opened)
          setKeysError(false)
        }
      } catch {
        if (!cancelled) setKeysError(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [context, device, registry])

  const nameOf = (deviceId: string | null) =>
    (deviceId && names?.get(deviceId)) || t("devices.unnamed")

  const run = async (operation: () => Promise<unknown>, success: string) => {
    setBusy(true)
    try {
      await operation()
      toast.success(success)
      onChanged()
    } catch (cause) {
      toast.error(explainSyncError(t, cause))
    } finally {
      setBusy(false)
    }
  }

  const devices = listActiveDevices(registry.state)

  if (replacement) {
    return (
      <RecoveryKeySetup
        recoveryKeyText={replacement.recoveryKeyText}
        account={account}
        busy={busy}
        onConfirmed={() =>
          void run(async () => {
            await commitRecoveryKey(context, device, replacement)
            setReplacement(null)
          }, t("devices.replaced"))
        }
        onCancel={() => {
          replacement.recoveryKey.fill(0)
          setReplacement(null)
        }}
      />
    )
  }

  return (
    <div className="flex flex-col gap-3" data-testid="account-sync-devices">
      <h5 className="text-xs font-medium text-muted-foreground">{t("devices.title")}</h5>
      {keysError ? (
        <p role="alert" className="text-xs text-destructive">
          {t("devices.keysUnavailable")}
        </p>
      ) : null}
      <ul className="flex flex-col divide-y rounded-md border">
        {devices.map((entry) => {
          const Icon = PLATFORM_ICONS[entry.platform]
          const self = entry.deviceId === device.deviceId
          return (
            <li
              key={entry.deviceId}
              className="flex items-center gap-3 px-3 py-2"
              data-testid="account-sync-device"
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2 truncate text-sm">
                  {nameOf(entry.deviceId)}
                  {self ? <Badge variant="secondary">{t("devices.thisDevice")}</Badge> : null}
                </span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {t(`devices.platform.${entry.platform}`)} ·{" "}
                  {entry.addedVia === "approval"
                    ? t("devices.addedVia.approval", { name: nameOf(entry.addedBy) })
                    : t(`devices.addedVia.${entry.addedVia}`)}
                </span>
              </div>
              {!self ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setRemoving(entry)}
                  data-testid="account-sync-device-remove"
                >
                  {t("devices.remove")}
                </Button>
              ) : null}
            </li>
          )
        })}
      </ul>

      <div className="flex flex-col gap-0.5">
        <span className="text-[11px] text-muted-foreground">{t("devices.fingerprint")}</span>
        <code className="font-mono text-xs" data-testid="account-sync-fingerprint">
          {registryFingerprint(registry.state)}
        </code>
        <span className="text-[11px] text-muted-foreground">{t("devices.fingerprintHint")}</span>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void run(() => rotateKeys(context, device), t("devices.rotated"))}
          data-testid="account-sync-rotate"
        >
          <RefreshCwIcon data-icon="inline-start" />
          {t("devices.rotate")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void prepareRecoveryKey(context).then(setReplacement, (cause) =>
              toast.error(explainSyncError(t, cause))
            )
          }
          data-testid="account-sync-replace-recovery"
        >
          <KeyRoundIcon data-icon="inline-start" />
          {t("devices.replaceRecovery")}
        </Button>
      </div>

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("devices.removeConfirmAction")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("devices.removeConfirm", { name: nameOf(removing?.deviceId ?? null) })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("recoveryKey.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="account-sync-device-remove-confirm"
              onClick={() => {
                const target = removing
                setRemoving(null)
                if (target) {
                  void run(
                    () => revokeDevice(context, device, target.deviceId),
                    t("devices.removed", { name: nameOf(target.deviceId) })
                  )
                }
              }}
            >
              {t("devices.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
