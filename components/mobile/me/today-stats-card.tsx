"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { motion, useReducedMotion } from "motion/react"
import { AlertTriangleIcon, ClockAlertIcon } from "lucide-react"

import { Card, CardContent } from "@/components/ui/card"
import { listSessions } from "@/lib/db/sessions"
import { getDb } from "@/lib/db/schema"
import { totalsByAllSessions } from "@/lib/db/session-usage"
import { getLatestSuccessful, listBackupHistory } from "@/lib/db/backup-history"
import { computeBackupHealth, type BackupHealthResult } from "@/lib/data/backup-health"
import { formatBytes, getStorageUsage } from "@/lib/storage/usage"
import { formatCostInCurrency, formatTokens } from "@/types/system/usage"
import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
import { useSettingsStore } from "@/stores/settings"
import { cn } from "@/lib/utils"

export interface TodayStatsCardProps {
  /** Override loaders — primarily for tests. */
  loaders?: {
    sessionCount?: () => Promise<number>
    pendingDrafts?: () => Promise<number>
    /** Back-compat seam: when set (and `backupHealth` is not), the last
     * successful backup ms — treated as a healthy "ok"/"never" tile. */
    lastBackupMs?: () => Promise<number | null>
    /** Full backup-health verdict (preferred over `lastBackupMs`). */
    backupHealth?: () => Promise<BackupHealthResult>
    storageBytes?: () => Promise<number | null>
    /** Cumulative token + estimated cost across all persisted sessions. */
    usageTotals?: () => Promise<{ tokens: number; costUsd: number }>
  }
  className?: string
}

interface Stats {
  sessions: number
  drafts: number
  lastBackupMs: number | null
  backupStatus: BackupHealthResult["status"]
  storageBytes: number | null
  usageTokens: number
  usageCost: number
}

const initial: Stats = {
  sessions: 0,
  drafts: 0,
  lastBackupMs: null,
  backupStatus: "never",
  storageBytes: null,
  usageTokens: 0,
  usageCost: 0,
}

const defaultLoaders = {
  sessionCount: async () => (await listSessions()).length,
  pendingDrafts: async () => getDb().twinDrafts.where("status").equals("pending").count(),
  backupHealth: async (): Promise<BackupHealthResult> => {
    const [history, latestSuccess] = await Promise.all([
      listBackupHistory({ limit: 1 }),
      getLatestSuccessful(),
    ])
    return computeBackupHealth({
      latestAttempt: history[0] ?? null,
      latestSuccess: latestSuccess ?? null,
      reminderDays: useSettingsStore.getState().settings?.backupReminderDays,
    })
  },
  storageBytes: async () => (await getStorageUsage()).totalBytes,
  usageTotals: async (): Promise<{ tokens: number; costUsd: number }> => {
    const map = await totalsByAllSessions()
    let tokens = 0
    let costUsd = 0
    for (const totals of map.values()) {
      tokens += totals.inputTokens + totals.outputTokens + totals.cacheReadTokens
      costUsd += totals.costUsd
    }
    return { tokens, costUsd }
  },
}

/** Resolve the backup tile's health, honouring the legacy `lastBackupMs` seam. */
function resolveBackupHealth(loaders?: TodayStatsCardProps["loaders"]): () => Promise<BackupHealthResult> {
  if (loaders?.backupHealth) return loaders.backupHealth
  if (loaders?.lastBackupMs) {
    return async () => {
      const ms = await loaders.lastBackupMs!()
      return { status: ms ? "ok" : "never", lastSuccessAt: ms }
    }
  }
  return defaultLoaders.backupHealth
}

export function TodayStatsCard({ loaders, className }: TodayStatsCardProps) {
  const t = useTranslations("mobile.me.todayStats")
  // Localized "3 minutes ago" via next-intl — the old hand-rolled "3m"/"2d"
  // helper rendered raw English abbreviations for zh-CN users.
  const format = useFormatter()
  const [stats, setStats] = useState<Stats>(initial)
  const reduce = useReducedMotion()

  useEffect(() => {
    let cancelled = false
    const sc = loaders?.sessionCount ?? defaultLoaders.sessionCount
    const pd = loaders?.pendingDrafts ?? defaultLoaders.pendingDrafts
    const bh = resolveBackupHealth(loaders)
    const sb = loaders?.storageBytes ?? defaultLoaders.storageBytes
    const ut = loaders?.usageTotals ?? defaultLoaders.usageTotals
    void Promise.all([
      sc().catch(() => 0),
      pd().catch(() => 0),
      bh().catch((): BackupHealthResult => ({ status: "never", lastSuccessAt: null })),
      sb().catch(() => null),
      ut().catch(() => ({ tokens: 0, costUsd: 0 })),
    ]).then(([sessions, drafts, backup, storageBytes, usage]) => {
      if (cancelled) return
      setStats({
        sessions,
        drafts,
        lastBackupMs: backup.lastSuccessAt,
        backupStatus: backup.status,
        storageBytes,
        usageTokens: usage.tokens,
        usageCost: usage.costUsd,
      })
    })
    return () => {
      cancelled = true
    }
  }, [loaders])

  // Lightweight inline health accent for the backup tile: amber when stale,
  // destructive when the most recent attempt failed (the previously-hidden
  // signal). "ok"/"never" stay neutral.
  const backupAccent =
    stats.backupStatus === "failed"
      ? "text-destructive"
      : stats.backupStatus === "stale"
        ? "text-amber-600"
        : undefined
  const BackupIcon =
    stats.backupStatus === "failed"
      ? AlertTriangleIcon
      : stats.backupStatus === "stale"
        ? ClockAlertIcon
        : null
  const backupStatusLabel =
    stats.backupStatus === "failed"
      ? t("backupFailed")
      : stats.backupStatus === "stale"
        ? t("backupStale")
        : undefined

  const tiles = [
    {
      label: t("sessions"),
      value: String(stats.sessions),
      href: "/",
      testId: "stat-tile-sessions",
    },
    {
      label: t("drafts"),
      value: String(stats.drafts),
      href: "/discover?tab=twinDrafts",
      testId: "stat-tile-drafts",
    },
    {
      label: t("backup"),
      value: stats.lastBackupMs
        ? format.relativeTime(new Date(stats.lastBackupMs))
        : t("backupNever"),
      href: "/me/backup",
      testId: "stat-tile-backup",
      status: stats.backupStatus,
      accent: backupAccent,
      icon: BackupIcon,
      statusLabel: backupStatusLabel,
    },
    {
      label: t("storage"),
      value: stats.storageBytes !== null ? formatBytes(stats.storageBytes) : "—",
      href: "/me/storage",
      testId: "stat-tile-storage",
    },
    // Usage tiles only appear once there is recorded consumption, so a fresh
    // install isn't cluttered with two zero counters.
    ...(stats.usageTokens > 0
      ? [
          {
            label: t("usageTokens"),
            value: formatTokens(stats.usageTokens),
            testId: "stat-tile-usage-tokens",
          },
          {
            label: t("usageCost"),
            value: formatCostInCurrency(stats.usageCost, "USD"),
            testId: "stat-tile-usage-cost",
          },
        ]
      : []),
  ] satisfies Array<{
    label: string
    value: string
    href?: string
    testId: string
    status?: Stats["backupStatus"]
    accent?: string
    icon?: typeof AlertTriangleIcon | null
    statusLabel?: string
  }>

  return (
    <motion.div
      className={cn("grid grid-cols-2 gap-2 sm:grid-cols-4", className)}
      data-testid="today-stats-card"
      initial={reduce ? false : "initial"}
      animate="animate"
      variants={STAGGER_CONTAINER}
    >
      {tiles.map((tile) => {
        const Icon = tile.icon
        const card = (
          <Card className="h-full active:bg-muted/50">
            <CardContent className="flex h-full flex-col items-start justify-center gap-1 px-3 py-3">
              <span
                className={cn(
                  "flex items-center gap-1 text-base font-semibold leading-tight tracking-tight",
                  tile.accent
                )}
              >
                {Icon ? <Icon aria-hidden="true" className="size-3.5" /> : null}
                {tile.statusLabel ? <span className="sr-only">{tile.statusLabel}: </span> : null}
                {tile.value}
              </span>
              <span className="text-[11px] text-muted-foreground">{tile.label}</span>
            </CardContent>
          </Card>
        )
        return (
          <motion.div key={tile.testId} variants={STAGGER_CHILD}>
            {tile.href ? (
              <Link
                href={tile.href}
                data-testid={tile.testId}
                data-status={tile.status}
                title={tile.statusLabel}
                className="block"
              >
                {card}
              </Link>
            ) : (
              <div data-testid={tile.testId} className="block">
                {card}
              </div>
            )}
          </motion.div>
        )
      })}
    </motion.div>
  )
}
