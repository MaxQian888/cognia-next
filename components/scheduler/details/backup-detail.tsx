"use client"

/**
 * Backup auto-schedule detail panel. Reads `appSettings.backupAutoSchedule`
 * for the displayed config and feeds recent rows from `backupHistory`
 * through the unified-runs hook. Editing is delegated to the existing
 * `BackupScheduleDialog` (not reimplemented).
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { InspectRow } from "./_shared/inspect-row"
import { BackupScheduleDialog } from "../backup-schedule-dialog"
import { useUnifiedRecentRuns } from "@/hooks/scheduler/use-unified-recent-runs"
import { getSettings } from "@/lib/db/settings"
import { DEFAULT_BACKUP_AUTO_SCHEDULE, type BackupAutoSchedule } from "@cognia/agent-config-types"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

export interface BackupDetailProps {
  onSelectRun?: (run: UnifiedExecutionRun) => void
}

export function BackupDetail({ onSelectRun }: BackupDetailProps) {
  const t = useTranslations("scheduler")
  const [cfg, setCfg] = useState<BackupAutoSchedule | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    const reload = async () => {
      try {
        const settings = await getSettings()
        if (!cancelled) setCfg(settings.backupAutoSchedule ?? DEFAULT_BACKUP_AUTO_SCHEDULE)
      } catch {
        if (!cancelled) setCfg(DEFAULT_BACKUP_AUTO_SCHEDULE)
      }
    }
    void reload()
    return () => {
      cancelled = true
    }
  }, [])

  const { runs } = useUnifiedRecentRuns({ filterKind: "backup", limit: 10 })

  const resolved = cfg ?? DEFAULT_BACKUP_AUTO_SCHEDULE
  const intervalText = `${resolved.intervalDays} ${t("days") || "days"}`
  const lastRunText = resolved.lastRunAt
    ? new Date(resolved.lastRunAt).toLocaleString()
    : t("never") || "Never"

  return (
    <div className="p-5 space-y-6">
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          {t("configuration") || "Configuration"}
        </h3>
        <div>
          <InspectRow
            label={t("enabled") || "Enabled"}
            value={resolved.enabled ? t("yes") || "yes" : t("no") || "no"}
          />
          <InspectRow label={t("interval") || "Interval"} value={intervalText} />
          <InspectRow label={t("destination") || "Destination"} value={resolved.dirPath ?? "-"} />
          <InspectRow
            label={t("retainCount") || "Retain count"}
            value={String(resolved.retainCount ?? 0)}
          />
          <InspectRow label={t("lastRun") || "Last run"} value={lastRunText} />
        </div>
        <div className="mt-3">
          <BackupScheduleDialog />
        </div>
      </section>

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          {t("recentRuns") || "Recent runs"}
        </h3>
        {runs.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("noRecentRuns") || "No recent runs."}</p>
        ) : (
          <ul className="space-y-1" data-testid="backup-recent-runs">
            {runs.map((run) => (
              <li key={run.unifiedId}>
                <button
                  type="button"
                  data-testid={`backup-run-${run.origin.nativeId}`}
                  onClick={() => onSelectRun?.(run)}
                  className="w-full text-left flex items-center justify-between gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent"
                >
                  <span className="truncate">{new Date(run.startedAt).toLocaleString()}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {t(`unifiedRunStatuses.${run.status}`) || run.status}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
