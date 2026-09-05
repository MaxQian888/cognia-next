"use client"

/**
 * `/projects?tab=cycles`: the tracker's third destination.
 *
 * Cycles and milestones used to be reachable only through a dialog behind the
 * issue rail, which meant a planning surface with no URL, no place in the
 * tracker's navigation and nothing to land a deep link on. This page mounts
 * the same `CycleEditorList` the dialog does, under the same header chrome as
 * `/issues` and `/projects`, and links each cycle to the board filtered by it.
 */

import { RotateCwIcon } from "lucide-react"
import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { CycleEditorList } from "@/components/issues/cycles/cycle-editor-list"
import { TrackerTabs } from "@/components/issues/tracker-tabs"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { useClientLiveQuery } from "@/hooks/data"
import { listIssueCycles } from "@/lib/db/issue-cycles"
import { listIssueProjects } from "@/lib/db/issue-projects"
import { listIssues } from "@/lib/db/issues"
import { cycleProgress } from "@/lib/issues/relations"
import { useProjectStore } from "@/stores/project/project-store"
import type { IssueCycle, IssueProject } from "@/types/issues"

export function CycleConsole() {
  const t = useTranslations("issues")
  const workspaceId = useProjectStore((s) => s.activeProjectId)

  const cycles = useClientLiveQuery(
    () => (workspaceId ? listIssueCycles({ projectId: workspaceId }) : Promise.resolve([])),
    [workspaceId],
    [] as IssueCycle[]
  )
  const projects = useClientLiveQuery(
    () => (workspaceId ? listIssueProjects({ projectId: workspaceId }) : Promise.resolve([])),
    [workspaceId],
    [] as IssueProject[]
  )
  const issues = useClientLiveQuery(
    () => (workspaceId ? listIssues({ projectId: workspaceId }) : Promise.resolve([])),
    [workspaceId],
    []
  )

  const progress = useMemo(
    () =>
      new Map(
        (cycles ?? []).map((cycle) => [cycle.id, cycleProgress(cycle.id, issues ?? [])] as const)
      ),
    [cycles, issues]
  )

  return (
    <FeaturePageShell
      storageId="issue-cycles"
      header={
        <FeaturePageHeader
          variant="management"
          icon={<RotateCwIcon />}
          title={t("cycles.title")}
          summary={t("cycles.summary", { count: (cycles ?? []).length })}
          navigation={<TrackerTabs active="cycles" />}
          navigationPlacement="inline"
        />
      }
      centerClassName="overflow-y-auto"
    >
      {workspaceId ? (
        <div className="mx-auto w-full max-w-3xl p-4" data-testid="cycle-console">
          <CycleEditorList
            projectId={workspaceId}
            cycles={cycles ?? []}
            projects={projects ?? []}
            progress={progress}
            linkToBoard
          />
        </div>
      ) : (
        <Empty data-testid="cycle-console-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <RotateCwIcon />
            </EmptyMedia>
            <EmptyTitle>{t("cycles.noWorkspace")}</EmptyTitle>
            <EmptyDescription>{t("cycles.noWorkspaceHint")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </FeaturePageShell>
  )
}
