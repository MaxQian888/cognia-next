"use client"

// Settings card to configure the self-hosted share worker: its URL (stored in
// AppSettings) and the upload bearer secret (stored in the OS keyring, never in
// IndexedDB plaintext). Pairs with <MySharesPanel/> under Settings → Data.

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { setShareUploadSecret, hasShareUploadSecret } from "@/lib/share/config"
import { toast } from "sonner"
import { MySharesPanel } from "./my-shares-panel"

export function ShareSettingsCard() {
  const t = useTranslations("share.settings")
  const [url, setUrl] = useState("")
  const [secret, setSecret] = useState("")
  const [secretSaved, setSecretSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void (async () => {
      const settings = await getSettings()
      setUrl(settings.shareUrl ?? "")
      setSecretSaved(await hasShareUploadSecret())
    })()
  }, [])

  const onSave = async () => {
    setSaving(true)
    try {
      await saveSettings({ shareUrl: url.trim() || undefined })
      // Only write the secret when the user typed a new one; an empty field
      // leaves the existing keyring entry untouched.
      if (secret) {
        await setShareUploadSecret(secret)
        setSecret("")
        setSecretSaved(true)
      }
      toast.success(t("saved"))
    } finally {
      setSaving(false)
    }
  }

  const onClearSecret = async () => {
    await setShareUploadSecret("")
    setSecretSaved(false)
    toast.success(t("cleared"))
  }

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div>
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <div className="space-y-1">
        <Label className="text-xs" htmlFor="share-url">
          {t("urlLabel")}
        </Label>
        <Input
          id="share-url"
          value={url}
          placeholder={t("urlPlaceholder")}
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>

      <div className="space-y-1">
        <Label className="text-xs" htmlFor="share-secret">
          {t("secretLabel")}
        </Label>
        <div className="flex gap-2">
          <Input
            id="share-secret"
            type="password"
            value={secret}
            placeholder={secretSaved ? t("secretSet") : t("secretPlaceholder")}
            onChange={(e) => setSecret(e.target.value)}
          />
          {secretSaved && (
            <Button variant="outline" onClick={() => void onClearSecret()}>
              {t("clear")}
            </Button>
          )}
        </div>
      </div>

      <Button onClick={() => void onSave()} disabled={saving}>
        {t("save")}
      </Button>

      <div className="border-t pt-4">
        <MySharesPanel />
      </div>
    </div>
  )
}
