"use client"

import { useEffect, useState } from "react"
import { EyeIcon, EyeOffIcon } from "lucide-react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useSettingsStore } from "@/stores/settings"
import { HOST_KEY_PRESENT, type KeyringProviderId } from "@/lib/tts/keyring"
import { loggers } from "@cognia/logging"
import { useSecretReveal } from "@/hooks/use-secret-reveal"

interface Props {
  provider: KeyringProviderId
  label: string
  placeholder?: string
}

/**
 * Masked input for a TTS provider API key. Reads/writes the key via the
 * Tauri keyring (or web fallback). The current value is read from
 * `useSettingsStore.providerKeys` so it survives reloads.
 */
export function ApiKeyInput({ provider, label, placeholder }: Props) {
  const t = useTranslations("settings.speech.apiKey")
  const storedValue = useSettingsStore((s) => s.providerKeys[provider] ?? "")
  const stored = storedValue === HOST_KEY_PRESENT ? "" : storedValue
  const configured = Boolean(storedValue)
  const setProviderApiKey = useSettingsStore((s) => s.setProviderApiKey)
  const clearProviderApiKey = useSettingsStore((s) => s.clearProviderApiKey)
  const ensureProviderKeys = useSettingsStore((s) => s.ensureProviderKeys)

  const [draft, setDraft] = useState(stored)
  const [show, setShow] = useState(false)
  // Settings → Security → "Require biometrics to reveal secrets".
  const revealSecret = useSecretReveal()
  const [busy, setBusy] = useState(false)

  // Provider keys are loaded lazily (not at app boot). The speech settings UI
  // is user-navigated, so trigger the (idempotent) load on mount to surface
  // the stored key.
  useEffect(() => {
    void ensureProviderKeys()
  }, [ensureProviderKeys])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(stored)
  }, [stored])

  const dirty = draft !== stored

  const handleSave = async () => {
    setBusy(true)
    try {
      await setProviderApiKey(provider, draft)
      loggers.tts.info("settings.providerKey.saved", { provider, keySet: Boolean(draft) })
      toast.success(t("savedToast", { label }))
    } catch (err) {
      loggers.tts.error("settings.providerKey.saveFailed", err, { provider })
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleClear = async () => {
    setBusy(true)
    try {
      await clearProviderApiKey(provider)
      setDraft("")
      loggers.tts.info("settings.providerKey.cleared", { provider })
      toast.success(t("clearedToast", { label }))
    } catch (err) {
      loggers.tts.error("settings.providerKey.clearFailed", err, { provider })
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{label}</Label>
        {configured ? (
          <Badge variant="secondary" className="text-[10px]">
            {t("configured")}
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[10px]">
            {t("notConfigured")}
          </Badge>
        )}
      </div>
      <div className="flex gap-2">
        <Input
          type={show ? "text" : "password"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          className="font-mono text-xs"
          autoComplete="off"
          spellCheck={false}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => (show ? setShow(false) : void revealSecret(() => setShow(true)))}
          aria-label={show ? t("hideKey") : t("showKey")}
        >
          {show ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
        </Button>
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={handleSave} disabled={busy || !dirty}>
          {busy ? t("saving") : t("save")}
        </Button>
        {configured && (
          <Button size="sm" variant="outline" onClick={handleClear} disabled={busy}>
            {t("clear")}
          </Button>
        )}
      </div>
    </div>
  )
}
