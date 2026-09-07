"use client"

/**
 * Per-category storage breakdown + health for the mobile `/me/storage` page.
 * Desktop surfaces this through `components/data/storage/storage-breakdown.tsx`
 * (a Dialog-driven panel); mobile gets a native card so users can see *what*
 * is using space and clear a single category without leaving the page.
 *
 * Reuses the existing data layer: `useStorageBreakdown` (stats + health from
 * `StorageManager`) and `useStorageCleanup` (`clearCategory`). All health copy
 * is derived locally from `health.status` / `usagePercent` — the lib's
 * `health.issues[].message` strings are hard-coded English and must NOT be
 * rendered. Category labels reuse `settings.data.breakdown.categories.*`.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { RefreshCwIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { MeSection } from "@/components/mobile/me/me-section"
import { Skeleton } from "@/components/ui/skeleton"
import { useStorageBreakdown } from "@/hooks/storage/use-storage-breakdown"
import { useStorageCleanup } from "@/hooks/storage/use-storage-cleanup"
import type { StorageCategory, StorageHealthStatus } from "@/lib/storage"
import { cn } from "@/lib/utils"

const STATUS_BADGE: Record<StorageHealthStatus, string> = {
  healthy: "border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  warning: "border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400",
  critical: "border-transparent bg-destructive/15 text-destructive",
}

export function StorageBreakdownCard() {
  const t = useTranslations("mobile.me.storage")
  const tCat = useTranslations("settings.data.breakdown.categories")
  const { stats, health, isLoading, refresh, formatBytes } = useStorageBreakdown()
  const { clearCategory, isRunning } = useStorageCleanup()
  const [pending, setPending] = useState<StorageCategory | null>(null)

  const confirmClear = async () => {
    if (!pending) return
    const category = pending
    setPending(null)
    try {
      const cleared = await clearCategory(category)
      await refresh()
      toast.success(t("clearedToast", { count: cleared }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  if (isLoading && !stats) {
    return (
      <div className="px-1 py-2" data-testid="storage-breakdown-card" aria-busy="true">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="mt-3 h-2 w-full" />
        <Skeleton className="mt-2 h-2 w-5/6" />
      </div>
    )
  }

  const used = stats?.total.used ?? 0
  const rows = (stats?.byCategory ?? []).filter((c) => c.totalSize > 0)
  const status = health?.status ?? "healthy"

  return (
    <MeSection
      testid="storage-breakdown-card"
      title={t("breakdownTitle")}
      description={
        health
          ? t(`health.${status}Hint`, { percent: Math.round(health.usagePercent) })
          : t("breakdownDescription")
      }
      action={
        <>
          {health ? (
            <Badge
              className={cn("text-[10px]", STATUS_BADGE[status])}
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
            disabled={isRunning}
            aria-label={t("refresh")}
            onClick={() => void refresh()}
            data-testid="storage-breakdown-refresh"
          >
            <RefreshCwIcon className="size-4" aria-hidden="true" />
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 px-3 py-3">
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("breakdownEmpty")}</p>
        ) : (
          rows.map((cat) => {
            const share = used > 0 ? Math.min(100, Math.round((cat.totalSize / used) * 100)) : 0
            return (
              <div
                key={cat.category}
                className="flex items-center gap-3"
                data-testid={`storage-category-${cat.category}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate font-medium">{tCat(cat.category)}</span>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                      {formatBytes(cat.totalSize)}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${share}%` }}
                      aria-hidden="true"
                    />
                  </div>
                </div>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="touch-target size-8 shrink-0 text-muted-foreground"
                  disabled={isRunning}
                  aria-label={t("clearCategory", { category: tCat(cat.category) })}
                  data-testid={`storage-clear-${cat.category}`}
                  onClick={() => setPending(cat.category)}
                >
                  <Trash2Icon className="size-4" aria-hidden="true" />
                </Button>
              </div>
            )
          })
        )}
      </div>

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("clearConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("clearConfirmBody", { category: pending ? tCat(pending) : "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("clearConfirmCancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void confirmClear()}
              data-testid="storage-clear-confirm"
            >
              {t("clearConfirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </MeSection>
  )
}
