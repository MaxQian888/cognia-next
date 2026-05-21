"use client"

/**
 * Storage usage breakdown for `/me/storage`. Reads `navigator.storage
 * .estimate()` plus the local backup history via `getStorageUsage()`
 * (`lib/storage/usage.ts`). Falls back to "unsupported" copy on jsdom +
 * older WebViews where `navigator.storage` is missing.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { HardDriveIcon, RefreshCwIcon, SaveIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { formatBytes, getStorageUsage, type StorageUsage } from "@/lib/storage/usage"
import { formatRelative } from "@/lib/time/relative"

export interface StorageUsageCardProps {
  /** Override the fetcher (tests). */
  fetcher?: () => Promise<StorageUsage>
}

export function StorageUsageCard({ fetcher }: StorageUsageCardProps = {}) {
  const t = useTranslations("mobile.me.storage")
  const [usage, setUsage] = useState<StorageUsage | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = async () => {
    setRefreshing(true)
    try {
      const out = await (fetcher ?? getStorageUsage)()
      setUsage(out)
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const out = await (fetcher ?? getStorageUsage)()
      if (!cancelled) setUsage(out)
    })()
    return () => {
      cancelled = true
    }
  }, [fetcher])

  if (!usage) {
    return (
      <Card>
        <CardContent className="px-4 py-3">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="mt-2 h-2 w-full" />
          <Skeleton className="mt-3 h-3 w-1/2" />
        </CardContent>
      </Card>
    )
  }

  const supported = usage.totalBytes !== null && usage.quotaBytes !== null
  const pct =
    supported && usage.quotaBytes
      ? Math.min(100, Math.round(((usage.totalBytes ?? 0) / usage.quotaBytes) * 100))
      : 0

  return (
    <div className="flex flex-col gap-3" data-testid="storage-usage-card">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <HardDriveIcon className="size-4" aria-hidden="true" />
            {t("totalTitle")}
          </CardTitle>
          <CardDescription className="text-xs">
            {supported
              ? t("totalDescription", {
                  used: formatBytes(usage.totalBytes),
                  quota: formatBytes(usage.quotaBytes),
                })
              : t("totalUnsupported")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-4 pb-3">
          {supported ? <Progress value={pct} aria-label={t("totalTitle")} /> : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={refreshing}
            onClick={() => void load()}
            data-testid="storage-refresh"
          >
            <RefreshCwIcon
              aria-hidden="true"
              className={"size-3.5 mr-1" + (refreshing ? " animate-spin" : "")}
            />
            {t("refresh")}
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <SaveIcon className="size-4" aria-hidden="true" />
            {t("backupsTitle")}
          </CardTitle>
          <CardDescription className="text-xs">
            {t("backupsDescription", {
              total: formatBytes(usage.backupBytes ?? 0),
              count: usage.backups.length,
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 px-4 pb-3">
          {usage.backups.slice(0, 8).map((row) => (
            <div
              key={row.id}
              className="flex items-center justify-between rounded-md border px-3 py-2 text-xs"
              data-testid={`storage-backup-row-${row.id}`}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{row.filename ?? t("unnamedFile")}</p>
                <p className="text-[11px] text-muted-foreground">
                  {formatRelative(row.completedAt)} · {row.encryption}
                </p>
              </div>
              <span className="ml-2 shrink-0 font-mono text-[11px] text-muted-foreground">
                {formatBytes(row.sizeBytes ?? null)}
              </span>
            </div>
          ))}
          {usage.backups.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("backupsEmpty")}</p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
