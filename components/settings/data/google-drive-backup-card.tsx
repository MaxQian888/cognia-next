"use client"

/**
 * Google Drive backup destination card (Settings → Data). The user supplies
 * their own OAuth client (Google Cloud → "Desktop app"), connects through the
 * OAuth device flow (a code to type at google.com/device — works on the
 * desktop AND when driving a headless host from a companion), and can run a
 * manual "Sync now" through the same pipeline the scheduled `backup` executor
 * uses. Tokens/secret never leave the host keyring.
 */

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { CloudIcon, ExternalLinkIcon } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  DEFAULT_GOOGLE_DRIVE_FOLDER_NAME,
  clearGoogleDriveTokens,
  getBackupDestinationsSettings,
  getGoogleDriveClientSecret,
  setGoogleDriveClientSecret,
  updateBackupDestinationsSettings,
} from "@/lib/data/destinations/config"
import {
  beginGoogleDeviceAuth,
  completeGoogleDeviceAuth,
  type GoogleDeviceAuthChallenge,
} from "@/lib/data/destinations/google-oauth"
import {
  runRemoteBackupSyncNow,
  type RemoteBackupSyncPhase,
} from "@/lib/data/destinations/sync-now"
import { hasSyncPassphrase, loadPersistedSyncPassphrase } from "@/lib/webdav/passphrase-cache"

export function GoogleDriveBackupCard() {
  const t = useTranslations("settings.data.googleDriveBackup")
  const [enabled, setEnabled] = useState(false)
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const [secretSaved, setSecretSaved] = useState(false)
  const [folderName, setFolderName] = useState(DEFAULT_GOOGLE_DRIVE_FOLDER_NAME)
  const [connected, setConnected] = useState(false)
  const [accountEmail, setAccountEmail] = useState<string | undefined>()
  const [lastSyncAt, setLastSyncAt] = useState<string | undefined>()
  const [challenge, setChallenge] = useState<GoogleDeviceAuthChallenge | null>(null)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<RemoteBackupSyncPhase | null>(null)
  const [unlocked, setUnlocked] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    void (async () => {
      const settings = await getBackupDestinationsSettings()
      const cfg = settings.googleDrive
      setEnabled(cfg?.enabled ?? false)
      setClientId(cfg?.clientId ?? "")
      setFolderName(cfg?.folderName ?? DEFAULT_GOOGLE_DRIVE_FOLDER_NAME)
      setConnected(cfg?.connected ?? false)
      setAccountEmail(cfg?.accountEmail)
      setLastSyncAt(cfg?.lastSyncAt)
      setSecretSaved(Boolean(await getGoogleDriveClientSecret()))
      await loadPersistedSyncPassphrase()
      setUnlocked(hasSyncPassphrase())
    })()
    return () => abortRef.current?.abort()
  }, [])

  const onSave = async () => {
    if (!clientId.trim()) {
      toast.error(t("clientIdRequired"))
      return
    }
    setSaving(true)
    try {
      if (clientSecret.trim()) {
        await setGoogleDriveClientSecret(clientSecret)
        setClientSecret("")
        setSecretSaved(true)
      }
      await updateBackupDestinationsSettings((current) => ({
        ...current,
        googleDrive: {
          ...(current.googleDrive ?? { enabled: false }),
          enabled,
          clientId: clientId.trim(),
          folderName: folderName.trim() || DEFAULT_GOOGLE_DRIVE_FOLDER_NAME,
        },
      }))
      toast.success(t("saved"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const onConnect = async () => {
    setBusy(true)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const next = await beginGoogleDeviceAuth()
      setChallenge(next)
      const outcome = await completeGoogleDeviceAuth(next, { signal: controller.signal })
      switch (outcome.status) {
        case "authorized": {
          const settings = await getBackupDestinationsSettings()
          setConnected(true)
          setAccountEmail(settings.googleDrive?.accountEmail)
          toast.success(t("connected"))
          break
        }
        case "denied":
          toast.error(t("connectDenied"))
          break
        case "expired":
          toast.error(t("connectExpired"))
          break
        case "error":
          toast.error(t("connectFailed"), { description: outcome.error })
          break
        default:
          break
      }
    } catch (err) {
      toast.error(t("connectFailed"), {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setChallenge(null)
      setBusy(false)
      abortRef.current = null
    }
  }

  const onCancelConnect = () => abortRef.current?.abort()

  const onDisconnect = async () => {
    await clearGoogleDriveTokens()
    await updateBackupDestinationsSettings((current) => ({
      ...current,
      googleDrive: current.googleDrive
        ? { ...current.googleDrive, connected: false, accountEmail: undefined }
        : current.googleDrive,
    }))
    setConnected(false)
    setAccountEmail(undefined)
    toast.success(t("disconnected"))
  }

  const onSyncNow = async () => {
    if (!unlocked) {
      toast.error(t("passphraseRequired"))
      return
    }
    setBusy(true)
    try {
      const result = await runRemoteBackupSyncNow("googledrive", "", { onProgress: setPhase })
      if (result.ok) {
        setLastSyncAt(new Date().toISOString())
        toast.success(t("syncDone"))
      } else {
        toast.error(t("syncFailed"), { description: result.error })
      }
    } finally {
      setBusy(false)
      setPhase(null)
    }
  }

  return (
    <Card className="space-y-4 p-4" data-testid="google-drive-backup-card">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CloudIcon className="h-4 w-4" aria-hidden="true" />
          <Label className="text-sm">{t("title")}</Label>
          {connected && (
            <Badge
              variant="outline"
              className="text-[10px]"
              data-testid="google-drive-connected-badge"
            >
              {accountEmail ? t("connectedAs", { email: accountEmail }) : t("connectedBadge")}
            </Badge>
          )}
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label={t("enableLabel")}
          data-testid="google-drive-backup-enabled"
        />
      </div>
      <p className="text-xs text-muted-foreground">{t("description")}</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">{t("clientIdLabel")}</Label>
          <Input
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="xxxx.apps.googleusercontent.com"
            className="h-9 font-mono text-xs"
            data-testid="google-drive-client-id"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("clientSecretLabel")}</Label>
          <Input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={secretSaved ? t("clientSecretSaved") : "GOCSPX-…"}
            className="h-9 font-mono text-xs"
            data-testid="google-drive-client-secret"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("folderLabel")}</Label>
          <Input
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            placeholder={DEFAULT_GOOGLE_DRIVE_FOLDER_NAME}
            className="h-9 text-xs"
            data-testid="google-drive-folder"
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t("clientHelp")}</p>

      {challenge && (
        <div
          className="rounded-md border border-dashed p-3 text-sm"
          data-testid="google-drive-device-code"
        >
          <p>{t("deviceInstructions")}</p>
          <p className="mt-1 font-mono text-lg tracking-widest">{challenge.userCode}</p>
          <a
            href={challenge.verificationUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-xs underline"
          >
            {challenge.verificationUrl}
            <ExternalLinkIcon className="h-3 w-3" aria-hidden="true" />
          </a>
          <div className="mt-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={onCancelConnect}
              data-testid="google-drive-cancel-connect"
            >
              {t("cancelConnect")}
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onSave} disabled={saving} data-testid="google-drive-save">
          {t("save")}
        </Button>
        {connected ? (
          <Button
            size="sm"
            variant="outline"
            onClick={onDisconnect}
            disabled={busy}
            data-testid="google-drive-disconnect"
          >
            {t("disconnect")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={onConnect}
            disabled={busy || !clientId.trim() || !secretSaved}
            data-testid="google-drive-connect"
          >
            {t("connect")}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={onSyncNow}
          disabled={busy || !enabled || !connected}
          data-testid="google-drive-sync"
        >
          {phase ? t(`phase.${phase}`) : t("syncNow")}
        </Button>
        <span className="text-xs text-muted-foreground" data-testid="google-drive-last-sync">
          {lastSyncAt
            ? t("lastSync", { time: new Date(lastSyncAt).toLocaleString() })
            : t("neverSynced")}
        </span>
      </div>
    </Card>
  )
}
