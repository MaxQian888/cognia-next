"use client"

// Soft "back up your data" nudge for the mobile "我的" page. Mirrors the
// desktop ReminderBanner (components/data/import/reminder-banner.tsx) but
// mobile-styled and self-hiding, with a CTA into /me/backup. All visibility +
// dismissal logic is reused from useBackupReminder — no re-wiring here.

import Link from "next/link"
import { useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { CalendarClockIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { useBackupReminder } from "@/hooks/data/use-backup-reminder"
import { useLatestSuccessfulBackup } from "@/hooks/data/use-backup-history"

const DAY_MS = 24 * 60 * 60 * 1000
const noopSubscribe = () => () => {}

export function BackupReminderBanner() {
  const t = useTranslations("mobile.me.backupReminder")
  const { visible, dismiss } = useBackupReminder()
  const latest = useLatestSuccessfulBackup()
  // React-sanctioned wall-clock read (no effect-driven setState).
  const nowMs = useSyncExternalStore(
    noopSubscribe,
    () => Date.now(),
    () => 0
  )

  if (!visible) return null

  const days = latest && nowMs > 0 ? Math.floor((nowMs - latest.completedAt) / DAY_MS) : null

  return (
    <Card
      className="flex items-start gap-2 border-amber-500/40 bg-amber-50/50 p-3 text-sm dark:bg-amber-500/10"
      data-testid="backup-reminder-banner"
    >
      <CalendarClockIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber-600" />
      <div className="flex-1">
        <p className="font-medium">{t("title")}</p>
        <p className="text-xs text-muted-foreground">
          {days !== null ? t("bodyKnownLast", { days }) : t("bodyNeverBackedUp")}
        </p>
        <Button asChild variant="link" size="sm" className="mt-1 h-auto px-0 text-xs">
          <Link href="/me/backup" data-testid="backup-reminder-cta">
            {t("cta")}
          </Link>
        </Button>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 text-xs"
        onClick={dismiss}
        data-testid="backup-reminder-dismiss"
      >
        {t("dismiss")}
      </Button>
    </Card>
  )
}
