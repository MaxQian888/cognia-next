"use client"

/**
 * Cycles and milestones for the mobile (Capacitor) shell: the compact face of
 * `/projects?tab=cycles`.
 *
 * Read-only. Cycle rows are containers, and the phone's write vocabulary
 * (`lib/issues/remote-write.ts`) covers issues, not containers. What a phone
 * can do with a cycle is open the board planned into it, which is what a tap
 * does.
 */

import { useMemo } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"

import { TrackerTabs } from "@/components/issues/tracker-tabs"
import { ListSkeleton } from "@/components/mobile/discover/list-skeleton"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { useDexieFirstQuery } from "@/hooks/data/use-dexie-first-query"
import { listIssueCycles } from "@/lib/db/issue-cycles"
import { listIssues } from "@/lib/db/issues"
import { cycleProgress } from "@/lib/issues/relations"
import { useProjectStore } from "@/stores/project/project-store"
import type { IssueCycle } from "@/types/issues"

export function CyclesMobileBody() {
  const t = useTranslations("issues")
  const workspaceId = useProjectStore((s) => s.activeProjectId)

  const cyclesQuery = useDexieFirstQuery({
    query: () => (workspaceId ? listIssueCycles({ projectId: workspaceId }) : Promise.resolve([])),
    deps: [workspaceId],
    initial: [] as IssueCycle[],
    table: "issueCycles",
  })
  const cycles = cyclesQuery.data ?? []
  const issues = useDexieFirstQuery({
    query: () => (workspaceId ? listIssues({ projectId: workspaceId }) : Promise.resolve([])),
    deps: [workspaceId],
    initial: [] as Awaited<ReturnType<typeof listIssues>>,
    table: "issues",
  }).data

  const progress = useMemo(
    () => new Map(cycles.map((cycle) => [cycle.id, cycleProgress(cycle.id, issues ?? [])] as const)),
    [cycles, issues]
  )
  const dateFormat = useMemo(() => new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }), [])

  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-testid="cycles-mobile-body">
      <header className="safe-area-pt flex flex-col gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <h1 className="text-base font-semibold">{t("cycles.title")}</h1>
          <Badge variant="secondary" className="font-normal">
            {t("cycles.summary", { count: cycles.length })}
          </Badge>
        </div>
        <TrackerTabs active="cycles" compact />
      </header>

      {cycles.length === 0 && cyclesQuery.isSyncing ? (
        <ListSkeleton rows={3} testId="cycles-mobile-skeleton" className="p-4" />
      ) : cycles.length === 0 ? (
        <p
          className="py-16 text-center text-sm text-muted-foreground"
          data-testid="cycles-mobile-empty"
        >
          {t("cycles.empty")}
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {cycles.map((cycle) => {
            const tally = progress.get(cycle.id) ?? { total: 0, done: 0, points: 0, pointsDone: 0 }
            const percent = tally.total === 0 ? 0 : Math.round((tally.done / tally.total) * 100)
            return (
              <li key={cycle.id}>
                <Link
                  href={`/issues?cycle=${encodeURIComponent(cycle.id)}`}
                  className="focus-visible:ring-ring/50 flex flex-col gap-2 border-b px-4 py-3 focus-visible:outline-none focus-visible:ring-[3px]"
                  data-testid={`cycles-mobile-row-${cycle.id}`}
                >
                  <div className="flex items-center gap-2">
                    <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{cycle.name}</h2>
                    <Badge variant="outline" className="font-normal">
                      {t(`cycles.kindLabel.${cycle.kind}`)}
                    </Badge>
                    <Badge variant="secondary" className="font-normal">
                      {t(`cycles.statusLabel.${cycle.status}`)}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    {cycle.startsAt !== undefined || cycle.endsAt !== undefined ? (
                      <span className="tabular-nums" data-testid={`cycles-mobile-dates-${cycle.id}`}>
                        {cycle.startsAt !== undefined ? dateFormat.format(cycle.startsAt) : "…"}
                        {" → "}
                        {cycle.endsAt !== undefined ? dateFormat.format(cycle.endsAt) : "…"}
                      </span>
                    ) : null}
                    <span className="flex-1" />
                    <span data-testid={`cycles-mobile-progress-${cycle.id}`}>
                      {t("cycles.progress", {
                        done: tally.done,
                        total: tally.total,
                        pointsDone: tally.pointsDone,
                        points: tally.points,
                      })}
                    </span>
                  </div>
                  <Progress value={percent} className="h-1.5" aria-label={t("cycles.progressBar")} />
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
