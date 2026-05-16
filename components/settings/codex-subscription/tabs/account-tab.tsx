"use client"

// Codex Subscription → Account tab. Renders the full credential metadata
// (email, plan, account id, auth mode, expiry, stored-at) plus Refresh
// and Sign-out actions.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon, LogOutIcon, RefreshCwIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  SettingsAlert,
  SettingsCard,
  SettingsEmptyState,
} from "@/components/settings/common/settings-section"

import { useCodexCredential } from "@/lib/codex-subscription/hooks"
import { isTauri } from "@/lib/tauri"

export function CodexSubscriptionAccountTab() {
  const t = useTranslations("codexSubscription")
  const tabReady = isTauri()
  const { credential, refresh, signOut, loading } = useCodexCredential()
  const [busy, setBusy] = useState<"refresh" | "signout" | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (!tabReady) {
    return <SettingsAlert title={t("webModeBanner")}>{t("webModeBanner")}</SettingsAlert>
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">{t("usage.loading")}</p>
  }

  if (!credential) {
    return (
      <SettingsEmptyState
        title={t("account.signedOutTitle")}
        description={t("account.signedOutBody")}
      />
    )
  }

  const onRefresh = async () => {
    setError(null)
    setBusy("refresh")
    try {
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const onSignOut = async () => {
    setError(null)
    setBusy("signout")
    try {
      await signOut({ revoke: false })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const expiresDate = credential.expiresAtMs > 0 ? new Date(credential.expiresAtMs) : null
  const storedDate = new Date(credential.storedAtMs)

  return (
    <div className="space-y-3">
      <SettingsCard title={t("account.detailsTitle")} description={t("account.detailsBody")}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <KvRow
            label={t("account.emailLabel")}
            value={credential.email ?? t("account.unknownEmail")}
          />
          <KvRow label={t("account.planLabel")} value={credential.chatgptPlanType ?? "—"} />
          {credential.accountId && (
            <KvRow label={t("account.accountIdLabel")} value={credential.accountId} mono />
          )}
          {credential.chatgptUserId && (
            <KvRow label={t("account.userIdLabel")} value={credential.chatgptUserId} mono />
          )}
          <KvRow
            label={t("account.authModeLabel")}
            value={
              credential.authMode === "chatgpt"
                ? t("account.authMode.chatgpt")
                : t("account.authMode.api_key")
            }
          />
          <KvRow
            label={t("account.sourceLabel")}
            value={t(`account.source.${credential.originalSource ?? "oauth"}`)}
          />
          {expiresDate && (
            <KvRow label={t("account.expiresLabel")} value={expiresDate.toLocaleString()} />
          )}
          <KvRow label={t("account.storedAtLabel")} value={storedDate.toLocaleString()} />
        </div>
      </SettingsCard>

      <Separator />

      {error && (
        <SettingsAlert variant="destructive" title={t("account.errorTitle")}>
          {error}
        </SettingsAlert>
      )}

      <div className="flex items-center gap-2">
        {credential.authMode === "chatgpt" && credential.refreshToken && (
          <Button variant="outline" size="sm" onClick={() => void onRefresh()} disabled={!!busy}>
            {busy === "refresh" ? (
              <Loader2Icon className="mr-2 size-4 animate-spin" />
            ) : (
              <RefreshCwIcon className="mr-2 size-4" />
            )}
            {t("account.refresh")}
          </Button>
        )}
        <Button variant="destructive" size="sm" onClick={() => void onSignOut()} disabled={!!busy}>
          {busy === "signout" ? (
            <Loader2Icon className="mr-2 size-4 animate-spin" />
          ) : (
            <LogOutIcon className="mr-2 size-4" />
          )}
          {t("account.signOut")}
        </Button>
      </div>

      <Badge variant="outline" className="text-[10px]">
        {t("account.keychainNoticeTitle")}
      </Badge>
      <p className="text-[11px] text-muted-foreground">{t("account.keychainNoticeBody")}</p>
    </div>
  )
}

function KvRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[110px_1fr] items-center gap-2">
      <div className="text-muted-foreground">{label}</div>
      <div className={`${mono ? "font-mono break-all" : ""}`}>{value}</div>
    </div>
  )
}
