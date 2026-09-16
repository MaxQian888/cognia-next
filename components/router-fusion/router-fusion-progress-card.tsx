"use client"

// The progress card of a cascade or panel run still in flight (ADR-0188 B3,
// D7/D23). A fusion answer is shown only once it is verified, so while the run
// works this card, pinned above the composer, says which phase it is in, how
// many model calls it made and what it has spent against its cap; it expands
// into the same details the finished answer's run card shows. Stopping uses
// the composer's own stop button. Renders nothing when no fusion run is in
// flight in the conversation, which is always the case while Router + Fusion
// chat is off.

import { useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useFusionProgress } from "@/stores/chat/fusion-progress-store"

import { formatMicrousd, FusionRunDetails, useFusionPhaseText } from "./fusion-run-details"

export function RouterFusionProgressCard({ sessionId }: { sessionId: string | null | undefined }) {
  const t = useTranslations("routerFusion.progress")
  const phaseText = useFusionPhaseText()
  const entry = useFusionProgress(sessionId)
  if (!entry) return null
  const { summary } = entry
  const latest = summary?.timeline.phases.at(-1)
  const phase = latest ? phaseText(latest.phase, latest.step) : t("starting")
  const title = entry.mode === "panel" ? t("runningPanel") : t("runningCascade")

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="router-fusion-progress"
      className="mb-2 flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-xs"
    >
      <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate">
          <span className="font-medium">{title}</span>
          <span className="text-muted-foreground"> · {phase}</span>
        </p>
        <p className="truncate text-[11px] text-muted-foreground">{t("buffered")}</p>
      </div>
      <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
        {summary ? `${t("calls", { count: summary.modelCalls })} · ` : null}
        {t("spent", {
          spent: formatMicrousd(summary?.spentMicrousd ?? 0),
          cap: formatMicrousd(summary?.capMicrousd ?? entry.capMicrousd),
        })}
      </span>
      {summary ? (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="router-fusion-progress-details-trigger"
              className="h-6 shrink-0 px-2 text-[11px]"
            >
              {t("details")}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="w-80 p-3 text-xs"
            data-testid="router-fusion-progress-details"
          >
            <FusionRunDetails summary={summary} />
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  )
}
