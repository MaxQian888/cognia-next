"use client"

/**
 * First-visit OCR setup wizard.
 *
 * Three steps: pick a use-case → preview the recommended preset → apply.
 * Reads the recommendation table from `lib/ocr/provider-recommendations.ts`.
 * Auto-opens once (when the user has not dismissed and has no cloud
 * credentials yet); thereafter it's accessible only via the explicit
 * "Open setup wizard" button in the Auto-Router panel.
 *
 * Multi-step Dialog chrome (Progress bar + numbered step indicators) is
 * lifted from `components/settings/provider/local-provider-setup-wizard.tsx`.
 */

import * as React from "react"
import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Check, Wand2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import {
  OCR_USE_CASES,
  RECOMMENDATION_MAP,
  type OcrUseCase,
} from "@/lib/ocr/provider-recommendations"
import type { UserOcrSettings } from "@/lib/ocr/types"

interface OcrSetupWizardProps {
  open: boolean
  onOpenChange: (next: boolean) => void
  settings: UserOcrSettings
  onApply: (next: UserOcrSettings) => void
  onDismiss: () => void
}

type StepId = "useCase" | "preset" | "apply"

const STEPS: readonly { id: StepId }[] = [{ id: "useCase" }, { id: "preset" }, { id: "apply" }]

export function OcrSetupWizard({
  open,
  onOpenChange,
  settings,
  onApply,
  onDismiss,
}: OcrSetupWizardProps): React.ReactElement {
  const t = useTranslations()
  const [stepIdx, setStepIdx] = useState(0)
  const [useCase, setUseCase] = useState<OcrUseCase>("mixed")

  const preset = useMemo(() => RECOMMENDATION_MAP[useCase], [useCase])
  const progress = ((stepIdx + 1) / STEPS.length) * 100

  const reset = useCallback(() => {
    setStepIdx(0)
    setUseCase("mixed")
  }, [])

  const handleApply = () => {
    const next: UserOcrSettings = {
      ...settings,
      defaultProviderId: preset.providers[0] ?? settings.defaultProviderId,
      defaultLanguages: [...preset.defaultLanguages],
      defaultFormat: preset.defaultFormat,
      cloudFallbackEnabled: true,
      cloudFallbackProviderId:
        preset.providers.find((id) => id !== preset.providers[0]) ??
        settings.cloudFallbackProviderId,
      ocrWizardDismissed: true,
    }
    onApply(next)
    onOpenChange(false)
    reset()
  }

  const handleDismiss = () => {
    onDismiss()
    onOpenChange(false)
    reset()
  }

  const next = () => setStepIdx((i) => Math.min(STEPS.length - 1, i + 1))
  const back = () => setStepIdx((i) => Math.max(0, i - 1))

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        // Closing without explicit Apply / Dismiss counts as a dismiss so the
        // user isn't badgered again on next mount.
        if (!nextOpen) handleDismiss()
        else onOpenChange(true)
      }}
    >
      <DialogContent className="max-w-lg" data-testid="ocr-setup-wizard">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-4 w-4" />
            {t("ocr.wizard.title")}
          </DialogTitle>
          <DialogDescription>{t("ocr.wizard.description")}</DialogDescription>
        </DialogHeader>

        <Progress value={progress} className="h-1.5" />
        <ol className="flex items-center gap-3 text-xs">
          {STEPS.map((step, i) => (
            <li key={step.id} className="flex items-center gap-1">
              <span
                className={cn(
                  "flex h-5 w-5 items-center justify-center rounded-full border text-[10px]",
                  i < stepIdx
                    ? "border-emerald-500 bg-emerald-500 text-white"
                    : i === stepIdx
                      ? "border-primary text-primary"
                      : "border-muted-foreground/40 text-muted-foreground"
                )}
                data-testid={`ocr-wizard-step-marker-${i}`}
              >
                {i < stepIdx ? <Check className="h-3 w-3" /> : i + 1}
              </span>
              <span className={i === stepIdx ? "font-medium" : "text-muted-foreground"}>
                {t(`ocr.wizard.step.${step.id}`)}
              </span>
            </li>
          ))}
        </ol>

        {stepIdx === 0 && (
          <div className="space-y-3" data-testid="ocr-wizard-step-useCase">
            <p className="text-sm">{t("ocr.wizard.useCasePrompt")}</p>
            <Select value={useCase} onValueChange={(v) => setUseCase(v as OcrUseCase)}>
              <SelectTrigger data-testid="ocr-wizard-use-case-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OCR_USE_CASES.map((uc) => (
                  <SelectItem key={uc} value={uc}>
                    {t(`ocr.wizard.useCases.${uc}.label`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p
              className="text-xs text-muted-foreground"
              data-testid="ocr-wizard-use-case-description"
            >
              {t(`ocr.wizard.useCases.${useCase}.description`)}
            </p>
          </div>
        )}

        {stepIdx === 1 && (
          <div className="space-y-3" data-testid="ocr-wizard-step-preset">
            <p className="text-sm">{t("ocr.wizard.presetIntro")}</p>
            <div className="rounded-lg border p-3 text-sm">
              <div className="mb-2 font-medium">{t("ocr.wizard.preset.providers")}</div>
              <div className="flex flex-wrap gap-1">
                {preset.providers.map((id, idx) => (
                  <Badge
                    key={id}
                    variant={idx === 0 ? "default" : "secondary"}
                    data-testid={`ocr-wizard-preset-provider-${id}`}
                  >
                    {id}
                    {idx === 0 && (
                      <span className="ml-1 text-[10px]">
                        ({t("ocr.wizard.preset.defaultBadge")})
                      </span>
                    )}
                  </Badge>
                ))}
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">{t("ocr.wizard.preset.format")}</dt>
                <dd>{preset.defaultFormat}</dd>
                <dt className="text-muted-foreground">{t("ocr.wizard.preset.languages")}</dt>
                <dd>{preset.defaultLanguages.join(", ")}</dd>
              </dl>
            </div>
          </div>
        )}

        {stepIdx === 2 && (
          <div className="space-y-3" data-testid="ocr-wizard-step-apply">
            <p className="text-sm">{t("ocr.wizard.applyIntro")}</p>
            <p className="rounded bg-muted/40 p-3 text-xs text-muted-foreground">
              {t("ocr.wizard.applyDetail", { provider: preset.providers[0] })}
            </p>
          </div>
        )}

        <DialogFooter className="flex items-center gap-2 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleDismiss}
            data-testid="ocr-wizard-dismiss"
          >
            {t("ocr.wizard.dismiss")}
          </Button>
          <div className="flex gap-2">
            {stepIdx > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={back}
                data-testid="ocr-wizard-back"
              >
                {t("ocr.wizard.back")}
              </Button>
            )}
            {stepIdx < STEPS.length - 1 ? (
              <Button type="button" size="sm" onClick={next} data-testid="ocr-wizard-next">
                {t("ocr.wizard.next")}
              </Button>
            ) : (
              <Button type="button" size="sm" onClick={handleApply} data-testid="ocr-wizard-apply">
                {t("ocr.wizard.apply")}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Helper: returns true when no cloud provider has any credential field set. */
export function hasNoCloudCredentials(
  credentials: Record<string, Record<string, string>> | undefined,
  cloudProviderIds: readonly string[]
): boolean {
  if (!credentials) return true
  for (const id of cloudProviderIds) {
    const entry = credentials[id]
    if (!entry) continue
    if (Object.values(entry).some((v) => v.trim().length > 0)) return false
  }
  return true
}
