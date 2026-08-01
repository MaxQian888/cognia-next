"use client"

/**
 * Editing one step.
 *
 * The screenshot is loaded on demand rather than held with the step — a
 * recording's frames are hundreds of megabytes, and this pane shows one at a
 * time.
 *
 * A step whose typed content was secret shows an explicit note instead of an
 * empty field. Leaving it blank would read as "nothing was typed", which is a
 * different and wrong claim.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { RecordedStepView } from "@/lib/skills/recording/step-model"
import { describeStepRow } from "./review-timeline"

interface Props {
  step: RecordedStepView | null
  loadScreenshot: (assetId: string) => Promise<string | null>
  onIntentChange: (seq: number, intent: string) => void
  onVerifyChange: (seq: number, verify: string) => void
  onScreenshotToggle: (seq: number, selected: boolean) => void
  onMove: (seq: number, delta: number) => void
  onRemoveManual: (seq: number) => void
}

export function ReviewStepDetail({
  step,
  loadScreenshot,
  onIntentChange,
  onVerifyChange,
  onScreenshotToggle,
  onMove,
  onRemoveManual,
}: Props) {
  const t = useTranslations("skills.recorder")
  // Keyed by the asset it belongs to, rather than cleared in the effect: a
  // synchronous reset inside an effect cascades a second render, and the frame
  // from the *previous* step would flash in the gap before the new one loads.
  const [loaded, setLoaded] = useState<{ assetId: string; bytes: string | null }>({
    assetId: "",
    bytes: null,
  })
  const assetId = step?.captured?.assetId ?? null
  const bytes = assetId && loaded.assetId === assetId ? loaded.bytes : null

  useEffect(() => {
    let cancelled = false
    if (!assetId) return
    void loadScreenshot(assetId).then((value) => {
      if (!cancelled) setLoaded({ assetId, bytes: value })
    })
    return () => {
      cancelled = true
    }
  }, [assetId, loadScreenshot])

  if (!step) {
    return <p className="p-4 text-sm text-muted-foreground">{t("review.selectStep")}</p>
  }

  const isSensitive = step.captured?.text?.kind === "sensitive"

  return (
    <div className="space-y-4 p-1">
      <div className="flex items-center gap-1">
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={t("review.moveUp")}
          onClick={() => onMove(step.seq, -1)}
        >
          <ArrowUp className="size-3.5" aria-hidden />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={t("review.moveDown")}
          onClick={() => onMove(step.seq, 1)}
        >
          <ArrowDown className="size-3.5" aria-hidden />
        </Button>
        {step.manual ? (
          <Button
            size="icon"
            variant="ghost"
            className="size-7 text-destructive"
            aria-label={t("review.manualRemove")}
            onClick={() => onRemoveManual(step.seq)}
          >
            <Trash2 className="size-3.5" aria-hidden />
          </Button>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="recorder-step-intent">{t("review.intent")}</Label>
        <Input
          id="recorder-step-intent"
          value={step.intent ?? ""}
          placeholder={describeStepRow(step, t) || t("review.intentPlaceholder")}
          onChange={(event) => onIntentChange(step.seq, event.target.value)}
          aria-describedby={step.needsIntent ? "recorder-step-intent-hint" : undefined}
        />
        {step.needsIntent ? (
          <p id="recorder-step-intent-hint" className="text-xs text-amber-600 dark:text-amber-500">
            {t("review.needsIntentHint")}
          </p>
        ) : null}
      </div>

      {isSensitive ? (
        <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
          {t("review.sensitive")}
        </p>
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="recorder-step-verify">{t("review.verify")}</Label>
        <Textarea
          id="recorder-step-verify"
          rows={2}
          value={step.verify ?? ""}
          placeholder={t("review.verifyPlaceholder")}
          onChange={(event) => onVerifyChange(step.seq, event.target.value)}
        />
      </div>

      {assetId ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Checkbox
              id="recorder-step-screenshot"
              checked={step.screenshotSelected}
              onCheckedChange={(checked) => onScreenshotToggle(step.seq, checked === true)}
            />
            <Label htmlFor="recorder-step-screenshot" className="text-sm font-normal">
              {t("review.screenshotSelect")}
            </Label>
          </div>
          {bytes ? (
            // eslint-disable-next-line @next/next/no-img-element -- a base64 frame read from the local bundle; there is no URL to optimize
            <img
              src={`data:image/png;base64,${bytes}`}
              alt=""
              className="w-full rounded-md border"
            />
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t("review.screenshotNone")}</p>
      )}
    </div>
  )
}
