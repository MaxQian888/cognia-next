"use client"

/**
 * What happened when a recording ended without the user asking.
 *
 * Two things it always says: *why*, and that nothing was lost. The journal is
 * preserved on every interrupt path, so "pick up where it stopped" is a real
 * offer rather than a hope — and saying so is what stops a kill switch feeling
 * like a data-loss event.
 *
 * Permission loss and the kill switch offer no retry: one needs a settings trip,
 * and the other was an explicit "stop" that we must not quietly undo.
 */

import { useTranslations } from "next-intl"
import { AlertTriangle } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import type { RecorderInterrupt } from "@/lib/skills/recording/state-machine"

interface Props {
  interrupt: RecorderInterrupt
  onRetry: () => void
  onDiscard: () => void
}

export function RecorderInterruptBanner({ interrupt, onRetry, onDiscard }: Props) {
  const t = useTranslations("skills.recorder.interrupt")

  return (
    <Alert>
      <AlertTriangle className="size-4" aria-hidden />
      <AlertTitle>{t("title")}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p className="text-xs">{t(`reason.${interrupt.reason}`)}</p>
        <p className="text-xs text-muted-foreground">{t("recoverable")}</p>
        <div className="flex gap-2">
          {interrupt.retriable ? (
            <Button size="sm" onClick={onRetry}>
              {t("retry")}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={onDiscard}>
            {t("discard")}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}
