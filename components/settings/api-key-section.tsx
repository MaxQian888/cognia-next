"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { useSettingsStore } from "@/stores/settings"
import { EyeIcon, EyeOffIcon, KeyRoundIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { createLogger } from "@/lib/logger"

const log = createLogger("settings.apiKey")

export function ApiKeySection() {
  const t = useTranslations("settings.apiKey")
  const settings = useSettingsStore((s) => s.settings)
  const setApiKey = useSettingsStore((s) => s.setApiKey)

  const [draft, setDraft] = useState(settings?.apiKey ?? "")
  const [show, setShow] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(settings?.apiKey ?? "")
  }, [settings?.apiKey])

  const handleSave = async () => {
    setSaving(true)
    try {
      await setApiKey(draft)
      log.info("api_key_saved", { keySet: Boolean(draft) })
      toast.success(draft ? t("savedAndRestarted") : t("cleared"))
    } catch (err) {
      log.error("api_key_save_failed", err)
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleClear = async () => {
    setDraft("")
    setSaving(true)
    try {
      await setApiKey(null)
      log.info("api_key_cleared")
      toast.success(t("cleared"))
    } catch (err) {
      log.error("api_key_clear_failed", err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="api-key" className="flex items-center gap-2">
          <KeyRoundIcon className="size-4" />
          {t("label")}
        </Label>
        <p className="text-xs text-muted-foreground">
          {t("hintBefore")}
          <code>{t("hintCode")}</code>
          {t("hintAfter")}
        </p>
      </div>

      <div className="flex gap-2">
        <Input
          id="api-key"
          type={show ? "text" : "password"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t("placeholder")}
          className="font-mono text-xs"
          autoComplete="off"
          spellCheck={false}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? t("hideKey") : t("showKey")}
        >
          {show ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
        </Button>
      </div>

      <div className="flex gap-2">
        <Button onClick={handleSave} disabled={saving || draft === (settings?.apiKey ?? "")}>
          {saving ? t("saving") : t("save")}
        </Button>
        {settings?.apiKey && (
          <Button variant="outline" onClick={handleClear} disabled={saving}>
            {t("clear")}
          </Button>
        )}
      </div>

      <Alert variant="default">
        <AlertTitle className="text-sm">{t("privacyTitle")}</AlertTitle>
        <AlertDescription className="text-xs">{t("privacyBody")}</AlertDescription>
      </Alert>
    </div>
  )
}
