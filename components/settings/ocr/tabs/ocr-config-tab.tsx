"use client"

/**
 * OCR Config tab — drives the credential form for a single OCR provider.
 *
 * Inputs are generated from `provider.credentialKeys` (declared in
 * `lib/ocr/providers/<id>.ts`), so adding a new provider doesn't require
 * touching this file. Vision providers that reuse the main provider key
 * (anthropic-vision / openai-vision / gemini-vision) render an info alert
 * instead of inputs.
 *
 * A "Probe connection" button calls back into the parent (which builds the
 * real `ExtractDeps` / probe helper), and the most recent probe result is
 * shown inline as a status alert.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Eye, EyeOff, FlaskConical, Info } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { ProbeOutcome } from "@/lib/ocr/probe"
import type { OcrProviderShellSupport } from "@/types/ocr"
import { useSecretReveal } from "@/hooks/use-secret-reveal"

interface OcrConfigTabProps {
  providerId: string
  credentialKeys: readonly string[]
  reusesMainProviderKey?: boolean
  shells: OcrProviderShellSupport
  credentials: Record<string, string>
  onCredentialChange: (key: string, value: string) => void
  /** Optional — when present, the Probe button is rendered. */
  onProbe?: () => void | Promise<void>
  probeOutcome?: ProbeOutcome
  isProbing?: boolean
  /** Renders a description string for the reusesMainProviderKey alert. */
  description?: string
}

export function OcrConfigTab({
  providerId,
  credentialKeys,
  reusesMainProviderKey,
  shells,
  credentials,
  onCredentialChange,
  onProbe,
  probeOutcome,
  isProbing,
  description,
}: OcrConfigTabProps): React.ReactElement {
  const t = useTranslations()

  const showCredentials = credentialKeys.length > 0
  const showShellPills = !showCredentials && !reusesMainProviderKey
  const probeable = (credentialKeys.length > 0 || reusesMainProviderKey === true) && !!onProbe

  return (
    <div className="space-y-5" data-testid="ocr-config-tab">
      {probeOutcome && (
        <Alert variant={probeOutcome.ok ? "default" : "destructive"} data-testid="ocr-probe-alert">
          <FlaskConical />
          <AlertTitle>
            {probeOutcome.ok
              ? t("ocr.probe.successWithLatency", { ms: Math.round(probeOutcome.durationMs) })
              : t("ocr.probe.failure", {
                  message: probeOutcome.error?.message ?? probeOutcome.error?.code ?? "",
                })}
          </AlertTitle>
        </Alert>
      )}

      {description && <p className="text-sm text-muted-foreground">{description}</p>}

      {reusesMainProviderKey && (
        <Alert data-testid="ocr-reuses-main-key">
          <Info />
          <AlertDescription>
            {t("ocr.credentials.reusesMainProviderHint", {
              provider: mainProviderLabel(providerId),
            })}
          </AlertDescription>
        </Alert>
      )}

      {showCredentials && (
        <div className="space-y-4">
          {credentialKeys.map((key) => (
            <CredentialRow
              key={key}
              providerId={providerId}
              credentialKey={key}
              value={credentials[key] ?? ""}
              onChange={(next) => onCredentialChange(key, next)}
            />
          ))}
        </div>
      )}

      {showShellPills && (
        <div className="space-y-2" data-testid="ocr-shell-pills">
          <p className="text-sm text-muted-foreground">{t("ocr.detail.noCredentials")}</p>
          <div className="flex flex-wrap gap-2">
            {shells.browser && (
              <Badge variant="outline">{t("ocr.detail.shellSupportBrowser")}</Badge>
            )}
            {shells.tauri && <Badge variant="outline">{t("ocr.detail.shellSupportDesktop")}</Badge>}
            {shells.capacitor && (
              <Badge variant="outline">{t("ocr.detail.shellSupportMobile")}</Badge>
            )}
          </div>
        </div>
      )}

      {probeable && (
        <div className="flex items-center justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void onProbe?.()}
            disabled={isProbing}
            data-testid="ocr-probe-button"
          >
            <FlaskConical className="mr-1.5 h-3.5 w-3.5" />
            {isProbing ? t("ocr.probe.running") : t("ocr.probe.button")}
          </Button>
        </div>
      )}
    </div>
  )
}

/* ─────────────────────────── credential row ─────────────────────────── */

interface CredentialRowProps {
  providerId: string
  credentialKey: string
  value: string
  onChange: (next: string) => void
}

function CredentialRow({ providerId, credentialKey, value, onChange }: CredentialRowProps) {
  const t = useTranslations()
  const [reveal, setReveal] = useState(false)
  // Settings → Security → "Require biometrics to reveal secrets".
  const revealSecret = useSecretReveal()
  const labelKey = `ocr.credentials.${credentialKey}` as const
  const label = useMemo(() => {
    // `t.has` is non-standard but our jest-mock + next-intl runtime both
    // expose it; fall back to the raw key so unknown credentials still
    // render a label rather than throwing.
    const has = (t as unknown as { has?: (k: string) => boolean }).has
    return has?.(labelKey) ? t(labelKey) : credentialKey
  }, [credentialKey, labelKey, t])
  const id = `ocr-cred-${providerId}-${credentialKey}`
  const showHideLabel = reveal ? t("ocr.credentials.hide") : t("ocr.credentials.show")
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-sm font-medium">
        {label}
      </Label>
      <div className="relative">
        <Input
          id={id}
          type={reveal ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="new-password"
          data-lpignore="true"
          data-form-type="other"
          placeholder={t("ocr.credentials.placeholder")}
          className="pr-10"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2"
          aria-label={showHideLabel}
          onClick={() => (reveal ? setReveal(false) : void revealSecret(() => setReveal(true)))}
        >
          {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  )
}

function mainProviderLabel(providerId: string): string {
  if (providerId.startsWith("anthropic")) return "Anthropic"
  if (providerId.startsWith("openai")) return "OpenAI"
  if (providerId.startsWith("gemini")) return "Google AI"
  return "AI"
}
