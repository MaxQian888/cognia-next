"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { getLocalRuntimeDiagnostics } from "@/lib/native/local-runtime"
import { trackEvent } from "@/lib/telemetry/events/track-event"
import {
  isSupportDiagnosticsEnabled,
  serializeSupportDiagnostics,
  setSupportDiagnosticsEnabled,
} from "@/lib/support-agent/context"

export function SupportAgentControls({ surface = "settings" }: { surface?: "chat" | "settings" }) {
  const t = useTranslations("settings.characters.support")
  const [diagnosticsEnabled, setDiagnosticsEnabled] = useState(() => isSupportDiagnosticsEnabled())
  const [preview, setPreview] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)

  const updateDiagnostics = (enabled: boolean) => {
    setSupportDiagnosticsEnabled(enabled)
    setDiagnosticsEnabled(enabled)
    if (!enabled) setPreview(null)
    void trackEvent("support.diagnostics.consent.changed", { enabled, surface })
  }

  const togglePreview = async () => {
    if (preview) {
      setPreview(null)
      return
    }
    setPreviewing(true)
    try {
      const diagnostics = await getLocalRuntimeDiagnostics()
      setPreview(diagnostics ? serializeSupportDiagnostics(diagnostics) : t("previewUnavailable"))
    } catch {
      setPreview(t("previewUnavailable"))
    } finally {
      setPreviewing(false)
    }
  }

  return (
    <div className="mt-2 space-y-2 rounded-md border bg-muted/20 p-2">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <Label htmlFor="support-agent-diagnostics" className="text-[11px] font-medium">
            {t("diagnostics")}
          </Label>
          <p className="text-[10px] text-muted-foreground">{t("diagnosticsDescription")}</p>
        </div>
        <Switch
          id="support-agent-diagnostics"
          checked={diagnosticsEnabled}
          onCheckedChange={updateDiagnostics}
          aria-label={t("diagnostics")}
        />
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-[10px]"
        disabled={!diagnosticsEnabled || previewing}
        onClick={() => void togglePreview()}
      >
        {preview ? t("hidePreview") : t("preview")}
      </Button>
      {preview ? (
        <pre
          className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-[10px]"
          aria-live="polite"
        >
          {preview}
        </pre>
      ) : null}
    </div>
  )
}
