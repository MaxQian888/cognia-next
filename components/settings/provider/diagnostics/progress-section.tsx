"use client"

import { Ban, Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { ProviderSection } from "../provider-section"
import type { ResolvedProviderDiagnosticTarget } from "@/lib/provider-diagnostics/service"

export interface ProgressSectionProps {
  /** 0–100. */
  percent: number
  completedCount: number
  targetCount: number
  /** Targets still queued or in flight — each can be cancelled individually. */
  pendingTargets: ResolvedProviderDiagnosticTarget[]
  onCancelAll: () => void
  onCancelTarget: (targetId: string) => void
  /** A paired client cannot cancel the desktop's work. */
  cancelDisabled?: boolean
}

/**
 * Live progress for the running job. Rendered only while a job is in flight —
 * an idle placeholder here just pushed the results further down the pane.
 */
export function ProgressSection({
  percent,
  completedCount,
  targetCount,
  pendingTargets,
  onCancelAll,
  onCancelTarget,
  cancelDisabled = false,
}: ProgressSectionProps) {
  const t = useTranslations("providers.diagnostics")

  return (
    <ProviderSection
      icon={Loader2}
      title={t("progress.title")}
      className="[&>div_svg.lucide-loader-circle]:animate-spin motion-reduce:[&>div_svg.lucide-loader-circle]:animate-none"
      actions={
        <Button
          variant="destructive"
          size="sm"
          onClick={onCancelAll}
          disabled={cancelDisabled}
          data-testid="diagnostics-cancel-all"
        >
          <Ban className="mr-1 h-3.5 w-3.5" />
          {t("progress.cancelAll")}
        </Button>
      }
      data-testid="diagnostics-progress"
    >
      <div className="space-y-3" aria-live="polite">
        <Progress
          value={percent}
          aria-label={t("progress.aria", { percent: Math.round(percent) })}
        />
        <p className="text-xs text-muted-foreground">
          {t("progress.count", { completed: completedCount, total: targetCount })}
        </p>
        <div className="space-y-1">
          {pendingTargets.map((target) => (
            <div
              key={target.id}
              className="flex items-center justify-between gap-2 rounded border px-2 py-1.5 text-xs"
            >
              <span className="truncate">
                {target.modelId ?? t("composer.probe")} · {target.endpoint}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0"
                disabled={cancelDisabled}
                onClick={() => onCancelTarget(target.id)}
              >
                {t("progress.cancelTarget")}
              </Button>
            </div>
          ))}
        </div>
      </div>
    </ProviderSection>
  )
}
