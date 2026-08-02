"use client"

import { Download, History, Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { formatMs } from "@/lib/provider-diagnostics/format"
import { trendDurationMs, type ProviderDiagnosticTrend } from "@/lib/provider-diagnostics/analysis"
import { ProviderSection } from "../provider-section"
import type { ProviderDiagnosticSample } from "@cognia/provider-types"

/** Rows listed under the trend chart; the export carries the full log. */
const MAX_LISTED_SAMPLES = 20

export interface HistorySectionProps {
  /** Samples passing the current filters, newest first. */
  samples: ProviderDiagnosticSample[]
  trend: ProviderDiagnosticTrend
  onExport: () => void
  onClear: () => void
  /** A paired client cannot clear the desktop's log, but can still export it. */
  clearDisabled?: boolean
}

/**
 * Run log: a duration sparkline over the recent samples plus the individual
 * rows behind it. Collapsed by default — it is reference material once the
 * matrix above has already answered "which target should I use".
 */
export function HistorySection({
  samples,
  trend,
  onExport,
  onClear,
  clearDisabled = false,
}: HistorySectionProps) {
  const t = useTranslations("providers.diagnostics")

  return (
    <ProviderSection
      collapsible
      defaultOpen={false}
      icon={History}
      title={t("history.title")}
      description={t("history.description")}
      data-testid="diagnostics-history"
      actions={
        <>
          <Button
            variant="outline"
            size="sm"
            aria-label={t("history.exportJson")}
            onClick={onExport}
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-label={t("history.clear")}
            disabled={clearDisabled}
            onClick={onClear}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </>
      }
    >
      {samples.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t("history.empty")}</p>
      ) : (
        <>
          <div
            className="mb-4 flex h-28 items-end gap-1 rounded-lg border bg-muted/20 p-3"
            role="img"
            aria-label={t("history.chartAria")}
          >
            {trend.samples.map((sample) => {
              const duration = trendDurationMs(sample)
              return (
                <div
                  key={sample.id}
                  className="min-w-1 flex-1 rounded-t bg-primary/70"
                  // Floor of 4% keeps a near-instant sample visible as a bar
                  // rather than collapsing it to an invisible zero-height sliver.
                  style={{ height: `${Math.max(4, (duration / trend.maxDurationMs) * 100)}%` }}
                  title={`${sample.modelId ?? t("composer.probe")}: ${formatMs(duration)}`}
                />
              )
            })}
          </div>
          <div className="space-y-2">
            {samples.slice(0, MAX_LISTED_SAMPLES).map((sample) => (
              <div
                key={sample.id}
                className="grid grid-cols-[1fr_auto] gap-2 rounded border p-2 text-xs"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {sample.modelId ?? t("composer.probe")} · {sample.endpoint}
                  </p>
                  <p className="truncate text-muted-foreground">
                    {new Date(sample.startedAt).toLocaleString()} · {sample.capability} ·{" "}
                    {sample.credentialFingerprint}
                  </p>
                </div>
                <span>{formatMs(sample.metrics?.totalDurationMs ?? sample.probe?.durationMs)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </ProviderSection>
  )
}
