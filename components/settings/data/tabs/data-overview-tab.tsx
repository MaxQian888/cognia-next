"use client"

// Storage status + backup history. Renders top-down:
//   1. Reminder banner (driven by useBackupReminder)
//   2. StorageUsageDisplay — live counts + IDB quota bar
//   3. StorageBreakdown — visual stacked bar with per-category clear buttons
//   4. 2-col grid: StorageHealthDisplay + LocalPersistenceVisibilityPanel
//   5. Last successful backup card
//   6. Backup history table

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { createLogger } from "@/lib/logger"
import { Card } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  ActivityIcon,
  CheckCircle2Icon,
  ClockIcon,
  DatabaseIcon,
  Loader2Icon,
  RefreshCwIcon,
  XCircleIcon,
} from "lucide-react"
import { toast } from "sonner"
import {
  useBackupHistory,
  useLatestSuccessfulBackup,
  clearBackupHistory,
  deleteBackupHistory,
  type BackupHistoryRow,
} from "@/hooks/data/use-backup-history"
import { StorageUsageDisplay } from "@/components/data/shared/storage-usage-display"
import { ReminderBanner } from "@/components/data/import/reminder-banner"
import { StorageBreakdown } from "@/components/data/storage/storage-breakdown"
import { StorageHealthDisplay } from "@/components/data/storage/storage-health-display"
import { LocalPersistenceVisibilityPanel } from "@/components/data/storage/local-persistence-visibility-panel"
import { useStorageBreakdown, useStorageCleanup } from "@/hooks/storage"
import type { StorageCategory } from "@/lib/storage"

const log = createLogger("settings.data.overview")

export function DataOverviewTab() {
  const t = useTranslations("settings.data")
  const latest = useLatestSuccessfulBackup()
  const rows = useBackupHistory({ limit: 20 })

  const { stats, health, isLoading, refresh, formatBytes } = useStorageBreakdown({
    refreshInterval: 30_000,
  })
  const { clearCategory, isRunning: isClearing } = useStorageCleanup()

  const handleClearCategory = useCallback(
    async (category: StorageCategory) => {
      try {
        const deleted = await clearCategory(category)
        log.info("clear_category", { category, deleted })
        toast.success(t("breakdown.cleared", { count: deleted }))
        await refresh()
      } catch (err) {
        log.error("clear_category_failed", err, { category })
        toast.error(err instanceof Error ? err.message : String(err))
      }
    },
    [clearCategory, refresh, t]
  )

  return (
    <div className="space-y-6">
      <ReminderBanner />
      <StorageUsageDisplay />

      <Card className="space-y-3 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <DatabaseIcon className="size-4" />
            <Label className="text-sm">{t("breakdown.title")}</Label>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={() => void refresh()}
            disabled={isLoading}
            aria-label={t("breakdown.refresh")}
          >
            {isLoading ? (
              <Loader2Icon className="size-3 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3" />
            )}
          </Button>
        </div>
        {stats && (
          <StorageBreakdown
            categories={stats.byCategory}
            totalSize={stats.indexedDB.used}
            formatBytes={formatBytes}
            onClearCategory={handleClearCategory}
            isClearing={isClearing}
          />
        )}
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="space-y-2 p-4">
          <div className="flex items-center gap-2">
            <ActivityIcon className="size-4 text-muted-foreground" />
            <Label className="text-sm">{t("health.title")}</Label>
          </div>
          <StorageHealthDisplay health={health} formatBytes={formatBytes} />
        </Card>

        <Card className="p-4">
          <LocalPersistenceVisibilityPanel />
        </Card>
      </div>

      <Card className="space-y-2 p-4">
        <div className="flex items-center gap-2">
          <ClockIcon className="size-4" />
          <Label className="text-sm">{t("overview.lastBackup")}</Label>
        </div>
        {latest ? (
          <div className="space-y-0.5 text-xs text-muted-foreground">
            <p>{t("overview.lastBackupAt", { when: formatTimestamp(latest.completedAt) })}</p>
            {latest.filename && <p className="font-mono text-[11px]">{latest.filename}</p>}
            <p className="text-[11px]">
              {t("overview.daysAgo", { days: daysAgo(latest.completedAt) })}
              {" — "}
              {t(`overview.encryption.${encryptionKey(latest.encryption)}` as never)}
            </p>
          </div>
        ) : (
          <p className="text-xs italic text-muted-foreground">{t("overview.neverBackedUp")}</p>
        )}
      </Card>

      <Card className="space-y-2 p-4">
        <div className="flex items-center justify-between">
          <Label className="text-sm">{t("overview.historyTitle")}</Label>
          {rows.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void clearBackupHistory()}
              className="h-7 text-xs"
            >
              {t("overview.clearHistory")}
            </Button>
          )}
        </div>
        {rows.length === 0 ? (
          <p className="text-xs italic text-muted-foreground">{t("overview.historyEmpty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-[11px]">{t("overview.col.when")}</TableHead>
                  <TableHead className="text-[11px]">{t("overview.col.type")}</TableHead>
                  <TableHead className="text-[11px]">{t("overview.col.encryption")}</TableHead>
                  <TableHead className="text-[11px]">{t("overview.col.size")}</TableHead>
                  <TableHead className="text-[11px]">{t("overview.col.status")}</TableHead>
                  <TableHead className="text-[11px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <HistoryRow key={row.id} row={row} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  )
}

function HistoryRow({ row }: { row: BackupHistoryRow }) {
  const t = useTranslations("settings.data")
  return (
    <TableRow>
      <TableCell className="text-xs">{formatTimestamp(row.completedAt)}</TableCell>
      <TableCell className="text-xs capitalize">{row.type}</TableCell>
      <TableCell className="text-xs">
        {t(`overview.encryption.${encryptionKey(row.encryption)}` as never)}
      </TableCell>
      <TableCell className="text-xs">{formatBytes(row.sizeBytes)}</TableCell>
      <TableCell className="max-w-[8rem] sm:max-w-[12rem]">
        {row.success ? (
          <CheckCircle2Icon className="size-4 text-green-500" aria-label={t("overview.success")} />
        ) : (
          <span className="flex min-w-0 items-center gap-1 text-xs text-destructive">
            <XCircleIcon className="size-4 shrink-0" />
            <span className="min-w-0 truncate" title={row.errorMessage ?? ""}>
              {row.errorMessage ?? t("overview.failed")}
            </span>
          </span>
        )}
      </TableCell>
      <TableCell className="w-12">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-[11px]"
          onClick={() => void deleteBackupHistory(row.id)}
        >
          ×
        </Button>
      </TableCell>
    </TableRow>
  )
}

function formatTimestamp(ms: number): string {
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return String(ms)
  }
}

function daysAgo(ms: number): number {
  const diff = Date.now() - ms
  return Math.max(0, Math.floor(diff / (24 * 60 * 60 * 1000)))
}

function formatBytes(n?: number): string {
  if (!n || n <= 0) return "—"
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function encryptionKey(value: BackupHistoryRow["encryption"]): "none" | "autoKey" | "passphrase" {
  if (value === "auto-key") return "autoKey"
  return value === "passphrase" ? "passphrase" : "none"
}
