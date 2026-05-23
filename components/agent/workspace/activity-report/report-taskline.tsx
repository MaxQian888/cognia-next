"use client"

/**
 * Gantt-style swim-lane timeline of delegation segments, one lane per
 * teammate. Segments are matched `delegation_started` → `delegation_completed`
 * / `delegation_failed` checkpoint pairs (by delegationId). Rendered with
 * plain divs (not Recharts) so it stays accessible and test-friendly.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { Card } from "@/components/ui/card"
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type {
  AgentTeammate,
  TeamExecutionCheckpoint,
  TeamExecutionReport,
} from "@/types/agent/agent-team"

export interface ReportTasklineProps {
  report: TeamExecutionReport
  teammates: AgentTeammate[]
}

interface Segment {
  delegationId: string
  teammateId: string
  startMs: number
  endMs: number
  label: string
}

function buildSegments(checkpoints: TeamExecutionCheckpoint[]): Segment[] {
  const starts = new Map<string, TeamExecutionCheckpoint>()
  const segments: Segment[] = []
  for (const cp of checkpoints) {
    if (!cp.delegationId) continue
    if (cp.type === "delegation_started") {
      starts.set(cp.delegationId, cp)
    } else if (cp.type === "delegation_completed" || cp.type === "delegation_failed") {
      const start = starts.get(cp.delegationId)
      if (!start) continue
      starts.delete(cp.delegationId)
      segments.push({
        delegationId: cp.delegationId,
        teammateId: start.teammateId ?? cp.teammateId ?? "unknown",
        startMs: new Date(start.timestamp).getTime(),
        endMs: new Date(cp.timestamp).getTime(),
        label: start.summary || cp.summary,
      })
    }
  }
  return segments
}

export function ReportTaskline({ report, teammates }: ReportTasklineProps) {
  const t = useTranslations("agentTeamsWorkspace.activity.report.taskline")
  const segments = useMemo(() => buildSegments(report.checkpoints), [report.checkpoints])

  const { lanes, minMs, spanMs } = useMemo(() => {
    if (segments.length === 0) return { lanes: [], minMs: 0, spanMs: 1 }
    const min = Math.min(...segments.map((s) => s.startMs))
    const max = Math.max(...segments.map((s) => s.endMs))
    const byTeammate = new Map<string, Segment[]>()
    for (const seg of segments) {
      const arr = byTeammate.get(seg.teammateId) ?? []
      arr.push(seg)
      byTeammate.set(seg.teammateId, arr)
    }
    return {
      lanes: Array.from(byTeammate, ([teammateId, segs]) => ({ teammateId, segs })),
      minMs: min,
      spanMs: Math.max(1, max - min),
    }
  }, [segments])

  const nameOf = (id: string): string => teammates.find((tm) => tm.id === id)?.name ?? id

  return (
    <Card className="space-y-2 p-3" data-testid="report-taskline">
      <p className="text-sm font-medium">{t("title")}</p>
      {segments.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t("empty")}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="space-y-2">
          {lanes.map((lane) => (
            <div key={lane.teammateId} className="space-y-1">
              <p className="text-[10px] font-medium text-muted-foreground">
                {nameOf(lane.teammateId)}
              </p>
              <div className="relative h-5 w-full rounded bg-muted/40">
                {lane.segs.map((seg) => {
                  const left = ((seg.startMs - minMs) / spanMs) * 100
                  const width = Math.max(2, ((seg.endMs - seg.startMs) / spanMs) * 100)
                  return (
                    <Tooltip key={seg.delegationId}>
                      <TooltipTrigger asChild>
                        <div
                          role="img"
                          aria-label={t("tooltip", {
                            title: seg.label,
                            start: new Date(seg.startMs).toLocaleTimeString(),
                            end: new Date(seg.endMs).toLocaleTimeString(),
                          })}
                          className="absolute top-0 h-5 rounded bg-primary/70"
                          style={{ left: `${left}%`, width: `${width}%` }}
                          data-testid={`taskline-segment-${seg.delegationId}`}
                        />
                      </TooltipTrigger>
                      <TooltipContent>{seg.label}</TooltipContent>
                    </Tooltip>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
