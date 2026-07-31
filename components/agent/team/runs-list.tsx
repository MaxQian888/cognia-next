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
import type { WorkflowRunRow } from "@/types/workflow/visual"
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

/**
 * Whether a `trigger.team` run row is one of THIS team's synthesized runs.
 * Synthesized team runs stamp exactly `{ teamId }`; user workflows started by
 * the "on team finished" fan-out share the trigger kind but carry
 * `event: "team.completed"` — exclude them so the team's run history shows
 * only its own runs. Exported for tests (and reused by the CLI status
 * projection, which must apply the same filter).
 */
export function isSynthesizedTeamRunPayload(payload: unknown, teamId: string): boolean {
  const p = payload as { teamId?: string; event?: string } | undefined
  return p?.teamId === teamId && p?.event === undefined
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
      return all.filter((r) => isSynthesizedTeamRunPayload(r.triggerPayload, teamId))
    },
    [teamId],
    [] as WorkflowRunRow[]
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
