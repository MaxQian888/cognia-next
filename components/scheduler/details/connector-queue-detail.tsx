"use client"

/**
 * Connector outbound-queue rollup detail panel. Aggregates the queue length
 * from Dexie, breaker / rate-limit signals from the connector audit log,
 * and renders a list of recent dispatches.
 */

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { InspectRow } from "./_shared/inspect-row"
import { useUnifiedRecentRuns } from "@/hooks/scheduler/use-unified-recent-runs"
import { getDb } from "@/lib/db/schema"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

export interface ConnectorQueueDetailProps {
  onSelectRun?: (run: UnifiedExecutionRun) => void
}

export function ConnectorQueueDetail({ onSelectRun }: ConnectorQueueDetailProps) {
  const t = useTranslations("scheduler")
  const queueLength = useLiveQuery(() => getDb().outboundQueue.count(), [])
  const breakerSnapshot = useLiveQuery(async () => {
    const recent = await getDb().connectorAudit.orderBy("at").reverse().limit(50).toArray()
    const lastOpen = recent.find((r) => r.kind === "circuit.opened")
    const lastClose = recent.find((r) => r.kind === "circuit.closed")
    return {
      lastOpen: lastOpen ? lastOpen.at : undefined,
      lastClose: lastClose ? lastClose.at : undefined,
    }
  }, [])
  const { runs } = useUnifiedRecentRuns({ filterKind: "connector", limit: 15 })

  const queueText = typeof queueLength === "number" ? String(queueLength) : "…"
  const lastOpenText = breakerSnapshot?.lastOpen
    ? new Date(breakerSnapshot.lastOpen).toLocaleString()
    : "-"
  const lastCloseText = breakerSnapshot?.lastClose
    ? new Date(breakerSnapshot.lastClose).toLocaleString()
    : "-"

  return (
    <div className="p-5 space-y-6">
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          {t("queueStatus") || "Queue status"}
        </h3>
        <div>
          <InspectRow label={t("queueLength") || "Queue length"} value={queueText} />
          <InspectRow
            label={t("breakerLastOpened") || "Breaker last opened"}
            value={lastOpenText}
          />
          <InspectRow
            label={t("breakerLastClosed") || "Breaker last closed"}
            value={lastCloseText}
          />
        </div>
      </section>

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          {t("recentDispatches") || "Recent dispatches"}
        </h3>
        {runs.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("noRecentDispatches") || "No recent dispatches."}
          </p>
        ) : (
          <ul className="space-y-1" data-testid="connector-queue-recent-dispatches">
            {runs.map((run) => (
              <li key={run.unifiedId}>
                <button
                  type="button"
                  onClick={() => onSelectRun?.(run)}
                  className="w-full text-left flex items-center justify-between gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent"
                >
                  <span className="truncate">{run.itemName}</span>
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
