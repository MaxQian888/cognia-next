"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { motion, useReducedMotion } from "motion/react"

import { Card, CardContent } from "@/components/ui/card"
import { listSessions } from "@/lib/db/sessions"
import { getDb } from "@/lib/db/schema"
import { getLatestSuccessful } from "@/lib/db/backup-history"
import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
import { cn } from "@/lib/utils"

export interface TodayStatsCardProps {
  /** Override loaders — primarily for tests. */
  loaders?: {
    sessionCount?: () => Promise<number>
    pendingDrafts?: () => Promise<number>
    lastBackupMs?: () => Promise<number | null>
  }
  className?: string
}

interface Stats {
  sessions: number
  drafts: number
  lastBackupMs: number | null
}

const initial: Stats = { sessions: 0, drafts: 0, lastBackupMs: null }

function relative(ms: number, now: number = Date.now()): string {
  const diff = now - ms
  if (diff < 60_000) return "now"
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`
  return `${Math.round(diff / 86_400_000)}d`
}

const defaultLoaders = {
  sessionCount: async () => (await listSessions()).length,
  pendingDrafts: async () => getDb().twinDrafts.where("status").equals("pending").count(),
  lastBackupMs: async () => {
    const row = await getLatestSuccessful()
    return row ? row.completedAt : null
  },
}

export function TodayStatsCard({ loaders, className }: TodayStatsCardProps) {
  const t = useTranslations("mobile.me.todayStats")
  const [stats, setStats] = useState<Stats>(initial)
  const reduce = useReducedMotion()

  useEffect(() => {
    let cancelled = false
    const sc = loaders?.sessionCount ?? defaultLoaders.sessionCount
    const pd = loaders?.pendingDrafts ?? defaultLoaders.pendingDrafts
    const lb = loaders?.lastBackupMs ?? defaultLoaders.lastBackupMs
    void Promise.all([sc().catch(() => 0), pd().catch(() => 0), lb().catch(() => null)]).then(
      ([sessions, drafts, lastBackupMs]) => {
        if (cancelled) return
        setStats({ sessions, drafts, lastBackupMs })
      }
    )
    return () => {
      cancelled = true
    }
  }, [loaders])

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
      value: stats.lastBackupMs ? relative(stats.lastBackupMs) : t("backupNever"),
      href: "/settings?section=data",
      testId: "stat-tile-backup",
    },
  ]

  return (
    <motion.div
      className={cn("grid grid-cols-3 gap-2", className)}
      data-testid="today-stats-card"
      initial={reduce ? false : "initial"}
      animate="animate"
      variants={STAGGER_CONTAINER}
    >
      {tiles.map((tile) => (
        <motion.div key={tile.testId} variants={STAGGER_CHILD}>
          <Link href={tile.href} data-testid={tile.testId} className="block">
            <Card className="h-full active:bg-muted/50">
              <CardContent className="flex h-full flex-col items-start justify-center gap-1 px-3 py-3">
                <span className="text-base font-semibold leading-tight tracking-tight">
                  {tile.value}
                </span>
                <span className="text-[11px] text-muted-foreground">{tile.label}</span>
              </CardContent>
            </Card>
          </Link>
        </motion.div>
      ))}
    </motion.div>
  )
}
