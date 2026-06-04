"use client"

// WebDAV snapshot-sync settings. Server URL/folder/username live in
// AppSettings; the password lives in the OS keyring; the zero-knowledge sync
// passphrase is session-only by default, with an opt-in "remember on this
// device" keyring persistence for unattended automation. Mirrors
// <ShareSettingsCard/>.

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { CloudIcon } from "lucide-react"
import { toast } from "sonner"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { listBackupHistory } from "@/lib/db/backup-history"
import {
  DEFAULT_WEBDAV_REMOTE_DIR,
  clearStoredSyncPassphrase,
  hasWebDavPassword,
  setWebDavPassword,
  getWebDavPassword,
} from "@/lib/webdav/config"
import { createWebDavClient } from "@/lib/webdav/client"
import { isWebDavSupported } from "@/lib/webdav/transport"
import {
  getSyncPassphrase,
  hasSyncPassphrase,
  loadPersistedSyncPassphrase,
  persistSyncPassphrase,
  setSyncPassphrase,
} from "@/lib/webdav/passphrase-cache"
import { runWebDavSyncNow, type WebDavSyncPhase } from "@/lib/webdav/sync-now"
import { WebDavRestoreDialog } from "@/components/data/import/webdav-restore-dialog"

export function WebDavSyncCard() {
  const t = useTranslations("settings.data.webdav")
  const [enabled, setEnabled] = useState(false)
  const [baseUrl, setBaseUrl] = useState("")
  const [remoteDir, setRemoteDir] = useState(DEFAULT_WEBDAV_REMOTE_DIR)
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [passwordSaved, setPasswordSaved] = useState(false)
  const [passphrase, setPassphrase] = useState("")
  const [unlocked, setUnlocked] = useState(false)
  const [remember, setRemember] = useState(false)
  const [lastSyncAt, setLastSyncAt] = useState<string | undefined>()
  const [lastSyncDevice, setLastSyncDevice] = useState<string | undefined>()
  const [syncPhase, setSyncPhase] = useState<WebDavSyncPhase | null>(null)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [supported, setSupported] = useState(true)

  useEffect(() => {
    void (async () => {
      const settings = await getSettings()
      setSupported(isWebDavSupported())
      const cfg = settings.webdavSync
      setEnabled(cfg?.enabled ?? false)
      setBaseUrl(cfg?.baseUrl ?? "")
      setRemoteDir(cfg?.remoteDir ?? DEFAULT_WEBDAV_REMOTE_DIR)
      setUsername(cfg?.username ?? "")
      setLastSyncAt(cfg?.lastSyncAt)
      setRemember(cfg?.rememberPassphrase ?? false)
      setPasswordSaved(await hasWebDavPassword())
      // Hydrate the opt-in persisted passphrase so the card shows "unlocked"
      // right after a restart instead of demanding a re-type.
      await loadPersistedSyncPassphrase()
      setUnlocked(hasSyncPassphrase())
      // Which device produced the newest successful WebDAV upload.
      try {
        const rows = await listBackupHistory({ successOnly: true, limit: 20 })
        const lastWebDav = rows.find((r) => r.encryption === "passphrase" && r.deviceLabel)
        setLastSyncDevice(lastWebDav?.deviceLabel)
      } catch {
        // History unavailable — cosmetic only.
      }
    })()
  }, [])

  const onToggleRemember = async (next: boolean) => {
    setRemember(next)
    const settings = await getSettings()
    await saveSettings({
      webdavSync: { ...(settings.webdavSync ?? {}), rememberPassphrase: next },
    })
    if (next) {
      // Persist immediately when the session already holds a proven passphrase.
      const current = getSyncPassphrase()
      if (current) await persistSyncPassphrase(current)
    } else {
      // Wipe the keyring copy; the session cache stays valid until app exit.
      try {
        await clearStoredSyncPassphrase()
      } catch {
        // Best-effort.
      }
    }
  }

  const onSave = async () => {
    setSaving(true)
    try {
      const settings = await getSettings()
      await saveSettings({
        webdavSync: {
          ...(settings.webdavSync ?? {}),
          enabled,
          baseUrl: baseUrl.trim() || undefined,
          remoteDir: remoteDir.trim() || DEFAULT_WEBDAV_REMOTE_DIR,
          username: username.trim() || undefined,
        },
      })
      if (password) {
        await setWebDavPassword(password)
        setPassword("")
        setPasswordSaved(true)
      }
      if (passphrase) {
        setSyncPassphrase(passphrase)
        setUnlocked(true)
      }
      toast.success(t("saved"))
    } finally {
      setSaving(false)
    }
  }

  const onClearPassword = async () => {
    await setWebDavPassword("")
    setPasswordSaved(false)
    toast.success(t("cleared"))
  }

  const onTestConnection = async () => {
    setBusy(true)
    try {
      const pwd = password || (await getWebDavPassword()) || ""
      if (!baseUrl.trim() || !username.trim() || !pwd) {
        toast.error(t("testIncomplete"))
        return
      }
      const client = createWebDavClient(
        { baseUrl: baseUrl.trim(), username: username.trim(), password: pwd },
        { trustSelfSigned: true }
      )
      const dir = remoteDir.trim() || DEFAULT_WEBDAV_REMOTE_DIR
      await client.ensureCollection(dir.startsWith("/") ? dir : `/${dir}`)
      toast.success(t("testSuccess"))
    } catch (err) {
      toast.error(t("testFailed", { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }

  const onSyncNow = async () => {
    if (!passphrase && !unlocked) {
      toast.error(t("passphraseRequired"))
      return
    }
    setBusy(true)
    try {
      const result = await runWebDavSyncNow(passphrase || "", { onProgress: setSyncPhase })
      if (result.ok) {
        setUnlocked(true)
        setLastSyncAt(new Date().toISOString())
        toast.success(t("syncSuccess"))
      } else {
        toast.error(t("syncFailed", { error: result.error }))
      }
    } finally {
      setBusy(false)
      setSyncPhase(null)
    }
  }

  const phaseLabel = (phase: WebDavSyncPhase): string => {
    switch (phase) {
      case "building":
        return t("phaseBuilding")
      case "encrypting":
        return t("phaseEncrypting")
      case "uploading":
        return t("phaseUploading")
      case "done":
        return t("phaseDone")
    }
  }

  return (
    <Card className="space-y-4 p-4">
      <div className="flex items-center gap-2">
        <CloudIcon className="size-4" />
        <Label className="text-sm">{t("title")}</Label>
        {unlocked && (
          <Badge variant="outline" className="text-[10px]">
            {t("unlocked")}
          </Badge>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t("description")}</p>

      {!supported && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-[11px] text-muted-foreground">
          {t("unsupported")}
        </p>
      )}

      <label className="flex items-center gap-2 text-sm">
        <Switch checked={enabled} onCheckedChange={setEnabled} />
        <span className="font-medium">{t("enableLabel")}</span>
      </label>

      <div className="space-y-1">
        <Label className="text-xs" htmlFor="webdav-url">
          {t("urlLabel")}
        </Label>
        <Input
          id="webdav-url"
          value={baseUrl}
          placeholder={t("urlPlaceholder")}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="webdav-folder">
            {t("folderLabel")}
          </Label>
          <Input
            id="webdav-folder"
            value={remoteDir}
            placeholder={DEFAULT_WEBDAV_REMOTE_DIR}
            onChange={(e) => setRemoteDir(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="webdav-user">
            {t("usernameLabel")}
          </Label>
          <Input
            id="webdav-user"
            value={username}
            placeholder={t("usernamePlaceholder")}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs" htmlFor="webdav-password">
          {t("passwordLabel")}
        </Label>
        <div className="flex gap-2">
          <Input
            id="webdav-password"
            type="password"
            value={password}
            placeholder={passwordSaved ? t("passwordSet") : t("passwordPlaceholder")}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
          {passwordSaved && (
            <Button variant="outline" onClick={() => void onClearPassword()}>
              {t("clear")}
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs" htmlFor="webdav-passphrase">
          {t("passphraseLabel")}
        </Label>
        <Input
          id="webdav-passphrase"
          type="password"
          value={passphrase}
          placeholder={unlocked ? t("passphraseUnlocked") : t("passphrasePlaceholder")}
          autoComplete="new-password"
          spellCheck={false}
          onChange={(e) => setPassphrase(e.target.value)}
        />
        <p className="text-[11px] text-muted-foreground">{t("passphraseHint")}</p>
      </div>

      <div className="space-y-1">
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={remember}
            onCheckedChange={(next) => void onToggleRemember(next)}
            data-testid="webdav-remember-passphrase"
          />
          <span className="font-medium">{t("rememberPassphraseLabel")}</span>
        </label>
        <p className="text-[11px] text-muted-foreground">{t("rememberPassphraseDescription")}</p>
      </div>

      <p className="text-[11px] text-muted-foreground" data-testid="webdav-last-sync-line">
        {lastSyncAt
          ? t("lastSync", { time: new Date(lastSyncAt).toLocaleString() })
          : t("neverSynced")}
        {lastSyncDevice ? ` · ${t("producedBy", { device: lastSyncDevice })}` : ""}
      </p>

      {syncPhase ? (
        <p className="text-[11px] text-muted-foreground" data-testid="webdav-sync-phase">
          {phaseLabel(syncPhase)}
        </p>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !supported}
          onClick={() => void onTestConnection()}
        >
          {t("testConnection")}
        </Button>
        <WebDavRestoreDialog
          trigger={
            <Button variant="outline" size="sm" disabled={!supported}>
              {t("restore")}
            </Button>
          }
        />
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !supported}
          onClick={() => void onSyncNow()}
        >
          {busy ? t("syncing") : t("syncNow")}
        </Button>
        <Button size="sm" disabled={saving} onClick={() => void onSave()}>
          {t("save")}
        </Button>
      </div>
    </Card>
  )
}
