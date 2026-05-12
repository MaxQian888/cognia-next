"use client"

/**
 * Workflow trigger detail panel. Reads the underlying `WorkflowTriggerRow`
 * from Dexie so the page only has to pass the unified item id; lets users
 * inspect the cron + tz, jump to the workflow editor, and review recent
 * fires fed by the unified-runs hook.
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

export interface WorkflowDetailProps {
  workflowTriggerId: string
  onSelectRun?: (run: UnifiedExecutionRun) => void
}

export function WorkflowDetail({ workflowTriggerId, onSelectRun }: WorkflowDetailProps) {
  const t = useTranslations("scheduler")
  const trigger = useLiveQuery(
    () => getDb().workflowTriggers.get(workflowTriggerId),
    [workflowTriggerId]
  )
  const workflow = useLiveQuery(
    async () => (trigger ? getDb().workflows.get(trigger.workflowId) : undefined),
    [trigger?.workflowId]
  )
  const { runs } = useUnifiedRecentRuns({
    filterKind: "workflow",
    filterItemId: trigger ? `workflow:${trigger.workflowId}` : undefined,
    limit: 10,
  })

  if (!trigger) {
    return (
      <div className="p-5 text-sm text-muted-foreground">
        {t("workflowTriggerNotFound") || "Workflow trigger not found."}
      </div>
    )
  }

  const nextRunText = trigger.nextFireAt ? formatNextRun(new Date(trigger.nextFireAt)) : "-"

  return (
    <div className="p-5 space-y-6">
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          {t("configuration") || "Configuration"}
        </h3>
        <div>
          <InspectRow
            label={t("workflow") || "Workflow"}
            value={workflow?.name ?? trigger.workflowId}
          />
          <InspectRow label={t("triggerKind") || "Trigger kind"} value={trigger.kind} />
          <InspectRow label={t("cron") || "Cron"} value={trigger.cron ?? "-"} />
          <InspectRow
            label={t("webhookPath") || "Webhook path"}
            value={trigger.webhookPath ?? "-"}
          />
          <InspectRow
            label={t("enabled") || "Enabled"}
            value={trigger.enabled ? t("yes") || "yes" : t("no") || "no"}
          />
          <InspectRow label={t("nextRun") || "Next run"} value={nextRunText} />
        </div>
        <div className="mt-3">
          <Button size="sm" variant="outline" asChild>
            <Link href={`/workflows/${encodeURIComponent(trigger.workflowId)}`}>
              <ArrowUpRight className="mr-1.5 h-3.5 w-3.5" />
              {t("openInWorkflowEditor") || "Open in workflow editor"}
            </Link>
          </Button>
        </div>
      </section>

      <RecentRunsSection runs={runs} onSelectRun={onSelectRun} />
    </div>
  )
}

function RecentRunsSection({
  runs,
  onSelectRun,
}: {
  runs: UnifiedExecutionRun[]
  onSelectRun?: (run: UnifiedExecutionRun) => void
}) {
  const t = useTranslations("scheduler")
  if (runs.length === 0) {
    return (
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          {t("recentRuns") || "Recent runs"}
        </h3>
        <p className="text-xs text-muted-foreground">{t("noRecentRuns") || "No recent runs."}</p>
      </section>
    )
  }

  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
        {t("recentRuns") || "Recent runs"}
      </h3>
      <ul className="space-y-1" data-testid="workflow-recent-runs">
        {runs.map((run) => (
          <li key={run.unifiedId}>
            <button
              type="button"
              data-testid={`workflow-run-${run.origin.nativeId}`}
              onClick={() => onSelectRun?.(run)}
              className="w-full text-left flex items-center justify-between gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent"
            >
              <span className="truncate">{new Date(run.startedAt).toLocaleString()}</span>
              <span className="shrink-0 text-muted-foreground">{run.status}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
