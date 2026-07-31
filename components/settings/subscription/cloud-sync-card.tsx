"use client"

// Subscription-vault WebDAV cloud sync card (Settings → Subscription).
// The server connection (URL / username / password) is configured once in
// Settings → Data → WebDAV and shared; this card owns the
// subscription-specific toggle, passphrase, "Sync now" and restore-preview.

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { CloudIcon, Loader2Icon, ChevronDownIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { SettingsAlert } from "@/components/settings/common/settings-section"
import { SyncStatusStrip, type SyncPhase } from "@/components/settings/_shared/sync-status-strip"
import { isTauri } from "@/lib/tauri"

import { getSettings, saveSettings } from "@/lib/db/settings"
import { SubscriptionPassphraseError } from "@/lib/subscription/core/encrypted-package"
import {
  getSubscriptionSyncPassphrase,
  hasSubscriptionSyncPassphrase,
  loadPersistedSubscriptionSyncPassphrase,
} from "@/lib/subscription/sync/passphrase-cache"
import {
  applySubscriptionRestore,
  restoreSubscriptionFromWebDav,
  runSubscriptionSyncNow,
  type SubscriptionRestorePreview,
  type SubscriptionSyncPhase,
} from "@/lib/subscription/sync/subscription-sync"
import { resolveWebDavConfig } from "@/lib/webdav/config"
import type { ProviderId } from "@/types/subscription"
import { ALL_PROVIDER_IDS } from "@/types/subscription"

export function CloudSyncCard() {
  const t = useTranslations("subscription.common.cloudSync")
  const tRoot = useTranslations("subscription")
  const [enabled, setEnabled] = useState(false)
  const [connectionReady, setConnectionReady] = useState(false)
  const [lastSyncAt, setLastSyncAt] = useState<string | undefined>()
  const [passphrase, setPassphrase] = useState("")
  const [unlocked, setUnlocked] = useState(false)
  const [syncPhase, setSyncPhase] = useState<SubscriptionSyncPhase | null>(null)
  const [restoreOpen, setRestoreOpen] = useState(false)
  // Non-resident: the heavier controls (toggle, passphrase, restore) stay
  // collapsed until the user opens them. The compact header carries the sync
  // trigger + transient status so the card no longer occupies the page.
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    void (async () => {
      const settings = await getSettings()
      setEnabled(settings.webdavSync?.subscriptionSyncEnabled ?? false)
      setLastSyncAt(settings.webdavSync?.subscriptionLastSyncAt)
      // Connection complete = url + username + keyring password present;
      // the data-sync toggle does not gate the subscription pipeline.
      setConnectionReady(Boolean(await resolveWebDavConfig({ requireEnabled: false })))
      await loadPersistedSubscriptionSyncPassphrase()
      setUnlocked(hasSubscriptionSyncPassphrase())
    })()
  }, [])

  const onToggle = async (next: boolean) => {
    setEnabled(next)
    const settings = await getSettings()
    await saveSettings({
      webdavSync: { ...(settings.webdavSync ?? {}), subscriptionSyncEnabled: next },
    })
  }

  const onSyncNow = async () => {
    const pass = passphrase || getSubscriptionSyncPassphrase() || ""
    if (!pass) {
      toast.error(t("passphraseRequired"))
      return
    }
    setSyncPhase("building")
    try {
      const result = await runSubscriptionSyncNow(pass, { onProgress: setSyncPhase })
      if (result.ok) {
        setPassphrase("")
        setUnlocked(true)
        setLastSyncAt(new Date().toISOString())
        toast.success(t("syncSuccess"))
      } else {
        toast.error(t("syncFailed", { error: result.error }))
      }
    } finally {
      setSyncPhase(null)
    }
  }

  const phase: SyncPhase = syncPhase !== null ? "syncing" : "idle"

  // Sync trigger from the compact header. Reveals the panel (and nudges the
  // user) when the connection / passphrase it needs isn't ready yet, so the
  // collapsed state never leaves the user unable to act.
  const onHeaderSync = () => {
    if (!connectionReady) {
      setExpanded(true)
      return
    }
    const pass = passphrase || getSubscriptionSyncPassphrase() || ""
    if (!pass) {
      setExpanded(true)
      toast.error(t("passphraseRequired"))
      return
    }
    void onSyncNow()
  }

  // Both sync and restore round-trip the keychain-backed vault, and the WebDAV
  // password itself lives in the keyring — none of it resolves in a browser.
  if (!isTauri()) {
    return <SettingsAlert title={t("title")}>{tRoot("webModeBanner")}</SettingsAlert>
  }

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} className="rounded-lg border">
      <div className="flex flex-wrap items-center justify-between gap-2 p-3">
        <Label className="flex items-center gap-2 text-sm">
          <CloudIcon className="size-4" />
          {t("title")}
        </Label>
        <div className="flex items-center gap-2">
          <SyncStatusStrip
            data-testid="subscription-cloud-sync"
            label={t("syncNow")}
            syncingLabel={t("syncing")}
            syncedLabel={t("synced")}
            phase={phase}
            statusText={syncPhase !== null ? t(`phase.${syncPhase}`) : undefined}
            onSync={onHeaderSync}
            disabled={!connectionReady}
          />
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7" aria-label={t("expand")}>
              <ChevronDownIcon className="size-4" />
            </Button>
          </CollapsibleTrigger>
        </div>
      </div>

      <CollapsibleContent className="space-y-3 px-3 pb-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">{t("description")}</p>
          <Switch
            checked={enabled}
            onCheckedChange={(v) => void onToggle(v)}
            aria-label={t("title")}
            data-testid="subscription-cloud-sync-toggle"
          />
        </div>

        {!connectionReady && (
          <p className="rounded-md border border-dashed p-2.5 text-xs text-muted-foreground">
            {t("connectionHint")}
          </p>
        )}

        {connectionReady && (
          <>
            <div className="space-y-1">
              <Label htmlFor="subscription-sync-passphrase">{t("passphraseField")}</Label>
              <Input
                id="subscription-sync-passphrase"
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder={unlocked ? t("passphraseUnlockedPlaceholder") : undefined}
              />
              <p className="text-[11px] text-muted-foreground">{t("passphraseHint")}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setRestoreOpen(true)}>
                {t("restoreButton")}
              </Button>
              {lastSyncAt && (
                <span className="text-[11px] text-muted-foreground">
                  {t("lastSyncAt", { time: new Date(lastSyncAt).toLocaleString() })}
                </span>
              )}
            </div>
          </>
        )}
      </CollapsibleContent>
      <RestoreDialog open={restoreOpen} onClose={() => setRestoreOpen(false)} />
    </Collapsible>
  )
}

type RestoreMode = "idle" | "loading" | "preview" | "applying"

function RestoreDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("subscription.common.cloudSync")
  const tProviders = useTranslations("subscription")
  const [pass, setPass] = useState("")
  const [mode, setMode] = useState<RestoreMode>("idle")
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<SubscriptionRestorePreview | null>(null)

  const reset = () => {
    setPass("")
    setMode("idle")
    setError(null)
    setPreview(null)
  }

  const onUnlock = async () => {
    setError(null)
    setMode("loading")
    try {
      const got = await restoreSubscriptionFromWebDav(pass)
      setPreview(got)
      setMode("preview")
    } catch (e) {
      setMode("idle")
      if (e instanceof SubscriptionPassphraseError) {
        setError(t("passphraseWrong"))
      } else {
        setError(t("restoreFailed", { error: e instanceof Error ? e.message : String(e) }))
      }
    }
  }

  const onApply = async () => {
    if (!preview) return
    setMode("applying")
    try {
      const { accountCount } = await applySubscriptionRestore(preview)
      toast.success(t("restoreSuccess", { count: accountCount }))
      reset()
      onClose()
    } catch (e) {
      setMode("preview")
      setError(t("restoreFailed", { error: e instanceof Error ? e.message : String(e) }))
    }
  }

  const rows = useMemo(() => {
    if (!preview) return []
    const out: Array<{ provider: ProviderId; count: number }> = []
    for (const provider of ALL_PROVIDER_IDS) {
      const vault = preview.body.vaults[provider]
      if (!vault) continue
      out.push({ provider, count: vault.accounts.length })
    }
    return out
  }, [preview])

  const safeProviderName = (p: ProviderId): string => {
    const out = tProviders(`providers.${p}` as never)
    return out === `subscription.providers.${p}` ? p : out
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          reset()
          onClose()
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === "preview" ? t("restorePreviewTitle") : t("restoreDialogTitle")}
          </DialogTitle>
          <DialogDescription>
            {mode === "preview" ? t("restorePreviewBody") : t("restoreDialogBody")}
          </DialogDescription>
        </DialogHeader>

        {mode === "preview" && preview ? (
          <div className="space-y-2" data-testid="subscription-restore-preview">
            <p className="text-xs text-muted-foreground">
              {t("restoreCreatedAt", {
                time: new Date(preview.body.manifest.createdAtIso).toLocaleString(),
              })}
              {preview.body.manifest.device?.label && (
                <> · {t("restoreFromDevice", { device: preview.body.manifest.device.label })}</>
              )}
            </p>
            {rows.length === 0 ? (
              <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
                {t("restoreEmpty")}
              </p>
            ) : (
              <ul className="space-y-1 text-xs">
                {rows.map((row) => (
                  <li
                    key={row.provider}
                    className="flex items-center justify-between rounded border bg-muted/30 px-2.5 py-1.5"
                  >
                    <span className="font-medium">{safeProviderName(row.provider)}</span>
                    <span className="text-muted-foreground">
                      {t("restoreAccountCount", { count: row.count })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="space-y-1">
            <Label htmlFor="subscription-restore-passphrase">{t("passphraseField")}</Label>
            <Input
              id="subscription-restore-passphrase"
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              disabled={mode !== "idle"}
              autoFocus
            />
          </div>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              reset()
              onClose()
            }}
            disabled={mode === "loading" || mode === "applying"}
          >
            {t("cancel")}
          </Button>
          {mode === "preview" ? (
            <Button onClick={() => void onApply()}>{t("restoreApply")}</Button>
          ) : (
            <Button onClick={() => void onUnlock()} disabled={!pass || mode !== "idle"}>
              {mode === "loading" && <Loader2Icon className="mr-2 size-4 animate-spin" />}
              {t("restoreUnlock")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
