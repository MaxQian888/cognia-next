"use client"

/**
 * Adding this device with the sync recovery key (protocol §5.3), then
 * offering to replace the key, since it was just typed on a device.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { parseRecoveryKey } from "@cognia/sync-protocol"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { AccountSyncContext } from "@/lib/account-sync/enrollment/context"
import {
  commitRecoveryKey,
  prepareRecoveryKey,
  type PreparedRecoveryKey,
} from "@/lib/account-sync/enrollment/manage"
import { currentDevicePlatform, suggestDeviceName } from "@/lib/account-sync/enrollment/platform"
import { recoverWithKey } from "@/lib/account-sync/enrollment/recover"

import { explainSyncError } from "./explain-sync-error"
import { RecoveryKeySetup } from "./recovery-key-setup"

export interface RecoveryKeyFormProps {
  context: AccountSyncContext
  account: string
  onDone: () => void
  onBack: () => void
}

type Phase = "form" | "offer-replace" | "replacing"

export function RecoveryKeyForm({ context, account, onDone, onBack }: RecoveryKeyFormProps) {
  const t = useTranslations("accountSync")
  const [text, setText] = useState("")
  const [name, setName] = useState(() => suggestDeviceName())
  const [phase, setPhase] = useState<Phase>("form")
  const [replacement, setReplacement] = useState<PreparedRecoveryKey | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setError(null)
    try {
      parseRecoveryKey(text)
    } catch {
      setError(t("recover.invalid"))
      return
    }
    setBusy(true)
    try {
      await recoverWithKey(context, text, { name, platform: currentDevicePlatform() })
      setText("")
      toast.success(t("recover.done"))
      setPhase("offer-replace")
    } catch (cause) {
      setError(explainSyncError(t, cause))
    } finally {
      setBusy(false)
    }
  }

  const beginReplace = async () => {
    setBusy(true)
    try {
      setReplacement(await prepareRecoveryKey(context))
      setPhase("replacing")
    } catch (cause) {
      setError(explainSyncError(t, cause))
    } finally {
      setBusy(false)
    }
  }

  const commitReplace = async () => {
    if (!replacement) return
    setBusy(true)
    try {
      const device = await context.vault.loadDeviceKeys()
      if (!device) throw new Error("this device has no sync keys")
      await commitRecoveryKey(context, device, replacement)
      toast.success(t("devices.replaced"))
      onDone()
    } catch (cause) {
      setError(explainSyncError(t, cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="account-sync-recover" data-phase={phase}>
      {phase === "form" ? (
        <>
          <h5 className="text-sm font-medium">{t("recover.title")}</h5>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-sync-recovery-key" className="text-xs">
              {t("recover.label")}
            </Label>
            <Input
              id="account-sync-recovery-key"
              value={text}
              placeholder={t("recover.placeholder")}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              onChange={(event) => setText(event.target.value)}
              data-testid="account-sync-recovery-key"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-sync-recover-name" className="text-xs">
              {t("setup.nameLabel")}
            </Label>
            <Input
              id="account-sync-recover-name"
              value={name}
              placeholder={t("devices.unnamed")}
              maxLength={40}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy || !text.trim()}
              onClick={() => void submit()}
              data-testid="account-sync-recover-submit"
            >
              {busy ? t("section.working") : t("recover.submit")}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onBack}>
              {t("recover.back")}
            </Button>
          </div>
        </>
      ) : phase === "offer-replace" ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm">{t("recover.replacePrompt")}</p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => void beginReplace()}
              data-testid="account-sync-recover-replace"
            >
              {t("recover.replaceNow")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={onDone}
              data-testid="account-sync-recover-later"
            >
              {t("recover.later")}
            </Button>
          </div>
        </div>
      ) : replacement ? (
        <RecoveryKeySetup
          recoveryKeyText={replacement.recoveryKeyText}
          account={account}
          busy={busy}
          onConfirmed={() => void commitReplace()}
          onCancel={onDone}
        />
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
