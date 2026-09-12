"use client"

/**
 * Per-category rows for `/me/storage`: what is using space, how much of the
 * used total that is, and a one-tap clear per category.
 *
 * Rows use the `Item` primitives with the category's icon tile from
 * `storage-category-visuals.ts`, so a segment in the hero bar and a row
 * here share a colour. Data comes in through props from
 * `useStorageOverview`; the confirm dialog stays here because it is the
 * only place a destructive per-category action is taken. All health copy
 * is derived from `health.status` — the lib's `health.issues[].message`
 * strings are hard-coded English and must NOT be rendered.
 */

import { Fragment, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Trash2Icon } from "lucide-react"
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
import { Button } from "@/components/ui/button"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item"
import { Skeleton } from "@/components/ui/skeleton"
import { MeSection } from "@/components/mobile/me/me-section"
import { categoryColor, categoryIcon } from "@/components/data/storage/storage-category-visuals"
import type { StorageCategory, StorageHealth, StorageStats } from "@/lib/storage"
import { cn } from "@/lib/utils"

export interface StorageBreakdownCardProps {
  stats: StorageStats | null
  health: StorageHealth | null
  isLoading: boolean
  /** Disables the clear buttons (a cleanup or refresh is running). */
  disabled?: boolean
  formatBytes: (bytes: number) => string
  /** Clears one category and resolves with the number of rows removed. */
  onClearCategory: (category: StorageCategory) => Promise<number>
}

export function StorageBreakdownCard({
  stats,
  health,
  isLoading,
  disabled = false,
  formatBytes,
  onClearCategory,
}: StorageBreakdownCardProps) {
  const t = useTranslations("mobile.me.storage")
  const tCat = useTranslations("settings.data.breakdown.categories")
  const [pending, setPending] = useState<StorageCategory | null>(null)

  const rows = useMemo(
    () =>
      (stats?.byCategory ?? [])
        .filter((c) => c.totalSize > 0)
        .slice()
        .sort((a, b) => b.totalSize - a.totalSize),
    [stats]
  )
  const used = rows.reduce((sum, c) => sum + c.totalSize, 0)

  const confirmClear = async () => {
    if (!pending) return
    const category = pending
    setPending(null)
    try {
      const cleared = await onClearCategory(category)
      toast.success(t("clearedToast", { count: cleared }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  if (isLoading && !stats) {
    return (
      <div className="px-1 py-2" data-testid="storage-breakdown-card" aria-busy="true">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="mt-3 h-10 w-full" />
        <Skeleton className="mt-2 h-10 w-full" />
      </div>
    )
  }

  const status = health?.status ?? "healthy"

  return (
    <MeSection
      testid="storage-breakdown-card"
      title={t("breakdownTitle")}
      description={
        rows.length > 0
          ? t("breakdownSummary", { count: rows.length, total: formatBytes(used) })
          : health
            ? t(`health.${status}Hint`, { percent: Math.round(health.usagePercent) })
            : t("breakdownDescription")
      }
    >
      {rows.length === 0 ? (
        <p className="px-4 py-4 text-xs text-muted-foreground">{t("breakdownEmpty")}</p>
      ) : (
        rows.map((cat, idx) => {
          const Icon = categoryIcon(cat.category)
          const share = used > 0 ? Math.round((cat.totalSize / used) * 100) : 0
          const label = tCat(cat.category)
          return (
            <Fragment key={cat.category}>
              {idx > 0 ? <ItemSeparator /> : null}
              <Item
                size="sm"
                className="flex-nowrap px-3 py-2"
                data-testid={`storage-category-${cat.category}`}
              >
                <ItemMedia
                  variant="icon"
                  className={cn("border-transparent text-white", categoryColor(cat.category))}
                >
                  <Icon aria-hidden="true" />
                </ItemMedia>
                <ItemContent className="min-w-0">
                  <ItemTitle className="text-sm">{label}</ItemTitle>
                  <ItemDescription className="text-xs tabular-nums">
                    {t("breakdownItems", { count: cat.itemCount })} · {formatBytes(cat.totalSize)}
                  </ItemDescription>
                </ItemContent>
                <ItemActions className="shrink-0 gap-1">
                  <span
                    className="w-9 text-right text-xs font-medium tabular-nums text-muted-foreground"
                    data-testid={`storage-share-${cat.category}`}
                  >
                    {t("breakdownShare", { percent: share })}
                  </span>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="touch-target size-8 shrink-0 text-muted-foreground"
                    disabled={disabled}
                    aria-label={t("clearCategory", { category: label })}
                    data-testid={`storage-clear-${cat.category}`}
                    onClick={() => setPending(cat.category)}
                  >
                    <Trash2Icon className="size-4" aria-hidden="true" />
                  </Button>
                </ItemActions>
              </Item>
            </Fragment>
          )
        })
      )}

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
