"use client"

/**
 * "Unlock automatically on this device" for one password profile.
 *
 * Turning it on asks for the profile's password once, because that password is
 * exactly what the native secret store keeps; turning it off needs nothing, and
 * the password keeps working either way. The lock screen offers the same
 * choice at unlock time, so this is the place to change one's mind later.
 * Only rendered where the runtime supports it (the desktop shell), see
 * `isDeviceUnlockSupported`.
 */

import { useId, useState, type FormEvent } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import type { LocalAccountRecord } from "@/lib/accounts/account-types"
import { useAccountStore } from "@/stores/account/account-store"

export interface RememberOnDeviceControlProps {
  account: LocalAccountRecord
}

export function RememberOnDeviceControl({ account }: RememberOnDeviceControlProps) {
  const t = useTranslations("account.manage")
  const setRememberOnDevice = useAccountStore((state) => state.setRememberOnDevice)
  const switchId = useId()
  const passwordId = useId()
  const enabled = account.rememberOnDevice === true
  const [confirming, setConfirming] = useState(false)
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const run = async (work: () => Promise<unknown>) => {
    setSubmitting(true)
    setError(null)
    try {
      await work()
      setConfirming(false)
      setPassword("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("operationFailed"))
    } finally {
      setSubmitting(false)
    }
  }

  const onToggle = (next: boolean) => {
    setError(null)
    if (next) {
      setConfirming(true)
      return
    }
    setConfirming(false)
    void run(() => setRememberOnDevice(account.id, false))
  }

  const onConfirm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!password) {
      setError(t("rememberOnDevicePasswordRequired"))
      return
    }
    void run(() => setRememberOnDevice(account.id, true, password))
  }

  return (
    <div className="flex flex-col gap-2" data-testid="account-remember-on-device">
      <div className="flex items-center justify-between gap-2 rounded-lg border p-2.5">
        <div className="min-w-0">
          <Label htmlFor={switchId} className="text-xs font-medium">
            {t("rememberOnDeviceLabel")}
          </Label>
          <p className="text-[11px] text-muted-foreground">
            {t(enabled ? "rememberOnDeviceOnHelp" : "rememberOnDeviceOffHelp")}
          </p>
        </div>
        <Switch
          id={switchId}
          checked={enabled || confirming}
          disabled={submitting}
          data-testid="account-remember-on-device-switch"
          onCheckedChange={onToggle}
        />
      </div>
      {confirming && !enabled && (
        <form className="flex flex-col gap-2" onSubmit={onConfirm}>
          <Label htmlFor={passwordId}>{t("rememberOnDevicePasswordLabel")}</Label>
          <Input
            id={passwordId}
            type="password"
            autoComplete="current-password"
            value={password}
            placeholder={t("currentPasswordPlaceholder")}
            disabled={submitting}
            onChange={(event) => setPassword(event.target.value)}
          />
          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={submitting}
              data-testid="account-remember-on-device-confirm"
            >
              {t("rememberOnDeviceConfirm")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={submitting}
              onClick={() => {
                setConfirming(false)
                setPassword("")
                setError(null)
              }}
            >
              {t("cancel")}
            </Button>
          </div>
        </form>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}
    </div>
  )
}

export default RememberOnDeviceControl
