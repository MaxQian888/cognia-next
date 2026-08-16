"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { EyeIcon, EyeOffIcon, ShieldCheckIcon } from "lucide-react"

import { SettingsToggle } from "@/components/settings/common/settings-section"
import { Button } from "@/components/ui/button"
import {
  useSupportDiagnosticsConsent,
  type SupportConsentSurface,
} from "@/hooks/support/use-support-diagnostics-consent"
import { getLocalRuntimeDiagnostics } from "@/lib/native/local-runtime"
import { serializeSupportDiagnostics } from "@/lib/support-agent/context"
import { cn } from "@/lib/utils"

export interface SupportDiagnosticsConsentProps {
  surface: SupportConsentSurface
  className?: string
}

/**
 * The Support Agent's local diagnostics kill switch, with a preview of the
 * exact redacted payload the agent would read. One component for the chat
 * strip's popover and the Settings → Characters row; the state itself is
 * shared through `useSupportDiagnosticsConsent`.
 */
export function SupportDiagnosticsConsent({ surface, className }: SupportDiagnosticsConsentProps) {
  const t = useTranslations("support.consent")
  const { enabled, setEnabled } = useSupportDiagnosticsConsent(surface)
  const [preview, setPreview] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)

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

  const showPreview = enabled && preview !== null

  return (
    <div className={cn("space-y-2", className)} data-testid="support-diagnostics-consent">
      <SettingsToggle
        id={`support-diagnostics-${surface}`}
        icon={<ShieldCheckIcon />}
        label={t("label")}
        description={t("description")}
        checked={enabled}
        onCheckedChange={setEnabled}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
        disabled={!enabled || previewing}
        aria-expanded={showPreview}
        onClick={() => void togglePreview()}
      >
        {showPreview ? (
          <EyeOffIcon className="size-3.5" aria-hidden="true" />
        ) : (
          <EyeIcon className="size-3.5" aria-hidden="true" />
        )}
        {showPreview ? t("hidePreview") : t("preview")}
      </Button>
      {showPreview && (
        <pre
          className="max-h-48 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap"
          aria-live="polite"
        >
          {preview}
        </pre>
      )}
    </div>
  )
}
