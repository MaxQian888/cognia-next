"use client"

// Soft "back up your data" reminder banner. Driven by the user's
// `backupReminderDays` setting and the latest successful backup row.

import { useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { CalendarClockIcon } from "lucide-react"
import { useSettingsStore } from "@/stores/settings"
import { useLatestSuccessfulBackup } from "@/hooks/data/use-backup-history"
import { shouldShowReminder } from "@/lib/data/scheduler"

const DAY_MS = 24 * 60 * 60 * 1000
const noopSubscribe = () => () => {}

export function ReminderBanner() {
  const t = useTranslations("settings.data.backup.reminder")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const latest = useLatestSuccessfulBackup()
  // useSyncExternalStore is the React-sanctioned way to read mutable globals
  // (here, the wall clock) without an effect-driven setState.
  const nowMs = useSyncExternalStore(
    noopSubscribe,
    () => Date.now(),
    () => 0
  )

  const visible = shouldShowReminder({
    reminderDays: settings?.backupReminderDays,
    lastSuccessAt: latest?.completedAt,
    dismissedAt: settings?.backupReminderDismissedAt,
  })
  if (!visible) return null

  const days = latest && nowMs > 0 ? Math.floor((nowMs - latest.completedAt) / DAY_MS) : null

  return (
    <Card className="flex items-start gap-2 border-amber-500/40 bg-amber-50/50 p-3 text-sm dark:bg-amber-500/10">
      <CalendarClockIcon className="mt-0.5 size-4 text-amber-600" />
      <div className="flex-1">
        <p className="font-medium">{t("title")}</p>
        <p className="text-xs text-muted-foreground">
          {days !== null ? t("bodyKnownLast", { days }) : t("bodyNeverBackedUp")}
        </p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 text-xs"
        onClick={() => void save({ backupReminderDismissedAt: Date.now() })}
      >
        {t("dismiss")}
      </Button>
    </Card>
  )
}
