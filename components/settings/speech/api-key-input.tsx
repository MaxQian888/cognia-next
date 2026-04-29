"use client"

import { useEffect, useState } from "react"
import { EyeIcon, EyeOffIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useSettingsStore } from "@/stores/settings-store"
import { type KeyringProviderId } from "@/lib/tts/keyring"

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
  const stored = useSettingsStore((s) => s.providerKeys[provider] ?? "")
  const setProviderApiKey = useSettingsStore((s) => s.setProviderApiKey)
  const clearProviderApiKey = useSettingsStore((s) => s.clearProviderApiKey)

  const [draft, setDraft] = useState(stored)
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(stored)
  }, [stored])

  const dirty = draft !== stored

  const handleSave = async () => {
    setBusy(true)
    try {
      await setProviderApiKey(provider, draft)
      toast.success(`${label} API key saved.`)
    } catch (err) {
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
      toast.success(`${label} API key cleared.`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{label}</Label>
        {stored ? (
          <Badge variant="secondary" className="text-[10px]">
            Configured
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[10px]">
            Not configured
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
          onClick={() => setShow((s) => !s)}
          aria-label={show ? "Hide key" : "Show key"}
        >
          {show ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
        </Button>
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={handleSave} disabled={busy || !dirty}>
          {busy ? "Saving…" : "Save"}
        </Button>
        {stored && (
          <Button size="sm" variant="outline" onClick={handleClear} disabled={busy}>
            Clear
          </Button>
        )}
      </div>
    </div>
  )
}
