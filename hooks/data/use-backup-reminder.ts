"use client"

// Convenience hook: returns whether the reminder should be shown right now,
// plus a `dismiss` callback. Pure function under the hood; the hook just
// wires the settings + latest-success rows together.

import { useCallback } from "react"
import { useSettingsStore } from "@/stores/settings"
import { useLatestSuccessfulBackup } from "./use-backup-history"
import { shouldShowReminder } from "@/lib/data/scheduler"

export function useBackupReminder(): { visible: boolean; dismiss: () => void } {
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const latest = useLatestSuccessfulBackup()

  const visible = shouldShowReminder({
    reminderDays: settings?.backupReminderDays,
    lastSuccessAt: latest?.completedAt,
    dismissedAt: settings?.backupReminderDismissedAt,
  })

  const dismiss = useCallback(() => {
    void save({ backupReminderDismissedAt: Date.now() })
  }, [save])

  return { visible, dismiss }
}
