"use client"

/**
 * Plugin scheduled-job detail panel. Reads the underlying
 * `PluginScheduledJobRow` directly from Dexie; lets the user inspect cron
 * + args + plugin id and jump to the plugin settings page for full
 * lifecycle management.
 */

import Link from "next/link"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { ArrowUpRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { InspectRow } from "./_shared/inspect-row"
import { useUnifiedRecentRuns } from "@/hooks/scheduler/use-unified-recent-runs"
import { getDb } from "@/lib/db/schema"
import { formatNextRun } from "@/lib/scheduler/format-utils"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

export interface PluginDetailProps {
  jobId: string
  onSelectRun?: (run: UnifiedExecutionRun) => void
}

export function PluginDetail({ jobId, onSelectRun }: PluginDetailProps) {
  const t = useTranslations("scheduler")
  const job = useLiveQuery(() => getDb().pluginScheduledJobs.get(jobId), [jobId])
  const { runs } = useUnifiedRecentRuns({
    filterKind: "plugin",
    filterItemId: `plugin:${jobId}`,
    limit: 10,
  })

  if (!job) {
    return (
      <div className="p-5 text-sm text-muted-foreground">
        {t("pluginJobNotFound") || "Plugin job not found."}
      </div>
    )
  }

  const nextRunText = job.nextRunAt ? formatNextRun(new Date(job.nextRunAt)) : "-"
  const lastRunText = job.lastRunAt ? new Date(job.lastRunAt).toLocaleString() : "-"
  const argsText =
    job.args && Object.keys(job.args).length > 0 ? JSON.stringify(job.args, null, 2) : "-"

  return (
    <div className="p-5 space-y-6">
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          {t("configuration") || "Configuration"}
        </h3>
        <div>
          <InspectRow label={t("plugin") || "Plugin"} value={job.pluginId} />
          <InspectRow label={t("handler") || "Handler"} value={job.handler} />
          <InspectRow label={t("cron") || "Cron"} value={job.cron} />
          <InspectRow label={t("status") || "Status"} value={job.status} />
          <InspectRow label={t("nextRun") || "Next run"} value={nextRunText} />
          <InspectRow label={t("lastRun") || "Last run"} value={lastRunText} />
        </div>
        <pre
          className="mt-3 rounded bg-muted px-3 py-2 text-[11px] font-mono text-muted-foreground overflow-x-auto"
          data-testid="plugin-args-block"
        >
          {argsText}
        </pre>
        <div className="mt-3">
          <Button size="sm" variant="outline" asChild>
            <Link href={`/settings?section=plugins&pluginId=${encodeURIComponent(job.pluginId)}`}>
              <ArrowUpRight className="mr-1.5 h-3.5 w-3.5" />
              {t("openInPluginSettings") || "Open in plugin settings"}
            </Link>
          </Button>
        </div>
      </section>

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          {t("recentRuns") || "Recent runs"}
        </h3>
        {runs.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("noRecentRuns") || "No recent runs."}</p>
        ) : (
          <ul className="space-y-1" data-testid="plugin-recent-runs">
            {runs.map((run) => (
              <li key={run.unifiedId}>
                <button
                  type="button"
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
