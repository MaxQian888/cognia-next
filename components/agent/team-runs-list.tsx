"use client"

/**
 * TeamRunsList — live-query view of `workflowRuns` filtered for team runs.
 *
 * Per ADR-0022 §5 PR 5. Team runs now ride workflow runtime; this component
 * subscribes to Dexie via `useLiveQuery` and filters by:
 *   - triggerKind === "trigger.team"
 *   - triggerPayload.teamId === <teamId>
 *
 * Replaces the legacy `store.executionReports` data source. Survives refresh
 * because workflowRuns is the durable Dexie row.
 */

import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { getDb } from "@/lib/db/schema"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

export interface TeamRunsListProps {
  teamId: string
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  running: "default",
  succeeded: "secondary",
  failed: "destructive",
  cancelled: "outline",
  waiting: "outline",
  paused: "outline",
  pending: "outline",
}

export function TeamRunsList({ teamId }: TeamRunsListProps): React.ReactElement {
  const t = useTranslations("agentTeam.runs")
  const runs = useLiveQuery(
    async () => {
      const db = getDb()
      const all = await db.workflowRuns
        .where("triggerKind")
        .equals("trigger.team")
        .reverse()
        .sortBy("startedAt")
      return all.filter((r) => {
        const payload = r.triggerPayload as { teamId?: string } | undefined
        return payload?.teamId === teamId
      })
    },
    [teamId],
    [] as Awaited<ReturnType<typeof getDb>["workflowRuns"]["toArray"]>
  )

  if (!runs || runs.length === 0) {
    return <div className="text-sm text-muted-foreground py-4">{t("empty")}</div>
  }

  return (
    <div className="space-y-2">
      {runs.map((run) => (
        <Card key={run.id}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-sm font-mono">{run.id}</CardTitle>
              <Badge variant={STATUS_VARIANT[run.status] ?? "outline"}>{run.status}</Badge>
            </div>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            <div>
              {t("startedAt")}: {new Date(run.startedAt).toLocaleString()}
            </div>
            {run.completedAt && (
              <div>
                {t("completedAt")}: {new Date(run.completedAt).toLocaleString()}
              </div>
            )}
            {run.error && <div className="text-destructive">{run.error.message}</div>}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
