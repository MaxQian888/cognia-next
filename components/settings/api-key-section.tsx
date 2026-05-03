"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { useSettingsStore } from "@/stores/settings"
import { ArrowLeftRightIcon, EyeIcon, EyeOffIcon, KeyRoundIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { createLogger } from "@/lib/logger"
import { isTauri } from "@/lib/tauri"

const log = createLogger("settings.apiKey")

export function ApiKeySection() {
  const t = useTranslations("settings.apiKey")
  const settings = useSettingsStore((s) => s.settings)
  const setApiKey = useSettingsStore((s) => s.setApiKey)

  const setProviderConfig = useSettingsStore((s) => s.setProviderConfig)
  const router = useRouter()
  const searchParams = useSearchParams()
  const [draft, setDraft] = useState(settings?.apiKey ?? "")
  const [show, setShow] = useState(false)
  const [saving, setSaving] = useState(false)

  const goToCcswitch = () => {
    const next = new URLSearchParams(searchParams.toString())
    next.set("section", "ccswitch")
    router.replace(`/settings?${next.toString()}`, { scroll: false })
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(settings?.apiKey ?? "")
  }, [settings?.apiKey])

  const handleSave = async () => {
    setSaving(true)
    try {
      // Phase C.5: write through to BOTH the legacy `AppSettings.apiKey`
      // (for the existing chat path) AND the new providers map slot for
      // Anthropic (so the providers settings page reflects this key).
      // This keeps the two surfaces in lock-step until the legacy field
      // is retired.
      await setApiKey(draft)
      await setProviderConfig("anthropic", { apiKey: draft || undefined })
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
      await setProviderConfig("anthropic", { apiKey: undefined })
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

      {isTauri() && (
        <Alert variant="default" className="border-dashed">
          <ArrowLeftRightIcon className="size-4" />
          <AlertTitle className="text-sm">{t("ccswitchHintTitle")}</AlertTitle>
          <AlertDescription className="text-xs flex items-center justify-between gap-2">
            <span className="flex-1 min-w-0">{t("ccswitchHintBody")}</span>
            <Button variant="outline" size="sm" onClick={goToCcswitch} className="shrink-0">
              {t("ccswitchHintAction")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}
