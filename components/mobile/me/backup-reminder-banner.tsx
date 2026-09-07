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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
    // An Alert, not a bordered box. This is an icon, a title, a reason and two
    // actions tinted amber, which is the alert shape exactly, and the primitive
    // brings the announcement semantics a bare frame never had. `status` rather
    // than the default assertive role, because a backup nudge should not
    // interrupt whatever a screen reader is already saying.
    <Alert
      role="status"
      className="border-amber-500/40 bg-amber-50/50 dark:bg-amber-500/10"
      data-testid="backup-reminder-banner"
    >
      <CalendarClockIcon aria-hidden="true" className="text-amber-600" />
      <AlertTitle>{t("title")}</AlertTitle>
      <AlertDescription>
        <p className="text-xs">
          {days !== null ? t("bodyKnownLast", { days }) : t("bodyNeverBackedUp")}
        </p>
        {/* Both actions on one row under the text. Dismiss used to sit in the
            far right of the banner, where it took width from the sentence
            explaining why the banner was there. */}
        <div className="flex flex-wrap items-center gap-1">
          <Button asChild variant="link" size="sm" className="h-auto px-0 text-xs">
            <Link href="/me/backup" data-testid="backup-reminder-cta">
              {t("cta")}
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={dismiss}
            data-testid="backup-reminder-dismiss"
          >
            {t("dismiss")}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}
