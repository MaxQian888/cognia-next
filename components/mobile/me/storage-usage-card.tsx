"use client"

/**
 * Hero block for `/me/storage`: how full the origin is, what fills it, and
 * whether the browser will protect it.
 *
 * One bar carries both facts. Its track is the quota, its filled part is
 * `navigator.storage.estimate()`, and the filled part is split into
 * per-category segments coloured by the same table the desktop breakdown
 * uses (`storage-category-visuals.ts`). The persistence state sits under
 * the bar as a chip with its request button inline, instead of a sentence
 * plus a stacked button.
 *
 * Data comes in through props from `useStorageOverview`, so the page owns
 * one refresh and this card never fetches on its own.
 */

import { useTranslations } from "next-intl"
import { RefreshCwIcon, ShieldAlertIcon, ShieldCheckIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { MeSection } from "@/components/mobile/me/me-section"
import {
  OTHER_SEGMENT_COLOR,
  categoryColor,
} from "@/components/data/storage/storage-category-visuals"
import type { StorageCategory, StorageHealth, StorageHealthStatus, StorageStats } from "@/lib/storage"
import type { PersistenceStatus } from "@/lib/storage/persistence-request"
import {
  REST_SEGMENT,
  computeUsageSegments,
  formatBytes,
  type StorageUsage,
} from "@/lib/storage/usage"
import { cn } from "@/lib/utils"

export const STORAGE_HEALTH_BADGE: Record<StorageHealthStatus, string> = {
  healthy: "border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  warning: "border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400",
  critical: "border-transparent bg-destructive/15 text-destructive",
}

export interface StorageUsageCardProps {
  usage: StorageUsage | null
  stats: StorageStats | null
  health: StorageHealth | null
  persisted: boolean | null
  /** Skeleton while the very first read is in flight. */
  isLoading: boolean
  /** Spins the refresh glyph; previous data stays visible. */
  refreshing: boolean
  /** Disables every control (a cleanup or request is running). */
  disabled?: boolean
  onRefresh: () => void | Promise<void>
  onRequestPersistence: () => Promise<PersistenceStatus>
}

export function StorageUsageCard({
  usage,
  stats,
  health,
  persisted,
  isLoading,
  refreshing,
  disabled = false,
  onRefresh,
  onRequestPersistence,
}: StorageUsageCardProps) {
  const t = useTranslations("mobile.me.storage")
  const tCat = useTranslations("settings.data.breakdown.categories")

  const requestPersistence = async () => {
    const status = await onRequestPersistence()
    if (status === "persisted") toast.success(t("requestPersistenceGranted"))
    else if (status === "denied") toast.error(t("requestPersistenceDenied"))
    else toast.error(t("requestPersistenceUnsupported"))
  }

  if (isLoading || !usage) {
    return (
      <div className="px-1 py-2" aria-busy="true" data-testid="storage-usage-card">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="mt-3 h-8 w-1/2" />
        <Skeleton className="mt-3 h-3 w-full" />
        <Skeleton className="mt-3 h-3 w-2/3" />
      </div>
    )
  }

  const categories = stats?.byCategory ?? []
  const { fillPercent, quotaKnown, segments } = computeUsageSegments({
    totalBytes: usage.totalBytes,
    quotaBytes: usage.quotaBytes,
    categories,
  })
  // Headline: the origin estimate when the shell exposes it, else the
  // Dexie walk (which is what the bar is drawn from in that case).
  const usedBytes = quotaKnown ? usage.totalBytes : (stats?.total.used ?? usage.totalBytes)
  const percent = Math.round(fillPercent)
  const status = health?.status ?? "healthy"
  const categoryLabel = (category: string) =>
    category === REST_SEGMENT ? t("legendRest") : tCat(category as StorageCategory)

  return (
    <MeSection
      title={t("totalTitle")}
      testid="storage-usage-card"
      action={
        <>
          {health ? (
            <Badge
              className={cn("text-[10px]", STORAGE_HEALTH_BADGE[status])}
              data-testid="storage-health-badge"
            >
              {t(`health.${status}`)}
            </Badge>
          ) : null}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8 text-muted-foreground"
            disabled={disabled || refreshing}
            aria-label={t("refresh")}
            onClick={() => void onRefresh()}
            data-testid="storage-refresh"
          >
            <RefreshCwIcon
              aria-hidden="true"
              className={cn("size-4", refreshing && "animate-spin")}
            />
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 px-4 py-4">
        {/* Headline: the number first, its context under it. */}
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
          <div className="flex min-w-0 flex-col">
            <p
              className="text-2xl font-semibold leading-none tabular-nums tracking-tight"
              data-testid="storage-used"
            >
              {formatBytes(usedBytes)}
            </p>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {quotaKnown ? t("heroUsedOf", { quota: formatBytes(usage.quotaBytes) }) : t("totalUnsupported")}
            </p>
          </div>
          {quotaKnown ? (
            <p className="text-xs font-medium tabular-nums text-muted-foreground" data-testid="storage-percent">
              {t("heroPercent", { percent })}
            </p>
          ) : null}
        </div>

        {/* One bar: quota track, estimate fill, category segments. */}
        <div
          className="flex h-2.5 w-full overflow-hidden rounded-pill bg-muted"
          role={quotaKnown ? "progressbar" : undefined}
          aria-label={t("totalTitle")}
          aria-valuemin={quotaKnown ? 0 : undefined}
          aria-valuemax={quotaKnown ? 100 : undefined}
          aria-valuenow={quotaKnown ? percent : undefined}
          data-testid="storage-usage-bar"
        >
          {segments.length > 0 ? (
            segments.map((segment) => (
              <div
                key={segment.category}
                className={cn(
                  "h-full transition-[width] duration-300",
                  segment.category === REST_SEGMENT
                    ? OTHER_SEGMENT_COLOR
                    : categoryColor(segment.category as StorageCategory)
                )}
                style={{ width: `${segment.widthPercent}%` }}
                data-testid={`storage-usage-segment-${segment.category}`}
                aria-hidden="true"
              />
            ))
          ) : quotaKnown && fillPercent > 0 ? (
            // Estimate without a category walk (caches only): plain fill.
            <div
              className="h-full bg-primary transition-[width] duration-300"
              style={{ width: `${fillPercent}%` }}
              aria-hidden="true"
            />
          ) : null}
        </div>

        {segments.length > 0 ? (
          <ul className="flex flex-wrap gap-x-3 gap-y-1.5 text-[11px]" data-testid="storage-usage-legend">
            {segments.map((segment) => (
              <li key={segment.category} className="flex min-w-0 items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    segment.category === REST_SEGMENT
                      ? OTHER_SEGMENT_COLOR
                      : categoryColor(segment.category as StorageCategory)
                  )}
                />
                <span className="truncate">{categoryLabel(segment.category)}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {Math.round(segment.sharePercent)}%
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            {quotaKnown ? t("heroEmpty") : t("heroUnknownQuota")}
          </p>
        )}

        {persisted !== null ? (
          <div
            className="flex items-center gap-2 border-t pt-3 text-xs"
            data-testid="storage-persisted"
            data-persisted={persisted ? "true" : "false"}
          >
            {persisted ? (
              <ShieldCheckIcon className="size-4 shrink-0 text-emerald-500" aria-hidden="true" />
            ) : (
              <ShieldAlertIcon className="size-4 shrink-0 text-amber-500" aria-hidden="true" />
            )}
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {persisted ? t("persistedShort") : t("notPersistedShort")}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {persisted ? t("persistedHint") : t("notPersistedHint")}
              </p>
            </div>
            {persisted === false ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="shrink-0"
                disabled={disabled}
                aria-label={t("requestPersistence")}
                onClick={() => void requestPersistence()}
                data-testid="storage-request-persistence"
              >
                {t("requestPersistenceShort")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </MeSection>
  )
}
