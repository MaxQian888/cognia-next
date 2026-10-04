"use client"

/**
 * Full-dashboard empty state — shown when the selected time window holds no
 * spans at all (as opposed to filters hiding everything, which the per-panel
 * "no data" hints cover). Explains what produces telemetry and offers a
 * one-click widen to the longest preset.
 *
 * `ObservabilityLoadError` is its sibling for the other way a window can come
 * back empty: the Dexie read FAILED. Both sub-views render it with a Retry —
 * before, a failed read either took the page down through `useLiveQuery`'s
 * render-time rethrow or sat on "loading" forever.
 */

import { useTranslations } from "next-intl"
import { AlertTriangleIcon, GaugeIcon, RotateCcwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

export interface ObservabilityEmptyStateProps {
  /** Widen the range to the longest preset. Absent → button hidden. */
  onWidenRange?: () => void
}

export function ObservabilityEmptyState({ onWidenRange }: ObservabilityEmptyStateProps) {
  const t = useTranslations("observability.empty")
  return (
    <Empty
      className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center"
      data-testid="observability-empty"
    >
      <EmptyMedia variant="icon">
        <GaugeIcon className="size-8 text-muted-foreground/50" aria-hidden="true" />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle className="text-sm">{t("title")}</EmptyTitle>
        <EmptyDescription className="max-w-sm text-xs">{t("hint")}</EmptyDescription>
      </EmptyHeader>
      {onWidenRange && (
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={onWidenRange} data-testid="empty-widen">
            {t("widen")}
          </Button>
        </EmptyContent>
      )}
    </Empty>
  )
}

export interface ObservabilityLoadErrorProps {
  /** The failed read's error; its message is shown as secondary detail. */
  error: Error
  onRetry: () => void
  className?: string
}

export function ObservabilityLoadError({ error, onRetry, className }: ObservabilityLoadErrorProps) {
  const t = useTranslations("observability.loadError")
  return (
    <Empty
      className={
        className ?? "flex h-full flex-col items-center justify-center gap-4 p-8 text-center"
      }
      role="alert"
      data-testid="observability-load-error"
    >
      <EmptyMedia variant="icon">
        <AlertTriangleIcon className="size-8 text-destructive/70" aria-hidden="true" />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle className="text-sm">{t("title")}</EmptyTitle>
        <EmptyDescription className="max-w-sm text-xs">{t("hint")}</EmptyDescription>
        {error.message && (
          <p className="max-w-sm font-mono text-[11px] break-words text-muted-foreground">
            {error.message}
          </p>
        )}
      </EmptyHeader>
      <EmptyContent>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={onRetry}
          data-testid="observability-retry"
        >
          <RotateCcwIcon className="size-3.5" aria-hidden />
          {t("retry")}
        </Button>
      </EmptyContent>
    </Empty>
  )
}
