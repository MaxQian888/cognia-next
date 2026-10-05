"use client"

/**
 * The first device of a space (protocol §5.1): name it, keep the sync
 * recovery key, then create the space. If another device won the race, the
 * section switches to asking that device for approval.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { KeyRoundIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { AccountSyncContext } from "@/lib/account-sync/enrollment/context"
import {
  commitFirstDevice,
  prepareFirstDevice,
  type PreparedFirstDevice,
} from "@/lib/account-sync/enrollment/first-device"
import { currentDevicePlatform, suggestDeviceName } from "@/lib/account-sync/enrollment/platform"

import { explainSyncError } from "./explain-sync-error"
import { RecoveryKeySetup } from "./recovery-key-setup"

export interface FirstDeviceSetupProps {
  context: AccountSyncContext
  account: string
  onDone: () => void
  onSpaceExists: () => void
}

export function FirstDeviceSetup({
  context,
  account,
  onDone,
  onSpaceExists,
}: FirstDeviceSetupProps) {
  const t = useTranslations("accountSync")
  const [name, setName] = useState(() => suggestDeviceName())
  const [prepared, setPrepared] = useState<PreparedFirstDevice | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      setPrepared(await prepareFirstDevice(context, { name, platform: currentDevicePlatform() }))
    } catch (cause) {
      setError(explainSyncError(t, cause))
    } finally {
      setBusy(false)
    }
  }

  const commit = async () => {
    if (!prepared) return
    setBusy(true)
    setError(null)
    try {
      const result = await commitFirstDevice(context, prepared)
      if (result.kind === "space-exists") {
        toast.info(t("setup.spaceExists"))
        onSpaceExists()
        return
      }
      toast.success(t("setup.done"))
      onDone()
    } catch (cause) {
      setError(explainSyncError(t, cause))
    } finally {
      setBusy(false)
    }
  }

  const cancel = () => {
    prepared?.recoveryKey.fill(0)
    setPrepared(null)
  }

  return (
    <div className="flex flex-col gap-3" data-testid="account-sync-first-device">
      {prepared ? (
        <RecoveryKeySetup
          recoveryKeyText={prepared.recoveryKeyText}
          account={account}
          busy={busy}
          onConfirmed={() => void commit()}
          onCancel={cancel}
        />
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <h5 className="text-sm font-medium">{t("setup.title")}</h5>
            <p className="text-xs text-muted-foreground">{t("setup.description")}</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-sync-device-name" className="text-xs">
              {t("setup.nameLabel")}
            </Label>
            <Input
              id="account-sync-device-name"
              value={name}
              placeholder={t("devices.unnamed")}
              maxLength={40}
              onChange={(event) => setName(event.target.value)}
              data-testid="account-sync-device-name"
            />
          </div>
          <Button
            type="button"
            size="sm"
            className="self-start"
            disabled={busy}
            onClick={() => void start()}
            data-testid="account-sync-setup-start"
          >
            <KeyRoundIcon data-icon="inline-start" />
            {busy ? t("section.working") : t("setup.start")}
          </Button>
        </>
      )}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
