"use client"

// Account tab — surfaces the credential identity (email / plan / expiry),
// lets the user run a manual refresh, and signs out cleanly. Web mode
// degrades to a banner.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { LogOutIcon, RefreshCwIcon, ShieldCheckIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  SettingsAlert,
  SettingsCard,
  SettingsEmptyState,
} from "@/components/settings/common/settings-section"

import { useSubscriptionCredential } from "@/lib/anthropic-subscription/hooks"
import { isTauri } from "@/lib/tauri"

import { SubscriptionLoginDialog } from "../login-dialog"

export function SubscriptionAccountTab() {
  const t = useTranslations("subscription")
  const tabReady = isTauri()
  const { credential, refresh, signOut } = useSubscriptionCredential()
  const [loginOpen, setLoginOpen] = useState(false)
  const [busy, setBusy] = useState<"refresh" | "signOut" | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (!tabReady) {
    return <SettingsAlert title={t("webModeBanner")}>{t("webModeBanner")}</SettingsAlert>
  }

  if (!credential) {
    return (
      <>
        <SettingsEmptyState
          title={t("account.signedOutTitle")}
          description={t("account.signedOutBody")}
          action={<Button onClick={() => setLoginOpen(true)}>{t("account.signInCta")}</Button>}
        />
        <SubscriptionLoginDialog open={loginOpen} onOpenChange={setLoginOpen} />
      </>
    )
  }

  const expiry = new Date(credential.expiresAtMs).toLocaleString()

  const onRefresh = async () => {
    setBusy("refresh")
    setError(null)
    try {
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const onSignOut = async () => {
    setBusy("signOut")
    setError(null)
    try {
      await signOut()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-3">
      <SettingsCard
        title={credential.email ?? t("account.unknownEmail")}
        description={
          credential.plan
            ? t("account.planLine", { plan: credential.plan, mode: credential.mode })
            : t("account.modeLine", { mode: credential.mode })
        }
        icon={<ShieldCheckIcon className="size-4 text-green-600" />}
        headerAction={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={onRefresh} disabled={busy !== null}>
              <RefreshCwIcon className={`size-3.5 ${busy === "refresh" ? "animate-spin" : ""}`} />
              {t("account.refresh")}
            </Button>
            <Button size="sm" variant="ghost" onClick={onSignOut} disabled={busy !== null}>
              <LogOutIcon className="size-3.5" />
              {t("account.signOut")}
            </Button>
          </div>
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <div>
            <span className="text-foreground">{t("account.expiresLabel")}: </span>
            <span className="font-mono">{expiry}</span>
          </div>
          {credential.scope && (
            <div>
              <span className="text-foreground">{t("account.scopeLabel")}: </span>
              <span className="font-mono">{credential.scope}</span>
            </div>
          )}
        </div>
      </SettingsCard>

      {error && (
        <SettingsAlert variant="destructive" title={t("account.errorTitle")}>
          {error}
        </SettingsAlert>
      )}

      <SettingsAlert title={t("account.keychainNoticeTitle")}>
        {t("account.keychainNoticeBody")}
      </SettingsAlert>
    </div>
  )
}
