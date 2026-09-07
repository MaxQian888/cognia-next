"use client"

/**
 * Storage usage breakdown for `/me/storage`. Reads `navigator.storage
 * .estimate()` plus the local backup history via `getStorageUsage()`
 * (`lib/storage/usage.ts`). Falls back to "unsupported" copy on jsdom +
 * older WebViews where `navigator.storage` is missing.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { RefreshCwIcon } from "lucide-react"

import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { MeSection } from "@/components/mobile/me/me-section"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { formatBytes, getStorageUsage, type StorageUsage } from "@/lib/storage/usage"
import {
  isStoragePersisted,
  requestPersistentStorage,
  type PersistenceStatus,
} from "@/lib/storage/persistence-request"
import { formatRelative } from "@cognia/time"

export interface StorageUsageCardProps {
  /** Override the fetcher (tests). */
  fetcher?: () => Promise<StorageUsage>
  /** Override the persisted-state probe (tests). */
  persistedChecker?: () => Promise<boolean>
  /** Override the persistence request (tests). */
  requester?: () => Promise<PersistenceStatus>
}

export function StorageUsageCard({
  fetcher,
  persistedChecker,
  requester,
}: StorageUsageCardProps = {}) {
  const t = useTranslations("mobile.me.storage")
  const [usage, setUsage] = useState<StorageUsage | null>(null)
  const [persisted, setPersisted] = useState<boolean | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [requesting, setRequesting] = useState(false)

  const requestPersistence = async () => {
    setRequesting(true)
    try {
      const status = await (requester ?? requestPersistentStorage)()
      if (status === "persisted") {
        setPersisted(true)
        toast.success(t("requestPersistenceGranted"))
      } else if (status === "denied") {
        toast.error(t("requestPersistenceDenied"))
      } else {
        toast.error(t("requestPersistenceUnsupported"))
      }
    } finally {
      setRequesting(false)
    }
  }

  const load = async () => {
    setRefreshing(true)
    try {
      const [out, isPersisted] = await Promise.all([
        (fetcher ?? getStorageUsage)(),
        (persistedChecker ?? isStoragePersisted)(),
      ])
      setUsage(out)
      setPersisted(isPersisted)
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [out, isPersisted] = await Promise.all([
        (fetcher ?? getStorageUsage)(),
        (persistedChecker ?? isStoragePersisted)(),
      ])
      if (!cancelled) {
        setUsage(out)
        setPersisted(isPersisted)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [fetcher, persistedChecker])

  if (!usage) {
    return (
      <div className="px-1 py-2" aria-busy="true">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="mt-2 h-2 w-full" />
        <Skeleton className="mt-3 h-3 w-1/2" />
      </div>
    )
  }

  const supported = usage.totalBytes !== null && usage.quotaBytes !== null
  const pct =
    supported && usage.quotaBytes
      ? Math.min(100, Math.round(((usage.totalBytes ?? 0) / usage.quotaBytes) * 100))
      : 0

  return (
    <div className="flex flex-col gap-5" data-testid="storage-usage-card">
      <MeSection
        title={t("totalTitle")}
        description={
          supported
            ? t("totalDescription", {
                used: formatBytes(usage.totalBytes),
                quota: formatBytes(usage.quotaBytes),
              })
            : t("totalUnsupported")
        }
        action={
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8 text-muted-foreground"
            disabled={refreshing}
            aria-label={t("refresh")}
            onClick={() => void load()}
            data-testid="storage-refresh"
          >
            <RefreshCwIcon
              aria-hidden="true"
              className={"size-4" + (refreshing ? " animate-spin" : "")}
            />
          </Button>
        }
      >
        <div className="flex flex-col gap-3 px-3 py-3">
          {supported ? <Progress value={pct} aria-label={t("totalTitle")} /> : null}
          {persisted !== null ? (
            <p className="text-[11px] text-muted-foreground" data-testid="storage-persisted">
              <span className="font-medium">{t("persistedLabel")}:</span>{" "}
              {persisted ? t("persistedYes") : t("persistedNo")}
            </p>
          ) : null}
          {/* Refresh moved to the section heading. Two full-width buttons
              stacked under the progress bar cost about 90px of the first
              screen at 375px, and the page carried two of them reading
              "Refresh" because each block owned its own reload. */}
          {persisted === false ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="self-start"
              disabled={requesting}
              onClick={() => void requestPersistence()}
              data-testid="storage-request-persistence"
            >
              {t("requestPersistence")}
            </Button>
          ) : null}
        </div>
      </MeSection>
      <MeSection
        title={t("backupsTitle")}
        description={t("backupsDescription", {
          total: formatBytes(usage.backupBytes ?? 0),
          count: usage.backups.length,
        })}
      >
        {usage.backups.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">{t("backupsEmpty")}</p>
        ) : (
          usage.backups.slice(0, 8).map((row) => (
            <div
              key={row.id}
              className="flex items-center justify-between gap-2 px-3 py-2.5 text-xs not-last:border-b"
              data-testid={`storage-backup-row-${row.id}`}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{row.filename ?? t("unnamedFile")}</p>
                <p className="text-[11px] text-muted-foreground">
                  {formatRelative(row.completedAt)} · {row.encryption}
                </p>
              </div>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {formatBytes(row.sizeBytes ?? null)}
              </span>
            </div>
          ))
        )}
      </MeSection>
    </div>
  )
}
