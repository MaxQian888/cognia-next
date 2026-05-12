"use client"

/**
 * Connector scheduled-digest detail panel. Surfaces the digest task's
 * adapter / conversation / character payload alongside the cron and recent
 * fire history (sourced from connectorAudit through the unified-runs hook).
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { InspectRow } from "./_shared/inspect-row"
import { useUnifiedRecentRuns } from "@/hooks/scheduler/use-unified-recent-runs"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import { formatNextRun } from "@/lib/scheduler/format-utils"
import type { ScheduledTask } from "@/types/scheduler"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

export interface ConnectorDigestDetailProps {
  taskId: string
  onSelectRun?: (run: UnifiedExecutionRun) => void
}

interface DigestPayload {
  adapterId?: string
  conversationKey?: string
  characterId?: string
  prompt?: string
}

export function ConnectorDigestDetail({ taskId, onSelectRun }: ConnectorDigestDetailProps) {
  const t = useTranslations("scheduler")
  const [task, setTask] = useState<ScheduledTask | null>(null)

  useEffect(() => {
    let cancelled = false
    schedulerDb
      .getTask(taskId)
      .then((row) => {
        if (!cancelled) setTask(row)
      })
      .catch(() => {
        if (!cancelled) setTask(null)
      })
    return () => {
      cancelled = true
    }
  }, [taskId])

  const { runs } = useUnifiedRecentRuns({
    filterKind: "connector",
    filterItemId: `connector:${taskId}`,
    limit: 10,
  })

  if (!task) {
    return (
      <div className="p-5 text-sm text-muted-foreground">
        {t("connectorDigestNotFound") || "Connector digest task not found."}
      </div>
    )
  }

  const payload = (task.payload ?? {}) as DigestPayload
  const cronText =
    task.trigger.type === "cron" ? (task.trigger.cronExpression ?? "-") : task.trigger.type
  const nextRunText = task.nextRunAt ? formatNextRun(task.nextRunAt) : "-"

  return (
    <div className="p-5 space-y-6">
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          {t("configuration") || "Configuration"}
        </h3>
        <div>
          <InspectRow label={t("adapter") || "Adapter"} value={payload.adapterId ?? "-"} />
          <InspectRow
            label={t("conversation") || "Conversation"}
            value={payload.conversationKey ?? "-"}
          />
          <InspectRow label={t("character") || "Character"} value={payload.characterId ?? "-"} />
          <InspectRow label={t("cron") || "Cron"} value={cronText} />
          <InspectRow label={t("nextRun") || "Next run"} value={nextRunText} />
        </div>
        {payload.prompt ? (
          <pre
            className="mt-3 rounded bg-muted px-3 py-2 text-[11px] font-mono text-muted-foreground overflow-x-auto whitespace-pre-wrap"
            data-testid="connector-digest-prompt"
          >
            {payload.prompt}
          </pre>
        ) : null}
      </section>

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          {t("recentRuns") || "Recent runs"}
        </h3>
        {runs.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("noRecentRuns") || "No recent runs."}</p>
        ) : (
          <ul className="space-y-1" data-testid="connector-digest-recent-runs">
            {runs.map((run) => (
              <li key={run.unifiedId}>
                <button
                  type="button"
                  onClick={() => onSelectRun?.(run)}
                  className="w-full text-left flex items-center justify-between gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent"
                >
                  <span className="truncate">{new Date(run.startedAt).toLocaleString()}</span>
                  <span className="shrink-0 text-muted-foreground">{run.status}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
