"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { useSettingsStore } from "@/stores/settings-store"
import { EyeIcon, EyeOffIcon, KeyRoundIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

export function ApiKeySection() {
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
      toast.success(draft ? "API key saved. Sidecar restarted." : "API key cleared.")
    } catch (err) {
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
      toast.success("API key cleared.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="api-key" className="flex items-center gap-2">
          <KeyRoundIcon className="size-4" />
          Anthropic API key
        </Label>
        <p className="text-xs text-muted-foreground">
          Provide your <code>ANTHROPIC_API_KEY</code>. Stored locally in IndexedDB and injected into
          the sidecar&apos;s environment on launch.
        </p>
      </div>

      <div className="flex gap-2">
        <Input
          id="api-key"
          type={show ? "text" : "password"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="sk-ant-…"
          className="font-mono text-xs"
          autoComplete="off"
          spellCheck={false}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? "Hide API key" : "Show API key"}
        >
          {show ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
        </Button>
      </div>

      <div className="flex gap-2">
        <Button onClick={handleSave} disabled={saving || draft === (settings?.apiKey ?? "")}>
          {saving ? "Saving…" : "Save key"}
        </Button>
        {settings?.apiKey && (
          <Button variant="outline" onClick={handleClear} disabled={saving}>
            Clear
          </Button>
        )}
      </div>

      <Alert variant="default">
        <AlertTitle className="text-sm">Privacy note</AlertTitle>
        <AlertDescription className="text-xs">
          The key is stored as plaintext in your browser&apos;s IndexedDB. Anyone with disk access
          to your user profile can read it. A future release will move this into your OS keyring.
        </AlertDescription>
      </Alert>
    </div>
  )
}
